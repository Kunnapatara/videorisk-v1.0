import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  ScanJob,
  EvidenceItem,
  RiskReport,
  ReScanComparison,
  UserAccount,
  SubscriptionRecord,
  WebhookEventRecord,
  AuthSessionRecord,
  ChannelContextProfile,
  PasswordResetRecord,
  JobQueueRecord,
  OperationalMetrics,
  FencingError
} from '../../types';
import {
  IStorageRepository,
  IUserRepository,
  IScanRepository,
  IEvidenceRepository,
  IUsageRepository,
  IUploadRepository,
  IBillingRepository,
  IChannelProfileRepository,
  IPasswordResetRepository,
  IJobQueueRepository,
  LeaseFencingToken,
  UploadRecord
} from './index';

export interface MigrationRecord {
  version: number;
  name: string;
  appliedAt: string;
}

export class SqliteStorageRepository implements IStorageRepository {
  public db: DatabaseSync;
  public dbPath: string;
  private txQueue: Promise<void> = Promise.resolve();
  private static asyncLocalStorage = new AsyncLocalStorage<{ depth: number }>();

  constructor(customPath?: string) {
    if (customPath) {
      this.dbPath = path.resolve(customPath);
    } else if (process.env.DATABASE_PATH) {
      this.dbPath = path.resolve(process.env.DATABASE_PATH);
    } else if (process.env.DATA_DIR) {
      this.dbPath = path.resolve(process.env.DATA_DIR, 'videorisk.db');
    } else {
      this.dbPath = path.resolve(process.cwd(), 'data', 'videorisk.db');
    }

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.initPragmas();
    this.runMigrations();
    this.seedDefaultUsersIfNeeded();
  }

  private initPragmas() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }

  public async runTransaction<T>(operation: (context: any) => T | Promise<T>): Promise<T> {
    const parentTx = SqliteStorageRepository.asyncLocalStorage.getStore();

    const mutatedUsers = new Map<string, any>();
    const usersProxy = new Proxy({}, {
      get: (_target, prop: string) => {
        if (typeof prop !== 'string') return undefined;
        if (mutatedUsers.has(prop)) return mutatedUsers.get(prop);
        const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(prop) as any;
        if (!row) return undefined;
        const u = this.mapUser(row);
        mutatedUsers.set(prop, u);
        return u;
      },
      set: (_target, prop: string, value: any) => {
        mutatedUsers.set(prop, value);
        return true;
      }
    });

    const webhookProxy = new Proxy({}, {
      get: (_target, prop: string) => {
        if (typeof prop !== 'string') return undefined;
        const row = this.db.prepare('SELECT payload_json FROM webhook_events WHERE event_id = ?').get(prop) as any;
        if (!row) return undefined;
        try { return JSON.parse(row.payload_json); } catch { return { eventId: prop }; }
      },
      set: (_target, prop: string, val: any) => {
        this.db.prepare(`
          INSERT INTO webhook_events (event_id, provider, event_type, payload_json, processed_at, user_id, credits_granted, plan_granted)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET payload_json = excluded.payload_json
        `).run(
          prop,
          val.provider || 'stripe',
          val.eventType || 'unknown',
          JSON.stringify(val),
          val.processedAt || new Date().toISOString(),
          val.userId || null,
          val.creditsGranted || null,
          val.planGranted || null
        );
        return true;
      }
    });

    const subscriptionsProxy = new Proxy({}, {
      get: (_target, prop: string) => {
        if (typeof prop !== 'string') return undefined;
        const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(prop) as any;
        if (!row) return undefined;
        return {
          id: row.id,
          userId: row.user_id,
          planId: row.plan_id,
          status: row.status,
          currentPeriodEnd: row.current_period_end || undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      },
      set: (_target, prop: string, sub: any) => {
        this.db.prepare(`
          INSERT INTO subscriptions (id, user_id, plan_id, status, current_period_end, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET 
            plan_id = excluded.plan_id,
            status = excluded.status,
            current_period_end = excluded.current_period_end,
            updated_at = excluded.updated_at
        `).run(prop, sub.userId, sub.planId, sub.status, sub.currentPeriodEnd || null, sub.createdAt || new Date().toISOString(), sub.updatedAt || new Date().toISOString());
        return true;
      }
    });

    const txContext: any = this.db;
    txContext.users = usersProxy;
    txContext.webhookEvents = webhookProxy;
    txContext.subscriptions = subscriptionsProxy;

    const flushMutations = () => {
      for (const [userId, user] of mutatedUsers.entries()) {
        this.db.prepare(`
          UPDATE users 
          SET email = ?,
              plan = ?,
              credits_remaining = ?,
              credits_used_total = ?,
              total_scans_count = ?,
              password_hash = ?,
              salt = ?,
              free_trial_claimed = ?,
              stripe_customer_id = ?,
              subscription_id = ?,
              subscription_status = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          user.email,
          user.plan,
          user.creditsRemaining,
          user.creditsUsedTotal,
          user.totalScansCount,
          user.passwordHash || null,
          user.salt || null,
          user.freeTrialClaimed ? 1 : 0,
          user.stripeCustomerId || null,
          user.subscriptionId || null,
          user.subscriptionStatus || null,
          new Date().toISOString(),
          userId
        );
      }
    };

    if (!parentTx) {
      // Top-level transaction: serialize top-level transactions on this single SQLite connection
      let releaseLock!: () => void;
      const nextLock = new Promise<void>(r => { releaseLock = r; });
      const currentQueue = this.txQueue;
      this.txQueue = currentQueue.then(() => nextLock);
      await currentQueue;

      try {
        return await SqliteStorageRepository.asyncLocalStorage.run({ depth: 1 }, async () => {
          this.db.exec('BEGIN IMMEDIATE;');
          try {
            const result = await operation(txContext);
            flushMutations();
            this.db.exec('COMMIT;');
            return result;
          } catch (err) {
            this.db.exec('ROLLBACK;');
            throw err;
          }
        });
      } finally {
        releaseLock();
      }
    } else {
      // Nested transaction within the same async context: use SQLite savepoint
      const savepointName = `sp_${parentTx.depth}`;
      parentTx.depth++;
      this.db.exec(`SAVEPOINT ${savepointName};`);
      try {
        const result = await operation(txContext);
        flushMutations();
        this.db.exec(`RELEASE ${savepointName};`);
        parentTx.depth--;
        return result;
      } catch (err) {
        this.db.exec(`ROLLBACK TO ${savepointName}; RELEASE ${savepointName};`);
        parentTx.depth--;
        throw err;
      }
    }
  }

  private runMigrations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const applied = this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
    const appliedVersions = new Set(applied.map(m => m.version));

    // Migration 1: Full production relational schema
    if (!appliedVersions.has(1)) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            plan TEXT NOT NULL DEFAULT 'free',
            credits_remaining INTEGER NOT NULL DEFAULT 10,
            credits_used_total INTEGER NOT NULL DEFAULT 0,
            total_scans_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            password_hash TEXT,
            salt TEXT,
            free_trial_claimed INTEGER NOT NULL DEFAULT 0,
            stripe_customer_id TEXT,
            subscription_id TEXT,
            subscription_status TEXT,
            updated_at TEXT
          );

          CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS password_resets (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL,
            used_at TEXT,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS rate_limits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL,
            action TEXT NOT NULL,
            timestamp INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_rate_limits ON rate_limits(key, action, timestamp);

          CREATE TABLE IF NOT EXISTS uploads (
            file_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            filename TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            type TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS channel_profiles (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            data_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS scans (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            video_title TEXT NOT NULL,
            video_description TEXT,
            video_tags_json TEXT,
            video_filename TEXT NOT NULL,
            video_path TEXT NOT NULL,
            thumbnail_path TEXT,
            thumbnail_filename TEXT,
            thumbnail_metadata_json TEXT,
            proxy_path TEXT,
            scan_mode TEXT NOT NULL,
            status TEXT NOT NULL,
            current_stage TEXT NOT NULL,
            completed_stages_json TEXT NOT NULL,
            credits_used INTEGER NOT NULL DEFAULT 0,
            credits_deducted INTEGER NOT NULL DEFAULT 0,
            credits_refunded INTEGER NOT NULL DEFAULT 0,
            credits_refunded_amount INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT,
            benchmark_metrics_json TEXT,
            error TEXT,
            parent_scan_id TEXT,
            is_rescan INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            completed_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_scans_user ON scans(user_id);

          CREATE TABLE IF NOT EXISTS job_queue (
            id TEXT PRIMARY KEY,
            scan_id TEXT UNIQUE NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'QUEUED',
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 3,
            run_at TEXT NOT NULL,
            locked_at TEXT,
            locked_by TEXT,
            lease_token TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status, run_at);

          CREATE TABLE IF NOT EXISTS reports (
            scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
            data_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS evidence (
            id TEXT PRIMARY KEY,
            scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
            data_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_evidence_scan ON evidence(scan_id);

          CREATE TABLE IF NOT EXISTS comparisons (
            revised_scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
            original_scan_id TEXT NOT NULL,
            data_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS usage_ledger (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            scan_id TEXT NOT NULL,
            duration_minutes REAL NOT NULL,
            credits_deducted INTEGER NOT NULL,
            mode TEXT NOT NULL,
            timestamp TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_ledger(user_id);

          CREATE TABLE IF NOT EXISTS webhook_events (
            event_id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            processed_at TEXT NOT NULL,
            user_id TEXT,
            credits_granted INTEGER,
            plan_granted TEXT
          );

          CREATE TABLE IF NOT EXISTS subscriptions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            plan_id TEXT NOT NULL,
            status TEXT NOT NULL,
            current_period_end TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (1, '001_initial_relational_schema', datetime('now'));
        `);
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw new Error(`Failed to apply migration 1: ${err}`);
      }
    }

    // Migration 2: Lease fencing token for durable job queue
    if (!appliedVersions.has(2)) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        const columns = this.db.prepare("PRAGMA table_info(job_queue)").all() as Array<{ name: string }>;
        const hasLeaseToken = columns.some(c => c.name === 'lease_token');
        if (!hasLeaseToken) {
          this.db.exec('ALTER TABLE job_queue ADD COLUMN lease_token TEXT;');
        }
        this.db.exec(`
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (2, '002_job_queue_lease_fencing', datetime('now'));
        `);
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw new Error(`Failed to apply migration 2: ${err}`);
      }
    }

    // Migration 3: Lease expiration boundary & durable usage ledger idempotency
    if (!appliedVersions.has(3)) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        const jqCols = this.db.prepare("PRAGMA table_info(job_queue)").all() as Array<{ name: string }>;
        if (!jqCols.some(c => c.name === 'lease_expires_at')) {
          this.db.exec('ALTER TABLE job_queue ADD COLUMN lease_expires_at TEXT;');
        }
        if (!jqCols.some(c => c.name === 'lease_duration_ms')) {
          this.db.exec('ALTER TABLE job_queue ADD COLUMN lease_duration_ms INTEGER DEFAULT 60000;');
        }
        this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_ledger_scan_id ON usage_ledger(scan_id);');
        this.db.exec(`
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (3, '003_lease_expiry_and_usage_idempotency', datetime('now'));
        `);
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw new Error(`Failed to apply migration 3: ${err}`);
      }
    }
  }

  private seedDefaultUsersIfNeeded() {
    if (process.env.NODE_ENV === 'production') return;

    const count = (this.db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
    if (count > 0) return;

    const seedUser = (id: string, email: string, plan: 'creator' | 'pro' | 'free', credits: number, pass: string) => {
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync(pass, salt, 64).toString('hex');
      this.db.prepare(`
        INSERT OR IGNORE INTO users (id, email, plan, credits_remaining, credits_used_total, total_scans_count, created_at, password_hash, salt, free_trial_claimed)
        VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, 1)
      `).run(id, email, plan, credits, new Date().toISOString(), passwordHash, salt);
    };

    seedUser('user_default', 'creator@videorisk.com', 'creator', 30, 'creator123');
    seedUser('user_pro', 'pro@videorisk.com', 'pro', 75, 'pro123');
    seedUser('user_free', 'free@videorisk.com', 'free', 10, 'free123');
  }

  public async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // Ignored if already closed
    }
  }

  // -------------------------------------------------------------
  // USERS REPOSITORY
  // -------------------------------------------------------------
  public users: IUserRepository = {
    getUser: async (id: string): Promise<UserAccount | null> => {
      const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
      if (!row) return null;
      return this.mapUser(row);
    },

    getUserByEmail: async (email: string): Promise<UserAccount | null> => {
      const row = this.db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email) as any;
      if (!row) return null;
      return this.mapUser(row);
    },

    listUsers: async (): Promise<UserAccount[]> => {
      const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as any[];
      return rows.map(r => this.mapUser(r));
    },

    createUser: async (
      email: string,
      passwordHash?: string,
      salt?: string,
      initialCredits: number = 10,
      initialPlan: 'free' | 'creator' | 'pro' | 'agency' = 'free'
    ): Promise<UserAccount> => {
      const id = `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const now = new Date().toISOString();
      const freeTrialClaimed = initialPlan === 'free' ? 1 : 1;

      this.db.prepare(`
        INSERT INTO users (id, email, plan, credits_remaining, credits_used_total, total_scans_count, created_at, password_hash, salt, free_trial_claimed)
        VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
      `).run(id, email.toLowerCase(), initialPlan, initialCredits, now, passwordHash || null, salt || null, freeTrialClaimed);

      return (await this.users.getUser(id))!;
    },

    getOrCreateDefaultUser: async (): Promise<UserAccount> => {
      const existing = await this.users.getUser('user_default');
      if (existing) return existing;
      const all = await this.users.listUsers();
      if (all.length > 0) return all[0];
      return this.users.createUser('creator@videorisk.com', undefined, undefined, 30, 'creator');
    },

    deductCredits: async (userId: string, amount: number): Promise<boolean> => {
      if (amount <= 0) return true;
      let success = false;
      await this.runTransaction(db => {
        const user = db.prepare('SELECT credits_remaining, credits_used_total FROM users WHERE id = ?').get(userId) as any;
        if (!user || user.credits_remaining < amount) {
          success = false;
          return;
        }
        db.prepare(`
          UPDATE users 
          SET credits_remaining = credits_remaining - ?,
              credits_used_total = credits_used_total + ?,
              updated_at = ?
          WHERE id = ?
        `).run(amount, amount, new Date().toISOString(), userId);
        success = true;
      });
      return success;
    },

    addCredits: async (userId: string, amount: number): Promise<UserAccount> => {
      this.db.prepare(`
        UPDATE users 
        SET credits_remaining = credits_remaining + ?,
            updated_at = ?
        WHERE id = ?
      `).run(amount, new Date().toISOString(), userId);
      return (await this.users.getUser(userId))!;
    },

    updatePlan: async (userId: string, plan: 'free' | 'creator' | 'pro' | 'agency', credits: number): Promise<UserAccount> => {
      this.db.prepare(`
        UPDATE users 
        SET plan = ?,
            credits_remaining = ?,
            updated_at = ?
        WHERE id = ?
      `).run(plan, credits, new Date().toISOString(), userId);
      return (await this.users.getUser(userId))!;
    },

    claimFreeTrial: async (userId: string): Promise<{ user: UserAccount; alreadyClaimed: boolean }> => {
      let alreadyClaimed = false;
      await this.runTransaction(db => {
        const user = db.prepare('SELECT free_trial_claimed, credits_remaining FROM users WHERE id = ?').get(userId) as any;
        if (!user) {
          throw new Error('User not found');
        }
        if (user.free_trial_claimed === 1) {
          alreadyClaimed = true;
          return;
        }
        db.prepare(`
          UPDATE users 
          SET free_trial_claimed = 1,
              credits_remaining = credits_remaining + 10,
              updated_at = ?
          WHERE id = ? AND free_trial_claimed = 0
        `).run(new Date().toISOString(), userId);
        alreadyClaimed = false;
      });

      const updated = (await this.users.getUser(userId))!;
      return { user: updated, alreadyClaimed };
    },

    updateUser: async (userId: string, updates: Partial<UserAccount>): Promise<UserAccount | null> => {
      const existing = await this.users.getUser(userId);
      if (!existing) return null;

      const fields: string[] = [];
      const values: any[] = [];

      if (updates.email !== undefined) { fields.push('email = ?'); values.push(updates.email.toLowerCase()); }
      if (updates.plan !== undefined) { fields.push('plan = ?'); values.push(updates.plan); }
      if (updates.creditsRemaining !== undefined) { fields.push('credits_remaining = ?'); values.push(updates.creditsRemaining); }
      if (updates.creditsUsedTotal !== undefined) { fields.push('credits_used_total = ?'); values.push(updates.creditsUsedTotal); }
      if (updates.totalScansCount !== undefined) { fields.push('total_scans_count = ?'); values.push(updates.totalScansCount); }
      if (updates.passwordHash !== undefined) { fields.push('password_hash = ?'); values.push(updates.passwordHash); }
      if (updates.salt !== undefined) { fields.push('salt = ?'); values.push(updates.salt); }
      if (updates.freeTrialClaimed !== undefined) { fields.push('free_trial_claimed = ?'); values.push(updates.freeTrialClaimed ? 1 : 0); }
      if (updates.stripeCustomerId !== undefined) { fields.push('stripe_customer_id = ?'); values.push(updates.stripeCustomerId); }
      if (updates.subscriptionId !== undefined) { fields.push('subscription_id = ?'); values.push(updates.subscriptionId); }
      if (updates.subscriptionStatus !== undefined) { fields.push('subscription_status = ?'); values.push(updates.subscriptionStatus); }

      fields.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(userId);

      this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      return (await this.users.getUser(userId))!;
    },

    createSession: async (userId: string): Promise<string> => {
      const token = `sess_${crypto.randomBytes(32).toString('hex')}`;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare(`
        INSERT INTO sessions (token, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(token, userId, now.toISOString(), expiresAt);
      return token;
    },

    getUserBySession: async (token: string): Promise<UserAccount | null> => {
      const row = this.db.prepare(`
        SELECT u.*, s.expires_at 
        FROM sessions s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.token = ?
      `).get(token) as any;

      if (!row) return null;
      if (new Date(row.expires_at) < new Date()) {
        await this.users.deleteSession(token);
        return null;
      }
      return this.mapUser(row);
    },

    deleteSession: async (token: string): Promise<void> => {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
  };

  private mapUser(row: any): UserAccount {
    return {
      id: row.id,
      email: row.email,
      plan: row.plan,
      creditsRemaining: Number(row.credits_remaining),
      creditsUsedTotal: Number(row.credits_used_total),
      totalScansCount: Number(row.total_scans_count),
      createdAt: row.created_at,
      stripeCustomerId: row.stripe_customer_id || undefined,
      subscriptionId: row.subscription_id || undefined,
      subscriptionStatus: row.subscription_status || undefined,
      passwordHash: row.password_hash || undefined,
      salt: row.salt || undefined,
      freeTrialClaimed: Boolean(row.free_trial_claimed)
    };
  }

  // -------------------------------------------------------------
  // PASSWORD RECOVERY REPOSITORY
  // -------------------------------------------------------------
  public passwordReset: IPasswordResetRepository = {
    createResetToken: async (userId: string, tokenHash: string, expiresAt: string): Promise<void> => {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO password_resets (token_hash, user_id, expires_at, used_at, created_at)
        VALUES (?, ?, ?, NULL, ?)
      `).run(tokenHash, userId, expiresAt, now);
    },

    getResetToken: async (tokenHash: string): Promise<PasswordResetRecord | null> => {
      const row = this.db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(tokenHash) as any;
      if (!row) return null;
      return {
        tokenHash: row.token_hash,
        userId: row.user_id,
        expiresAt: row.expires_at,
        usedAt: row.used_at || null,
        createdAt: row.created_at
      };
    },

    markTokenUsed: async (tokenHash: string): Promise<boolean> => {
      const res = this.db.prepare(`
        UPDATE password_resets 
        SET used_at = ? 
        WHERE token_hash = ? AND used_at IS NULL
      `).run(new Date().toISOString(), tokenHash);
      return res.changes > 0;
    },

    revokeAllUserSessions: async (userId: string): Promise<void> => {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    },

    checkRateLimit: async (key: string, action: string, limit: number, windowSeconds: number): Promise<boolean> => {
      const now = Math.floor(Date.now() / 1000);
      const windowStart = now - windowSeconds;

      // Clean old entries
      this.db.prepare('DELETE FROM rate_limits WHERE timestamp < ?').run(windowStart);

      const count = (this.db.prepare(`
        SELECT COUNT(*) as count 
        FROM rate_limits 
        WHERE key = ? AND action = ? AND timestamp >= ?
      `).get(key, action, windowStart) as any).count;

      if (count >= limit) {
        return false; // Rate limit exceeded
      }

      this.db.prepare(`
        INSERT INTO rate_limits (key, action, timestamp)
        VALUES (?, ?, ?)
      `).run(key, action, now);
      return true; // Allowed
    }
  };

  private validateLeaseFence(db: any, scanId: string, leaseToken?: LeaseFencingToken): void {
    if (typeof leaseToken === 'object' && leaseToken !== null && 'systemBypass' in leaseToken && leaseToken.systemBypass === true) {
      return; // Legitimate explicit system/administrative operation
    }
    if (!leaseToken || typeof leaseToken !== 'string' || leaseToken.trim() === '') {
      throw new FencingError(`Fencing violation for scan ${scanId}: worker lease token is required`);
    }
    const job = db.prepare('SELECT status, locked_by, lease_token, locked_at, lease_expires_at, lease_duration_ms FROM job_queue WHERE scan_id = ?').get(scanId) as any;
    if (!job) {
      throw new FencingError(`Fencing violation for scan ${scanId}: no job queue record found`);
    }
    if (job.status !== 'RUNNING') {
      throw new FencingError(`Fencing violation for scan ${scanId}: job is not in RUNNING state (current: ${job.status})`);
    }
    if (job.lease_token !== leaseToken) {
      throw new FencingError(`Fencing violation for scan ${scanId}: worker lease token is invalid or superseded`);
    }
    const nowIso = new Date().toISOString();
    if (job.lease_expires_at) {
      if (job.lease_expires_at <= nowIso) {
        throw new FencingError(`Fencing violation for scan ${scanId}: worker lease expired at ${job.lease_expires_at}`);
      }
    } else if (job.locked_at) {
      const lockedTime = new Date(job.locked_at).getTime();
      const duration = job.lease_duration_ms ? Number(job.lease_duration_ms) : 60000;
      if (lockedTime + duration <= Date.now()) {
        throw new FencingError(`Fencing violation for scan ${scanId}: worker lease expired by locked_at threshold`);
      }
    }
  }

  // -------------------------------------------------------------
  // SCANS REPOSITORY
  // -------------------------------------------------------------
  public scans: IScanRepository = {
    createScan: async (scan: ScanJob): Promise<ScanJob> => {
      this.db.prepare(`
        INSERT INTO scans (
          id, user_id, video_title, video_description, video_tags_json, video_filename, video_path,
          thumbnail_path, thumbnail_filename, thumbnail_metadata_json, proxy_path, scan_mode,
          status, current_stage, completed_stages_json, credits_used, credits_deducted,
          credits_refunded, credits_refunded_amount, metadata_json, benchmark_metrics_json,
          error, parent_scan_id, is_rescan, created_at, completed_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `).run(
        scan.id,
        scan.userId,
        scan.videoTitle,
        scan.videoDescription || null,
        scan.videoTags ? JSON.stringify(scan.videoTags) : null,
        scan.videoFilename,
        scan.videoPath,
        scan.thumbnailPath || null,
        scan.thumbnailFilename || null,
        scan.thumbnailMetadata ? JSON.stringify(scan.thumbnailMetadata) : null,
        scan.proxyPath || null,
        scan.scanMode,
        scan.status,
        scan.currentStage,
        JSON.stringify(scan.completedStages),
        scan.creditsUsed,
        scan.creditsDeducted || 0,
        scan.creditsRefunded ? 1 : 0,
        scan.creditsRefundedAmount || 0,
        scan.metadata ? JSON.stringify(scan.metadata) : null,
        null,
        scan.error || null,
        scan.parentScanId || null,
        scan.isRescan ? 1 : 0,
        scan.createdAt,
        scan.completedAt || null
      );

      // Increment user total scans count
      this.db.prepare('UPDATE users SET total_scans_count = total_scans_count + 1 WHERE id = ?').run(scan.userId);

      // Enqueue job for durable processing
      if (scan.status === 'COMPLETED') {
        const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const now = new Date().toISOString();
        this.db.prepare(`
          INSERT INTO job_queue (id, scan_id, status, attempts, max_attempts, run_at, created_at, updated_at)
          VALUES (?, ?, 'COMPLETED', 0, 3, ?, ?, ?)
          ON CONFLICT(scan_id) DO NOTHING
        `).run(id, scan.id, now, now, now);
      } else {
        await this.queue.enqueueJob(scan.id);
      }

      return scan;
    },

    getScan: async (id: string): Promise<ScanJob | null> => {
      const row = this.db.prepare('SELECT * FROM scans WHERE id = ?').get(id) as any;
      if (!row) return null;
      return this.mapScan(row);
    },

    getAllScans: async (userId?: string): Promise<ScanJob[]> => {
      let rows: any[];
      if (userId) {
        rows = this.db.prepare('SELECT * FROM scans WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[];
      } else {
        rows = this.db.prepare('SELECT * FROM scans ORDER BY created_at DESC').all() as any[];
      }
      return rows.map(r => this.mapScan(r));
    },

    updateScan: async (id: string, updates: Partial<ScanJob>, leaseToken?: LeaseFencingToken): Promise<ScanJob | null> => {
      return await this.runTransaction(async db => {
        this.validateLeaseFence(db, id, leaseToken);

        const existing = await this.scans.getScan(id);
        if (!existing) return null;

        const fields: string[] = [];
        const values: any[] = [];

        if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
        if (updates.currentStage !== undefined) { fields.push('current_stage = ?'); values.push(updates.currentStage); }
        if (updates.completedStages !== undefined) { fields.push('completed_stages_json = ?'); values.push(JSON.stringify(updates.completedStages)); }
        if (updates.creditsUsed !== undefined) { fields.push('credits_used = ?'); values.push(updates.creditsUsed); }
        if (updates.creditsDeducted !== undefined) { fields.push('credits_deducted = ?'); values.push(updates.creditsDeducted); }
        if (updates.creditsRefunded !== undefined) { fields.push('credits_refunded = ?'); values.push(updates.creditsRefunded ? 1 : 0); }
        if (updates.creditsRefundedAmount !== undefined) { fields.push('credits_refunded_amount = ?'); values.push(updates.creditsRefundedAmount); }
        if (updates.metadata !== undefined) { fields.push('metadata_json = ?'); values.push(JSON.stringify(updates.metadata)); }
        if (updates.videoPath !== undefined) { fields.push('video_path = ?'); values.push(updates.videoPath); }
        if (updates.thumbnailPath !== undefined) { fields.push('thumbnail_path = ?'); values.push(updates.thumbnailPath); }
        if (updates.proxyPath !== undefined) { fields.push('proxy_path = ?'); values.push(updates.proxyPath); }
        if (updates.thumbnailMetadata !== undefined) { fields.push('thumbnail_metadata_json = ?'); values.push(JSON.stringify(updates.thumbnailMetadata)); }
        if (updates.error !== undefined) { fields.push('error = ?'); values.push(updates.error); }
        if (updates.completedAt !== undefined) { fields.push('completed_at = ?'); values.push(updates.completedAt); }

        if (fields.length > 0) {
          values.push(id);
          db.prepare(`UPDATE scans SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        }

        return (await this.scans.getScan(id))!;
      });
    },

    saveReport: async (scanId: string, report: RiskReport, leaseToken?: LeaseFencingToken): Promise<void> => {
      await this.runTransaction(db => {
        this.validateLeaseFence(db, scanId, leaseToken);
        db.prepare(`
          INSERT INTO reports (scan_id, data_json, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT(scan_id) DO UPDATE SET data_json = excluded.data_json
        `).run(scanId, JSON.stringify(report), new Date().toISOString());
      });
    },

    getReport: async (scanId: string): Promise<RiskReport | null> => {
      const row = this.db.prepare('SELECT data_json FROM reports WHERE scan_id = ?').get(scanId) as any;
      if (!row) return null;
      return JSON.parse(row.data_json);
    },

    saveComparison: async (comparison: ReScanComparison, leaseToken?: LeaseFencingToken): Promise<void> => {
      await this.runTransaction(db => {
        this.validateLeaseFence(db, comparison.revisedScanId, leaseToken);
        db.prepare(`
          INSERT INTO comparisons (revised_scan_id, original_scan_id, data_json, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(revised_scan_id) DO UPDATE SET data_json = excluded.data_json
        `).run(comparison.revisedScanId, comparison.originalScanId, JSON.stringify(comparison), new Date().toISOString());
      });
    },

    getComparison: async (revisedScanId: string): Promise<ReScanComparison | null> => {
      const row = this.db.prepare('SELECT data_json FROM comparisons WHERE revised_scan_id = ?').get(revisedScanId) as any;
      if (!row) return null;
      return JSON.parse(row.data_json);
    },

    deductScanCredits: async (scanId: string, userId: string, amount: number, leaseToken?: LeaseFencingToken): Promise<boolean> => {
      let success = false;
      await this.runTransaction(db => {
        this.validateLeaseFence(db, scanId, leaseToken);

        const scan = db.prepare('SELECT credits_deducted FROM scans WHERE id = ?').get(scanId) as any;
        if (!scan) return;
        if (Number(scan.credits_deducted) > 0) {
          // Idempotent: already deducted for this scan
          success = true;
          return;
        }

        const user = db.prepare('SELECT credits_remaining, credits_used_total FROM users WHERE id = ?').get(userId) as any;
        if (!user || user.credits_remaining < amount) {
          success = false;
          return;
        }

        db.prepare(`
          UPDATE users 
          SET credits_remaining = credits_remaining - ?,
              credits_used_total = credits_used_total + ?,
              updated_at = ?
          WHERE id = ?
        `).run(amount, amount, new Date().toISOString(), userId);

        db.prepare(`
          UPDATE scans 
          SET credits_deducted = ?,
              credits_used = ?,
              credits_refunded = 0,
              credits_refunded_amount = 0
          WHERE id = ?
        `).run(amount, amount, scanId);

        success = true;
      });
      return success;
    },

    refundScanCredits: async (scanId: string, hintAmount?: number, leaseToken?: LeaseFencingToken): Promise<{ refunded: boolean; amount: number }> => {
      let result = { refunded: false, amount: 0 };
      await this.runTransaction(db => {
        this.validateLeaseFence(db, scanId, leaseToken);

        const scan = db.prepare('SELECT user_id, credits_deducted, credits_used, credits_refunded FROM scans WHERE id = ?').get(scanId) as any;
        if (!scan) return;

        if (scan.credits_refunded === 1) {
          result = { refunded: false, amount: 0 };
          return;
        }

        const toRefund = Number(scan.credits_deducted) > 0 ? Number(scan.credits_deducted) : (hintAmount && hintAmount > 0 ? hintAmount : 0);
        if (toRefund <= 0) {
          result = { refunded: false, amount: 0 };
          return;
        }

        db.prepare(`
          UPDATE users 
          SET credits_remaining = credits_remaining + ?,
              credits_used_total = MAX(0, credits_used_total - ?),
              updated_at = ?
          WHERE id = ?
        `).run(toRefund, toRefund, new Date().toISOString(), scan.user_id);

        db.prepare(`
          UPDATE scans 
          SET credits_refunded = 1,
              credits_refunded_amount = ?,
              credits_used = 0
          WHERE id = ?
        `).run(toRefund, scanId);

        result = { refunded: true, amount: toRefund };
      });
      return result;
    },

    deleteScan: async (id: string): Promise<boolean> => {
      const res = this.db.prepare('DELETE FROM scans WHERE id = ?').run(id);
      return Number(res.changes) > 0;
    },

    isMediaShared: async (filePath: string, excludeScanId: string): Promise<boolean> => {
      if (!filePath) return false;
      const resolved = path.resolve(filePath);
      const row = this.db.prepare(`
        SELECT id FROM scans 
        WHERE id != ? 
          AND (video_path = ? OR video_path = ? OR proxy_path = ? OR proxy_path = ? OR thumbnail_path = ? OR thumbnail_path = ?)
        LIMIT 1
      `).get(excludeScanId, filePath, resolved, filePath, resolved, filePath, resolved);
      return !!row;
    }
  };

  private mapScan(row: any): ScanJob {
    return {
      id: row.id,
      userId: row.user_id,
      videoTitle: row.video_title,
      videoDescription: row.video_description || undefined,
      videoTags: row.video_tags_json ? JSON.parse(row.video_tags_json) : undefined,
      videoFilename: row.video_filename,
      videoPath: row.video_path,
      thumbnailPath: row.thumbnail_path || undefined,
      thumbnailFilename: row.thumbnail_filename || undefined,
      thumbnailMetadata: row.thumbnail_metadata_json ? JSON.parse(row.thumbnail_metadata_json) : undefined,
      proxyPath: row.proxy_path || undefined,
      scanMode: row.scan_mode,
      status: row.status,
      currentStage: row.current_stage,
      completedStages: JSON.parse(row.completed_stages_json),
      creditsUsed: Number(row.credits_used),
      creditsDeducted: Number(row.credits_deducted),
      creditsRefunded: Boolean(row.credits_refunded),
      creditsRefundedAmount: Number(row.credits_refunded_amount),
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
      completedAt: row.completed_at || undefined,
      error: row.error || undefined,
      parentScanId: row.parent_scan_id || undefined,
      isRescan: Boolean(row.is_rescan)
    };
  }

  // -------------------------------------------------------------
  // DURABLE QUEUE REPOSITORY
  // -------------------------------------------------------------
  public queue: IJobQueueRepository = {
    enqueueJob: async (scanId: string, runAt?: string): Promise<JobQueueRecord> => {
      const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const now = new Date().toISOString();
      const targetRunAt = runAt || now;

      // Idempotent: repeated enqueue calls MUST NOT reset RUNNING or terminal jobs to QUEUED
      this.db.prepare(`
        INSERT INTO job_queue (id, scan_id, status, attempts, max_attempts, run_at, created_at, updated_at)
        VALUES (?, ?, 'QUEUED', 0, 3, ?, ?, ?)
        ON CONFLICT(scan_id) DO NOTHING
      `).run(id, scanId, targetRunAt, now, now);

      return (await this.queue.getJobByScanId(scanId))!;
    },

    claimNextJob: async (workerId: string, leaseDurationMs: number = 60000): Promise<JobQueueRecord | null> => {
      let claimed: JobQueueRecord | null = null;
      await this.runTransaction(db => {
        const now = new Date();
        const nowIso = now.toISOString();
        const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();

        // Find next eligible job: either QUEUED and run_at <= now, or RETRYABLE and run_at <= now
        const eligible = db.prepare(`
          SELECT * FROM job_queue 
          WHERE (status = 'QUEUED' OR status = 'RETRYABLE') 
            AND run_at <= ?
          ORDER BY run_at ASC, created_at ASC 
          LIMIT 1
        `).get(nowIso) as any;

        if (!eligible) return;

        const leaseToken = `lease_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

        const res = db.prepare(`
          UPDATE job_queue 
          SET status = 'RUNNING',
              attempts = attempts + 1,
              locked_at = ?,
              locked_by = ?,
              lease_token = ?,
              lease_expires_at = ?,
              lease_duration_ms = ?,
              updated_at = ?
          WHERE id = ? AND (status = 'QUEUED' OR status = 'RETRYABLE')
        `).run(nowIso, workerId, leaseToken, leaseExpiresAt, leaseDurationMs, nowIso, eligible.id);

        if (Number(res.changes) === 0) return;

        claimed = {
          id: eligible.id,
          scanId: eligible.scan_id,
          status: 'RUNNING',
          attempts: eligible.attempts + 1,
          maxAttempts: eligible.max_attempts,
          runAt: eligible.run_at,
          lockedAt: nowIso,
          lockedBy: workerId,
          leaseToken: leaseToken,
          leaseExpiresAt,
          leaseDurationMs,
          lastError: eligible.last_error || null,
          createdAt: eligible.created_at,
          updatedAt: nowIso
        };
      });
      return claimed;
    },

    completeJob: async (id: string, workerId?: string, leaseToken?: string): Promise<void> => {
      if (!leaseToken || typeof leaseToken !== 'string' || leaseToken.trim() === '') {
        throw new FencingError(`Cannot complete job ${id}: worker lease token is required`);
      }
      await this.runTransaction(db => {
        const now = new Date().toISOString();
        let query = `
          UPDATE job_queue 
          SET status = 'COMPLETED',
              locked_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = ?
          WHERE id = ? AND lease_token = ? AND status = 'RUNNING'
        `;
        const params: any[] = [now, id, leaseToken];
        if (workerId) {
          query += ' AND locked_by = ?';
          params.push(workerId);
        }
        const res = db.prepare(query).run(...params);

        if (Number(res.changes) === 0) {
          throw new FencingError(`Failed to complete job ${id}: lease token expired or superseded`);
        }
      });
    },

    failJob: async (id: string, error: string, retryable: boolean, backoffMs: number = 5000, workerId?: string, leaseToken?: string): Promise<void> => {
      if (!leaseToken || typeof leaseToken !== 'string' || leaseToken.trim() === '') {
        throw new FencingError(`Cannot fail job ${id}: worker lease token is required`);
      }
      await this.runTransaction(db => {
        const now = new Date();
        const nowIso = now.toISOString();
        const nextRun = new Date(now.getTime() + backoffMs).toISOString();
        const status = retryable ? 'RETRYABLE' : 'FAILED';

        let query = `
          UPDATE job_queue 
          SET status = ?,
              run_at = ?,
              locked_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = ?,
              updated_at = ?
          WHERE id = ? AND lease_token = ? AND status = 'RUNNING'
        `;
        const params: any[] = [status, nextRun, error, nowIso, id, leaseToken];
        if (workerId) {
          query += ' AND locked_by = ?';
          params.push(workerId);
        }
        const res = db.prepare(query).run(...params);

        if (Number(res.changes) === 0) {
          throw new FencingError(`Failed to fail job ${id}: lease token expired or superseded`);
        }
      });
    },

    recoverStaleJobs: async (leaseTimeoutMs: number = 60000): Promise<number> => {
      if (leaseTimeoutMs === undefined || leaseTimeoutMs === null) {
        leaseTimeoutMs = 60000;
      }
      if (typeof leaseTimeoutMs !== 'number' || !Number.isFinite(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
        throw new Error(`Invalid leaseTimeoutMs: must be a positive finite number (received: ${leaseTimeoutMs})`);
      }
      const MAX_LEASE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
      if (leaseTimeoutMs > MAX_LEASE_TIMEOUT_MS) {
        throw new Error(`leaseTimeoutMs exceeds maximum allowable timeout of 24 hours (received: ${leaseTimeoutMs})`);
      }

      return await this.runTransaction(db => {
        const now = new Date();
        const cutoff = new Date(now.getTime() - leaseTimeoutMs).toISOString();
        const nowIso = now.toISOString();

        const res = db.prepare(`
          UPDATE job_queue 
          SET status = 'RETRYABLE',
              locked_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = ?
          WHERE status = 'RUNNING' 
            AND (
              (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
              OR (locked_at IS NOT NULL AND locked_at <= ?)
            )
        `).run(nowIso, nowIso, cutoff);

        return Number(res.changes);
      });
    },

    renewLease: async (id: string, workerId: string, leaseToken?: string, leaseDurationMs: number = 60000): Promise<boolean> => {
      if (!leaseToken || typeof leaseToken !== 'string' || leaseToken.trim() === '') {
        throw new FencingError(`Cannot renew lease for job ${id}: worker lease token is required`);
      }
      return await this.runTransaction(db => {
        const now = new Date();
        const nowIso = now.toISOString();
        const duration = Math.min(Math.max(leaseDurationMs || 60000, 1000), 24 * 60 * 60 * 1000);
        const leaseExpiresAt = new Date(now.getTime() + duration).toISOString();

        const res = db.prepare(`
          UPDATE job_queue 
          SET locked_at = ?,
              lease_expires_at = ?,
              lease_duration_ms = ?,
              updated_at = ?
          WHERE id = ? AND locked_by = ? AND lease_token = ? AND status = 'RUNNING'
        `).run(nowIso, leaseExpiresAt, duration, nowIso, id, workerId, leaseToken);

        return Number(res.changes) > 0;
      });
    },

    retryJob: async (scanId: string): Promise<JobQueueRecord> => {
      return await this.runTransaction(db => {
        const job = db.prepare('SELECT * FROM job_queue WHERE scan_id = ?').get(scanId) as any;
        if (!job) {
          throw new Error(`Job for scan ${scanId} not found`);
        }
        if (job.status === 'RUNNING' || job.status === 'QUEUED') {
          throw new Error(`Cannot retry active or queued job for scan ${scanId} (status: ${job.status})`);
        }
        if (job.status === 'COMPLETED') {
          throw new Error(`Cannot retry completed job for scan ${scanId}; please initiate an explicit re-scan instead`);
        }
        const nowIso = new Date().toISOString();
        db.prepare(`
          UPDATE job_queue 
          SET status = 'QUEUED',
              attempts = 0,
              run_at = ?,
              locked_at = NULL,
              locked_by = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              updated_at = ?
          WHERE scan_id = ?
        `).run(nowIso, nowIso, scanId);

        db.prepare(`
          UPDATE scans 
          SET status = 'QUEUED',
              error = NULL
          WHERE id = ?
        `).run(scanId);

        const updated = db.prepare('SELECT * FROM job_queue WHERE scan_id = ?').get(scanId) as any;
        return {
          id: updated.id,
          scanId: updated.scan_id,
          status: updated.status,
          attempts: Number(updated.attempts),
          maxAttempts: Number(updated.max_attempts),
          runAt: updated.run_at,
          lockedAt: updated.locked_at || null,
          lockedBy: updated.locked_by || null,
          leaseToken: updated.lease_token || null,
          leaseExpiresAt: updated.lease_expires_at || null,
          leaseDurationMs: updated.lease_duration_ms ? Number(updated.lease_duration_ms) : null,
          lastError: updated.last_error || null,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at
        };
      });
    },

    getJobByScanId: async (scanId: string): Promise<JobQueueRecord | null> => {
      const row = this.db.prepare('SELECT * FROM job_queue WHERE scan_id = ?').get(scanId) as any;
      if (!row) return null;
      return {
        id: row.id,
        scanId: row.scan_id,
        status: row.status,
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        runAt: row.run_at,
        lockedAt: row.locked_at || null,
        lockedBy: row.locked_by || null,
        leaseToken: row.lease_token || null,
        leaseExpiresAt: row.lease_expires_at || null,
        leaseDurationMs: row.lease_duration_ms ? Number(row.lease_duration_ms) : null,
        lastError: row.last_error || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    }
  };

  // -------------------------------------------------------------
  // EVIDENCE REPOSITORY
  // -------------------------------------------------------------
  public evidence: IEvidenceRepository = {
    saveEvidence: async (scanId: string, items: EvidenceItem[], leaseToken?: LeaseFencingToken): Promise<void> => {
      await this.runTransaction(db => {
        this.validateLeaseFence(db, scanId, leaseToken);
        db.prepare('DELETE FROM evidence WHERE scan_id = ?').run(scanId);
        const stmt = db.prepare(`
          INSERT INTO evidence (id, scan_id, data_json, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET scan_id = excluded.scan_id, data_json = excluded.data_json
        `);
        const now = new Date().toISOString();
        for (const item of items) {
          stmt.run(item.id, scanId, JSON.stringify(item), now);
        }
      });
    },

    getEvidence: async (scanId: string): Promise<EvidenceItem[]> => {
      const rows = this.db.prepare('SELECT data_json FROM evidence WHERE scan_id = ? ORDER BY created_at ASC').all(scanId) as any[];
      return rows.map(r => JSON.parse(r.data_json));
    }
  };

  // -------------------------------------------------------------
  // USAGE REPOSITORY
  // -------------------------------------------------------------
  public usage: IUsageRepository = {
    recordUsage: async (userId: string, scanId: string, durationMinutes: number, creditsDeducted: number, mode: string, leaseToken?: LeaseFencingToken): Promise<void> => {
      await this.runTransaction(db => {
        this.validateLeaseFence(db, scanId, leaseToken);
        const id = `usg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        db.prepare(`
          INSERT INTO usage_ledger (id, user_id, scan_id, duration_minutes, credits_deducted, mode, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scan_id) DO NOTHING
        `).run(id, userId, scanId, durationMinutes, creditsDeducted, mode, new Date().toISOString());
      });
    },

    getUsageStats: async (userId: string): Promise<{ totalMinutes: number; totalCredits: number; scanCount: number }> => {
      const row = this.db.prepare(`
        SELECT 
          COALESCE(SUM(duration_minutes), 0) as totalMinutes,
          COALESCE(SUM(credits_deducted), 0) as totalCredits,
          COUNT(*) as scanCount
        FROM usage_ledger 
        WHERE user_id = ?
      `).get(userId) as any;

      return {
        totalMinutes: Number(row.totalMinutes || 0),
        totalCredits: Number(row.totalCredits || 0),
        scanCount: Number(row.scanCount || 0)
      };
    }
  };

  // -------------------------------------------------------------
  // CHANNEL PROFILE REPOSITORY
  // -------------------------------------------------------------
  public channelProfiles: IChannelProfileRepository = {
    getProfile: async (userId: string): Promise<ChannelContextProfile | null> => {
      const row = this.db.prepare('SELECT data_json FROM channel_profiles WHERE user_id = ?').get(userId) as any;
      if (!row) return null;
      return JSON.parse(row.data_json);
    },

    saveProfile: async (userId: string, data: Partial<ChannelContextProfile>): Promise<ChannelContextProfile> => {
      const existing = await this.channelProfiles.getProfile(userId);
      const version = existing ? existing.version + 1 : 1;
      const profile: ChannelContextProfile = {
        id: existing?.id || `cp_${userId}_${Date.now()}`,
        userId,
        version,
        channelTopic: data.channelTopic ?? existing?.channelTopic ?? 'General Video Analysis',
        contentType: data.contentType ?? existing?.contentType ?? 'commentary',
        productionWorkflow: data.productionWorkflow ?? existing?.productionWorkflow ?? 'Creator scripted commentary with original voice narration.',
        thirdPartyFootageUsage: data.thirdPartyFootageUsage ?? existing?.thirdPartyFootageUsage ?? 'fair_use_commentary',
        originalVoiceNarration: data.originalVoiceNarration ?? existing?.originalVoiceNarration ?? 'always',
        aiAssistedContent: data.aiAssistedContent ?? existing?.aiAssistedContent ?? false,
        aiDisclosureDetails: data.aiDisclosureDetails ?? existing?.aiDisclosureDetails ?? '',
        typicalSources: data.typicalSources ?? existing?.typicalSources ?? 'Original screen recordings and licensed stock clips.',
        updatedAt: new Date().toISOString()
      };

      this.db.prepare(`
        INSERT INTO channel_profiles (user_id, data_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
      `).run(userId, JSON.stringify(profile), new Date().toISOString());

      return profile;
    },

    deleteProfile: async (userId: string): Promise<boolean> => {
      const res = this.db.prepare('DELETE FROM channel_profiles WHERE user_id = ?').run(userId);
      return res.changes > 0;
    }
  };

  // -------------------------------------------------------------
  // UPLOADS REPOSITORY
  // -------------------------------------------------------------
  public uploads: IUploadRepository = {
    recordUpload: async (upload: UploadRecord): Promise<UploadRecord> => {
      this.db.prepare(`
        INSERT INTO uploads (file_id, user_id, filename, file_path, file_size, type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_id) DO UPDATE SET 
          filename = excluded.filename,
          file_path = excluded.file_path,
          file_size = excluded.file_size
      `).run(upload.fileId, upload.userId, upload.filename, upload.filePath, upload.fileSize, upload.type, upload.createdAt);
      return upload;
    },

    getUpload: async (fileId: string): Promise<UploadRecord | null> => {
      const row = this.db.prepare('SELECT * FROM uploads WHERE file_id = ?').get(fileId) as any;
      if (!row) return null;
      return {
        fileId: row.file_id,
        userId: row.user_id,
        filename: row.filename,
        filePath: row.file_path,
        fileSize: Number(row.file_size),
        type: row.type,
        createdAt: row.created_at
      };
    },

    getUploadByPath: async (filePath: string): Promise<UploadRecord | null> => {
      const resolved = path.resolve(filePath);
      const rows = this.db.prepare('SELECT * FROM uploads').all() as any[];
      const found = rows.find(r => path.resolve(r.file_path) === resolved);
      if (!found) return null;
      return {
        fileId: found.file_id,
        userId: found.user_id,
        filename: found.filename,
        filePath: found.file_path,
        fileSize: Number(found.file_size),
        type: found.type,
        createdAt: found.created_at
      };
    },

    deleteUpload: async (fileId: string): Promise<boolean> => {
      const res = this.db.prepare('DELETE FROM uploads WHERE file_id = ?').run(fileId);
      return res.changes > 0;
    }
  };

  // -------------------------------------------------------------
  // BILLING REPOSITORY
  // -------------------------------------------------------------
  public billing: IBillingRepository = {
    getPlans: async () => [],

    isEventProcessed: async (eventId: string): Promise<boolean> => {
      const row = this.db.prepare('SELECT event_id FROM webhook_events WHERE event_id = ?').get(eventId);
      return !!row;
    },

    markEventProcessed: async (record: WebhookEventRecord): Promise<void> => {
      this.db.prepare(`
        INSERT INTO webhook_events (event_id, provider, event_type, payload_json, processed_at, user_id, credits_granted, plan_granted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `).run(
        record.eventId,
        record.provider,
        record.eventType,
        JSON.stringify(record),
        record.processedAt,
        record.userId || null,
        record.creditsGranted || null,
        record.planGranted || null
      );
    },

    saveSubscription: async (sub: SubscriptionRecord): Promise<void> => {
      this.db.prepare(`
        INSERT INTO subscriptions (id, user_id, plan_id, status, current_period_end, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET 
          plan_id = excluded.plan_id,
          status = excluded.status,
          current_period_end = excluded.current_period_end,
          updated_at = excluded.updated_at
      `).run(sub.id, sub.userId, sub.planId, sub.status, sub.currentPeriodEnd || null, sub.createdAt, sub.updatedAt);
    },

    getSubscription: async (id: string): Promise<SubscriptionRecord | null> => {
      const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as any;
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        planId: row.plan_id,
        status: row.status,
        currentPeriodEnd: row.current_period_end || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

    getSubscriptionsByUserId: async (userId: string): Promise<SubscriptionRecord[]> => {
      const rows = this.db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').all(userId) as any[];
      return rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        planId: row.plan_id,
        status: row.status,
        currentPeriodEnd: row.current_period_end || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    }
  };

  // -------------------------------------------------------------
  // OPERATIONAL METRICS (WORKSTREAM 12)
  // -------------------------------------------------------------
  public async getOperationalMetrics(): Promise<OperationalMetrics> {
    const totalScans = (this.db.prepare('SELECT COUNT(*) as c FROM scans').get() as any).c;
    const completedScans = (this.db.prepare("SELECT COUNT(*) as c FROM scans WHERE status = 'COMPLETED'").get() as any).c;
    const failedScans = (this.db.prepare("SELECT COUNT(*) as c FROM scans WHERE status = 'FAILED'").get() as any).c;

    const reports = this.db.prepare('SELECT data_json FROM reports').all() as any[];
    let totalProcSec = 0;
    let inspMs = 0;
    let audioMs = 0;
    let videoMs = 0;
    let policyMs = 0;
    let reportCount = 0;

    for (const r of reports) {
      try {
        const parsed = JSON.parse(r.data_json);
        if (parsed.benchmarkMetrics) {
          totalProcSec += parsed.benchmarkMetrics.totalProcessingSeconds || 0;
          inspMs += parsed.benchmarkMetrics.inspectionMs || 0;
          audioMs += parsed.benchmarkMetrics.audioProcessingMs || 0;
          videoMs += parsed.benchmarkMetrics.videoAnalysisMs || 0;
          policyMs += parsed.benchmarkMetrics.policyReasoningMs || 0;
          reportCount++;
        }
      } catch {}
    }

    const usage = this.db.prepare('SELECT COALESCE(SUM(duration_minutes), 0) as totalMin FROM usage_ledger').get() as any;
    const totalMin = Number(usage.totalMin || 0);

    // Standard transparent pricing constants:
    // $0.005 per compute minute, $0.0001 per storage MB
    const estimatedComputeCostUsd = parseFloat((totalMin * 0.005).toFixed(4));
    const estimatedStorageCostUsd = parseFloat((reportCount * 0.001).toFixed(4));

    return {
      totalScans,
      completedScans,
      failedScans,
      averageProcessingSeconds: reportCount > 0 ? parseFloat((totalProcSec / reportCount).toFixed(2)) : 0,
      totalDurationSecondsScanned: Math.round(totalMin * 60),
      estimatedComputeCostUsd,
      estimatedStorageCostUsd,
      measuredStageAveragesMs: {
        inspection: reportCount > 0 ? Math.round(inspMs / reportCount) : 0,
        audio: reportCount > 0 ? Math.round(audioMs / reportCount) : 0,
        video: reportCount > 0 ? Math.round(videoMs / reportCount) : 0,
        policy: reportCount > 0 ? Math.round(policyMs / reportCount) : 0
      }
    };
  }
}

/**
 * Migration helper to safely transition existing JSON file store into SQLite
 */
export function migrateJsonToSqlite(jsonFilePath: string, sqliteDb: SqliteStorageRepository): {
  migratedUsers: number;
  migratedScans: number;
  migratedReports: number;
  migratedSubscriptions: number;
  migratedUploads: number;
  backupPath: string;
} {
  if (!fs.existsSync(jsonFilePath)) {
    return {
      migratedUsers: 0,
      migratedScans: 0,
      migratedReports: 0,
      migratedSubscriptions: 0,
      migratedUploads: 0,
      backupPath: ''
    };
  }

  const raw = fs.readFileSync(jsonFilePath, 'utf-8');
  const data = JSON.parse(raw);

  // Create timestamped backup
  const backupPath = `${jsonFilePath}.${Date.now()}.bak`;
  fs.copyFileSync(jsonFilePath, backupPath);

  let migratedUsers = 0;
  let migratedScans = 0;
  let migratedReports = 0;
  let migratedSubscriptions = 0;
  let migratedUploads = 0;

  const db = sqliteDb.db;
  db.exec('BEGIN IMMEDIATE;');
  try {
    // 1. Users
    if (data.users && typeof data.users === 'object') {
      const userStmt = db.prepare(`
        INSERT INTO users (id, email, plan, credits_remaining, credits_used_total, total_scans_count, created_at, password_hash, salt, free_trial_claimed, stripe_customer_id, subscription_id, subscription_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET 
          credits_remaining = excluded.credits_remaining,
          credits_used_total = excluded.credits_used_total,
          free_trial_claimed = excluded.free_trial_claimed
      `);

      for (const u of Object.values<any>(data.users)) {
        if (!u || !u.id || !u.email) continue;
        userStmt.run(
          u.id,
          u.email.toLowerCase(),
          u.plan || 'free',
          u.creditsRemaining ?? 10,
          u.creditsUsedTotal ?? 0,
          u.totalScansCount ?? 0,
          u.createdAt || new Date().toISOString(),
          u.passwordHash || null,
          u.salt || null,
          u.freeTrialClaimed ? 1 : 0,
          u.stripeCustomerId || null,
          u.subscriptionId || null,
          u.subscriptionStatus || null
        );
        migratedUsers++;
      }
    }

    // 2. Uploads
    if (data.uploads && typeof data.uploads === 'object') {
      const uploadStmt = db.prepare(`
        INSERT INTO uploads (file_id, user_id, filename, file_path, file_size, type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_id) DO NOTHING
      `);
      for (const up of Object.values<any>(data.uploads)) {
        if (!up || !up.fileId) continue;
        try {
          uploadStmt.run(up.fileId, up.userId, up.filename, up.filePath, up.fileSize || 0, up.type || 'video', up.createdAt || new Date().toISOString());
          migratedUploads++;
        } catch {}
      }
    }

    // 3. Scans
    if (data.scans && typeof data.scans === 'object') {
      const scanStmt = db.prepare(`
        INSERT INTO scans (
          id, user_id, video_title, video_description, video_tags_json, video_filename, video_path,
          thumbnail_path, thumbnail_filename, thumbnail_metadata_json, proxy_path, scan_mode,
          status, current_stage, completed_stages_json, credits_used, credits_deducted,
          credits_refunded, credits_refunded_amount, metadata_json, benchmark_metrics_json,
          error, parent_scan_id, is_rescan, created_at, completed_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO NOTHING
      `);

      for (const s of Object.values<any>(data.scans)) {
        if (!s || !s.id || !s.userId) continue;
        try {
          scanStmt.run(
            s.id,
            s.userId,
            s.videoTitle || 'Untitled Scan',
            s.videoDescription || null,
            s.videoTags ? JSON.stringify(s.videoTags) : null,
            s.videoFilename || 'video.mp4',
            s.videoPath || '',
            s.thumbnailPath || null,
            s.thumbnailFilename || null,
            s.thumbnailMetadata ? JSON.stringify(s.thumbnailMetadata) : null,
            s.proxyPath || null,
            s.scanMode || 'standard',
            s.status || 'COMPLETED',
            s.currentStage || 'Risk report',
            JSON.stringify(s.completedStages || ['Upload', 'Risk report']),
            s.creditsUsed || 0,
            s.creditsDeducted || 0,
            s.creditsRefunded ? 1 : 0,
            s.creditsRefundedAmount || 0,
            s.metadata ? JSON.stringify(s.metadata) : null,
            null,
            s.error || null,
            s.parentScanId || null,
            s.isRescan ? 1 : 0,
            s.createdAt || new Date().toISOString(),
            s.completedAt || null
          );
          migratedScans++;
        } catch {}
      }
    }

    // 4. Reports
    if (data.reports && typeof data.reports === 'object') {
      const repStmt = db.prepare(`
        INSERT INTO reports (scan_id, data_json, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(scan_id) DO NOTHING
      `);
      for (const [sId, rep] of Object.entries<any>(data.reports)) {
        if (!rep) continue;
        try {
          repStmt.run(sId, JSON.stringify(rep), new Date().toISOString());
          migratedReports++;
        } catch {}
      }
    }

    // 5. Subscriptions
    if (data.subscriptions && typeof data.subscriptions === 'object') {
      const subStmt = db.prepare(`
        INSERT INTO subscriptions (id, user_id, plan_id, status, current_period_end, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `);
      for (const sub of Object.values<any>(data.subscriptions)) {
        if (!sub || !sub.id) continue;
        try {
          subStmt.run(sub.id, sub.userId, sub.planId, sub.status, sub.currentPeriodEnd || null, sub.createdAt || new Date().toISOString(), sub.updatedAt || new Date().toISOString());
          migratedSubscriptions++;
        } catch {}
      }
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return {
    migratedUsers,
    migratedScans,
    migratedReports,
    migratedSubscriptions,
    migratedUploads,
    backupPath
  };
}
