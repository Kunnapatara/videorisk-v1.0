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

export interface IPasswordResetRepository {
  createResetToken(userId: string, tokenHash: string, expiresAt: string): Promise<void>;
  getResetToken(tokenHash: string): Promise<PasswordResetRecord | null>;
  markTokenUsed(tokenHash: string): Promise<boolean>;
  revokeAllUserSessions(userId: string): Promise<void>;
  checkRateLimit(key: string, action: string, limit: number, windowSeconds: number): Promise<boolean>;
}

export interface IJobQueueRepository {
  enqueueJob(scanId: string, runAt?: string): Promise<JobQueueRecord>;
  claimNextJob(workerId: string, leaseDurationMs?: number): Promise<JobQueueRecord | null>;
  completeJob(id: string, workerId?: string, leaseToken?: string): Promise<void>;
  failJob(id: string, error: string, retryable: boolean, backoffMs?: number, workerId?: string, leaseToken?: string): Promise<void>;
  recoverStaleJobs(leaseTimeoutMs?: number): Promise<number>;
  renewLease(id: string, workerId: string, leaseToken?: string, leaseDurationMs?: number): Promise<boolean>;
  retryJob(scanId: string): Promise<JobQueueRecord>;
  getJobByScanId(scanId: string): Promise<JobQueueRecord | null>;
}

export interface IChannelProfileRepository {
  getProfile(userId: string): Promise<ChannelContextProfile | null>;
  saveProfile(userId: string, data: Partial<ChannelContextProfile>): Promise<ChannelContextProfile>;
  deleteProfile(userId: string): Promise<boolean>;
}

export interface IUserRepository {
  getUser(id: string): Promise<UserAccount | null>;
  getUserByEmail(email: string): Promise<UserAccount | null>;
  listUsers(): Promise<UserAccount[]>;
  createUser(email: string, passwordHash?: string, salt?: string, initialCredits?: number, initialPlan?: 'free' | 'creator' | 'pro' | 'agency'): Promise<UserAccount>;
  getOrCreateDefaultUser(): Promise<UserAccount>;
  deductCredits(userId: string, amount: number): Promise<boolean>;
  addCredits(userId: string, amount: number): Promise<UserAccount>;
  updatePlan(userId: string, plan: 'free' | 'creator' | 'pro' | 'agency', credits: number): Promise<UserAccount>;
  claimFreeTrial(userId: string): Promise<{ user: UserAccount; alreadyClaimed: boolean }>;
  updateUser(userId: string, updates: Partial<UserAccount>): Promise<UserAccount | null>;
  createSession(userId: string): Promise<string>;
  getUserBySession(token: string): Promise<UserAccount | null>;
  deleteSession(token: string): Promise<void>;
}

export type LeaseFencingToken = string | { systemBypass: true };

export interface IScanRepository {
  createScan(scan: ScanJob): Promise<ScanJob>;
  getScan(id: string): Promise<ScanJob | null>;
  getAllScans(userId?: string): Promise<ScanJob[]>;
  updateScan(id: string, updates: Partial<ScanJob>, leaseToken?: LeaseFencingToken): Promise<ScanJob | null>;
  saveReport(scanId: string, report: RiskReport, leaseToken?: LeaseFencingToken): Promise<void>;
  getReport(scanId: string): Promise<RiskReport | null>;
  saveComparison(comparison: ReScanComparison, leaseToken?: LeaseFencingToken): Promise<void>;
  getComparison(revisedScanId: string): Promise<ReScanComparison | null>;
  deductScanCredits(scanId: string, userId: string, amount: number, leaseToken?: LeaseFencingToken): Promise<boolean>;
  refundScanCredits(scanId: string, hintAmount?: number, leaseToken?: LeaseFencingToken): Promise<{ refunded: boolean; amount: number }>;
  deleteScan(id: string): Promise<boolean>;
  isMediaShared(filePath: string, excludeScanId: string): Promise<boolean>;
}

export interface IEvidenceRepository {
  saveEvidence(scanId: string, items: EvidenceItem[], leaseToken?: LeaseFencingToken): Promise<void>;
  getEvidence(scanId: string): Promise<EvidenceItem[]>;
}

export interface IUsageRepository {
  recordUsage(userId: string, scanId: string, durationMinutes: number, creditsDeducted: number, mode: string, leaseToken?: LeaseFencingToken): Promise<void>;
  getUsageStats(userId: string): Promise<{ totalMinutes: number; totalCredits: number; scanCount: number }>;
}

export interface UploadRecord {
  fileId: string;
  userId: string;
  filename: string;
  filePath: string;
  fileSize: number;
  type: 'video' | 'thumbnail';
  createdAt: string;
}

export interface IUploadRepository {
  recordUpload(upload: UploadRecord): Promise<UploadRecord>;
  getUpload(fileId: string): Promise<UploadRecord | null>;
  getUploadByPath(filePath: string): Promise<UploadRecord | null>;
  deleteUpload(fileId: string): Promise<boolean>;
}

export interface IBillingRepository {
  getPlans(): Promise<any[]>;
  isEventProcessed(eventId: string): Promise<boolean>;
  markEventProcessed(record: WebhookEventRecord): Promise<void>;
  saveSubscription(sub: SubscriptionRecord): Promise<void>;
  getSubscription(id: string): Promise<SubscriptionRecord | null>;
  getSubscriptionsByUserId(userId: string): Promise<SubscriptionRecord[]>;
}

export interface IStorageRepository {
  users: IUserRepository;
  uploads: IUploadRepository;
  channelProfiles: IChannelProfileRepository;
  scans: IScanRepository;
  evidence: IEvidenceRepository;
  usage: IUsageRepository;
  billing: IBillingRepository;
  passwordReset: IPasswordResetRepository;
  queue: IJobQueueRepository;
  getOperationalMetrics?: () => Promise<OperationalMetrics>;
  close?: () => Promise<void>;
  runTransaction<T>(operation: (state: any) => Promise<T> | T): Promise<T>;
}

// In-Memory Storage with pure JSON file persistence (for fast test isolation and fallback)
export class InMemoryStorageRepository implements IStorageRepository {
  private dataFile: string;
  private writeLock: Promise<void> = Promise.resolve();
  private state: {
    users: Record<string, UserAccount>;
    sessions: Record<string, AuthSessionRecord>;
    passwordResets: Record<string, PasswordResetRecord>;
    rateLimits: Array<{ key: string; action: string; timestamp: number }>;
    uploads: Record<string, UploadRecord>;
    channelProfiles: Record<string, ChannelContextProfile>;
    scans: Record<string, ScanJob>;
    jobQueue: Record<string, JobQueueRecord>;
    reports: Record<string, RiskReport>;
    evidence: Record<string, EvidenceItem[]>;
    comparisons: Record<string, ReScanComparison>;
    usage: Array<{ userId: string; scanId: string; durationMinutes: number; creditsDeducted: number; mode: string; timestamp: string }>;
    webhookEvents: Record<string, WebhookEventRecord>;
    subscriptions: Record<string, SubscriptionRecord>;
  };

  constructor(customDataFile?: string) {
    if (customDataFile) {
      this.dataFile = path.resolve(customDataFile);
    } else if (process.env.STORE_PATH) {
      this.dataFile = path.resolve(process.env.STORE_PATH);
    } else if (process.env.DATA_DIR) {
      this.dataFile = path.resolve(process.env.DATA_DIR, 'store.json');
    } else {
      this.dataFile = path.resolve(process.cwd(), 'data', 'store.json');
    }

    this.state = {
      users: {},
      sessions: {},
      passwordResets: {},
      rateLimits: [],
      uploads: {},
      channelProfiles: {},
      scans: {},
      jobQueue: {},
      reports: {},
      evidence: {},
      comparisons: {},
      usage: [],
      webhookEvents: {},
      subscriptions: {},
    };
    this.load();
    this.seedDefaultUserIfNeeded();
  }

  private seedDefaultUserIfNeeded() {
    // SECURITY: Do NOT seed default or demo credentials in production mode!
    if (process.env.NODE_ENV === 'production') {
      return;
    }

    let modified = false;
    const defaultId = 'user_default';
    if (!this.state.users[defaultId]) {
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync('creator123', salt, 64).toString('hex');
      this.state.users[defaultId] = {
        id: defaultId,
        email: 'creator@videorisk.com',
        plan: 'creator',
        creditsRemaining: 30, // Starter evaluation credits
        creditsUsedTotal: 0,
        totalScansCount: 0,
        createdAt: new Date().toISOString(),
        passwordHash,
        salt,
        freeTrialClaimed: true,
      };
      modified = true;
    } else if (!this.state.users[defaultId].passwordHash) {
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync('creator123', salt, 64).toString('hex');
      this.state.users[defaultId].passwordHash = passwordHash;
      this.state.users[defaultId].salt = salt;
      modified = true;
    }

    const proId = 'user_pro';
    if (!this.state.users[proId]) {
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync('pro123', salt, 64).toString('hex');
      this.state.users[proId] = {
        id: proId,
        email: 'pro@videorisk.com',
        plan: 'pro',
        creditsRemaining: 75,
        creditsUsedTotal: 0,
        totalScansCount: 0,
        createdAt: new Date().toISOString(),
        passwordHash,
        salt,
        freeTrialClaimed: true,
      };
      modified = true;
    }

    const freeId = 'user_free';
    if (!this.state.users[freeId]) {
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync('free123', salt, 64).toString('hex');
      this.state.users[freeId] = {
        id: freeId,
        email: 'free@videorisk.com',
        plan: 'free',
        creditsRemaining: 10,
        creditsUsedTotal: 0,
        totalScansCount: 0,
        createdAt: new Date().toISOString(),
        passwordHash,
        salt,
        freeTrialClaimed: true,
      };
      modified = true;
    }

    if (modified) {
      this.save();
    }
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) {
      // Normal first startup: file does not exist yet
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.dataFile, 'utf-8');
    } catch (readErr: any) {
      const message = `[Storage] Failed to read existing storage file '${this.dataFile}': ${readErr.message || readErr}`;
      console.error(message);
      throw new Error(message);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (jsonErr: any) {
      const message = `[Storage] Existing storage file '${this.dataFile}' contains malformed JSON: ${jsonErr.message || jsonErr}`;
      console.error(message);
      throw new Error(message);
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const message = `[Storage] Existing storage file '${this.dataFile}' has invalid root structure (expected a non-null object, got ${Array.isArray(parsed) ? 'array' : typeof parsed})`;
      console.error(message);
      throw new Error(message);
    }

    this.state = {
      users: parsed.users || {},
      sessions: parsed.sessions || {},
      passwordResets: parsed.passwordResets || {},
      rateLimits: parsed.rateLimits || [],
      uploads: parsed.uploads || {},
      channelProfiles: parsed.channelProfiles || {},
      scans: parsed.scans || {},
      jobQueue: parsed.jobQueue || {},
      reports: parsed.reports || {},
      evidence: parsed.evidence || {},
      comparisons: parsed.comparisons || {},
      usage: parsed.usage || [],
      webhookEvents: parsed.webhookEvents || {},
      subscriptions: parsed.subscriptions || {},
    };

    let migratedLegacyFreeTrialFlags = false;

    for (const user of Object.values(this.state.users)) {
      if (typeof user.freeTrialClaimed !== 'boolean') {
        // Fail closed: legacy entitlement history cannot be proven.
        // Do not grant another trial to an existing account.
        user.freeTrialClaimed = true;
        migratedLegacyFreeTrialFlags = true;
      }
    }

    if (migratedLegacyFreeTrialFlags) {
      // Persist the migration immediately so it survives restarts.
      this.saveAtomic();
    }
  }

  public save() {
    this.saveAtomic();
  }

  public saveAtomic() {
    try {
      const dir = path.dirname(this.dataFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpFile = `${this.dataFile}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this.dataFile);
    } catch (err) {
      console.warn('[Storage] Failed to atomically write store.json:', err);
      throw err;
    }
  }

  public async runTransaction<T>(operation: (state: typeof this.state) => Promise<T> | T): Promise<T> {
    const previousLock = this.writeLock;
    let releaseLock: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await previousLock;

    const stateSnapshot = JSON.stringify(this.state);
    try {
      const result = await operation(this.state);
      this.saveAtomic();
      return result;
    } catch (err) {
      this.state = JSON.parse(stateSnapshot);
      throw err;
    } finally {
      releaseLock!();
    }
  }

  public users: IUserRepository = {
    getUser: async (id: string) => {
      return this.state.users[id] || null;
    },
    getUserByEmail: async (email: string) => {
      const normalized = email.toLowerCase().trim();
      return Object.values(this.state.users).find(u => u.email.toLowerCase() === normalized) || null;
    },
    listUsers: async () => {
      return Object.values(this.state.users);
    },
    createUser: async (
      email: string, 
      passwordHash?: string, 
      salt?: string, 
      initialCredits: number = 10,
      initialPlan: 'free' | 'creator' | 'pro' | 'agency' = 'free'
    ) => {
      const id = `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const newUser: UserAccount = {
        id,
        email: email.toLowerCase().trim(),
        plan: initialPlan,
        creditsRemaining: initialCredits,
        creditsUsedTotal: 0,
        totalScansCount: 0,
        createdAt: new Date().toISOString(),
        passwordHash,
        salt,
        freeTrialClaimed: true,
      };
      this.state.users[id] = newUser;
      this.save();
      return newUser;
    },
    getOrCreateDefaultUser: async () => {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Default demo user is disabled in production.');
      }
      const defaultId = 'user_default';
      if (!this.state.users[defaultId]) {
        this.seedDefaultUserIfNeeded();
      }
      return this.state.users[defaultId];
    },
    createSession: async (userId: string) => {
      const token = `vr_sess_${crypto.randomBytes(32).toString('hex')}`;
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
      this.state.sessions[token] = {
        token,
        userId,
        createdAt: new Date().toISOString(),
        expiresAt,
      };
      this.save();
      return token;
    },
    getUserBySession: async (token: string) => {
      const session = this.state.sessions[token];
      if (!session) return null;
      if (new Date(session.expiresAt).getTime() < Date.now()) {
        delete this.state.sessions[token];
        this.save();
        return null;
      }
      return this.state.users[session.userId] || null;
    },
    deleteSession: async (token: string) => {
      if (this.state.sessions[token]) {
        delete this.state.sessions[token];
        this.save();
      }
    },
    deductCredits: async (userId: string, amount: number) => {
      const user = this.state.users[userId];
      if (!user) return false;
      const cleanAmount = Math.max(0, Math.round(amount));
      if (cleanAmount <= 0) return true;
      if (user.creditsRemaining < cleanAmount) return false;
      user.creditsRemaining -= cleanAmount;
      user.creditsUsedTotal += cleanAmount;
      this.save();
      return true;
    },
    addCredits: async (userId: string, amount: number) => {
      const user = this.state.users[userId];
      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }
      const cleanAmount = Math.max(0, Math.round(amount));
      user.creditsRemaining += cleanAmount;
      this.save();
      return user;
    },
    updatePlan: async (userId: string, plan: 'free' | 'creator' | 'pro' | 'agency', credits: number) => {
      const user = this.state.users[userId];
      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }
      user.plan = plan;
      const cleanCredits = Math.max(0, Math.round(credits));
      user.creditsRemaining = Math.max(0, user.creditsRemaining) + cleanCredits;
      this.save();
      return user;
    },
    claimFreeTrial: async (userId: string) => {
      return await this.runTransaction(async (state) => {
        const user = state.users[userId];
        if (!user) {
          throw new Error(`User not found: ${userId}`);
        }
        if (user.freeTrialClaimed) {
          return { user, alreadyClaimed: true };
        }
        user.freeTrialClaimed = true;
        user.plan = 'free';
        user.creditsRemaining = Math.max(0, user.creditsRemaining) + 10;
        return { user, alreadyClaimed: false };
      });
    },
    updateUser: async (userId: string, updates: Partial<UserAccount>) => {
      const user = this.state.users[userId];
      if (!user) return null;
      Object.assign(user, updates);
      this.save();
      return user;
    }
  };

  private validateLeaseFence(scanId: string, leaseToken?: LeaseFencingToken): void {
    if (typeof leaseToken === 'object' && leaseToken !== null && 'systemBypass' in leaseToken && leaseToken.systemBypass === true) {
      return; // Legitimate explicit system/administrative operation
    }
    if (!leaseToken || typeof leaseToken !== 'string' || leaseToken.trim() === '') {
      throw new FencingError(`Fencing violation for scan ${scanId}: worker lease token is required`);
    }
    const job = this.state.jobQueue[scanId];
    if (!job) {
      throw new FencingError(`Fencing violation for scan ${scanId}: no job queue record found`);
    }
    if (job.status !== 'RUNNING') {
      throw new FencingError(`Fencing violation for scan ${scanId}: job is not in RUNNING state (current: ${job.status})`);
    }
    if (job.leaseToken !== leaseToken) {
      throw new FencingError(`Fencing violation for scan ${scanId}: worker lease token is invalid or superseded`);
    }
    const nowIso = new Date().toISOString();
    if (job.leaseExpiresAt) {
      if (job.leaseExpiresAt <= nowIso) {
        throw new FencingError(`Fencing violation for scan ${scanId}: worker lease expired at ${job.leaseExpiresAt}`);
      }
    } else if (job.lockedAt) {
      const lockedTime = new Date(job.lockedAt).getTime();
      const duration = job.leaseDurationMs || 60000;
      if (lockedTime + duration <= Date.now()) {
        throw new FencingError(`Fencing violation for scan ${scanId}: worker lease expired by lockedAt threshold`);
      }
    }
  }

  public scans: IScanRepository = {
    createScan: async (scan: ScanJob) => {
      this.state.scans[scan.id] = scan;
      const user = this.state.users[scan.userId];
      if (user) {
        user.totalScansCount += 1;
      }
      this.save();
      if (scan.status === 'QUEUED') {
        await this.queue.enqueueJob(scan.id);
      } else {
        const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const now = new Date().toISOString();
        this.state.jobQueue[scan.id] = {
          id,
          scanId: scan.id,
          status: scan.status as any,
          attempts: 0,
          maxAttempts: 3,
          runAt: now,
          createdAt: now,
          updatedAt: now,
        };
      }
      return scan;
    },
    getScan: async (id: string) => {
      return this.state.scans[id] || null;
    },
    getAllScans: async (userId?: string) => {
      const list = Object.values(this.state.scans);
      if (userId) {
        return list.filter(s => s.userId === userId).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      }
      return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    },
    updateScan: async (id: string, updates: Partial<ScanJob>, leaseToken?: LeaseFencingToken) => {
      this.validateLeaseFence(id, leaseToken);
      const scan = this.state.scans[id];
      if (!scan) return null;
      Object.assign(scan, updates);
      this.save();
      return scan;
    },
    saveReport: async (scanId: string, report: RiskReport, leaseToken?: LeaseFencingToken) => {
      this.validateLeaseFence(scanId, leaseToken);
      this.state.reports[scanId] = report;
      this.save();
    },
    getReport: async (scanId: string) => {
      return this.state.reports[scanId] || null;
    },
    saveComparison: async (comparison: ReScanComparison, leaseToken?: LeaseFencingToken) => {
      this.validateLeaseFence(comparison.revisedScanId, leaseToken);
      this.state.comparisons[comparison.revisedScanId] = comparison;
      this.save();
    },
    getComparison: async (revisedScanId: string) => {
      return this.state.comparisons[revisedScanId] || null;
    },
    deductScanCredits: async (scanId: string, userId: string, amount: number, leaseToken?: LeaseFencingToken) => {
      return await this.runTransaction(async (state) => {
        this.validateLeaseFence(scanId, leaseToken);
        const user = state.users[userId];
        if (!user) throw new Error(`User not found: ${userId}`);
        const scan = state.scans[scanId];
        if (!scan) throw new Error(`Scan not found: ${scanId}`);

        const cleanAmount = Math.max(0, Math.round(amount));
        if (cleanAmount <= 0) return true;

        // Idempotency: if already deducted for this scan, do not deduct again
        if (scan.creditsDeducted && scan.creditsDeducted > 0) {
          return true;
        }

        if (user.creditsRemaining < cleanAmount) return false;

        user.creditsRemaining -= cleanAmount;
        user.creditsUsedTotal += cleanAmount;
        scan.creditsDeducted = cleanAmount;
        scan.creditsUsed = cleanAmount;
        scan.creditsRefunded = false;
        return true;
      });
    },
    refundScanCredits: async (scanId: string, hintAmount?: number, leaseToken?: LeaseFencingToken) => {
      return await this.runTransaction(async (state) => {
        this.validateLeaseFence(scanId, leaseToken);
        const scan = state.scans[scanId];
        if (!scan) {
          return { refunded: false, amount: 0 };
        }

        // Prevent double refunds
        if (scan.creditsRefunded) {
          return { refunded: false, amount: 0 };
        }

        const amountToRefund = Math.max(
          0,
          scan.creditsDeducted || 0,
          scan.creditsUsed || 0,
          hintAmount || 0
        );

        if (amountToRefund <= 0) {
          return { refunded: false, amount: 0 };
        }

        const user = state.users[scan.userId];
        if (!user) {
          throw new Error(`User not found: ${scan.userId} during refund`);
        }

        user.creditsRemaining += amountToRefund;
        user.creditsUsedTotal = Math.max(0, user.creditsUsedTotal - amountToRefund);
        scan.creditsRefunded = true;
        scan.creditsRefundedAmount = amountToRefund;
        scan.creditsUsed = 0;

        return { refunded: true, amount: amountToRefund };
      });
    },
    deleteScan: async (id: string): Promise<boolean> => {
      return await this.runTransaction(async (state) => {
        if (!state.scans[id]) return false;
        delete state.scans[id];
        delete state.reports[id];
        delete state.evidence[id];
        delete state.comparisons[id];
        delete state.jobQueue[id];
        return true;
      });
    },
    isMediaShared: async (filePath: string, excludeScanId: string): Promise<boolean> => {
      if (!filePath) return false;
      const resolved = path.resolve(filePath);
      return Object.values(this.state.scans).some(s => {
        if (s.id === excludeScanId) return false;
        const v = s.videoPath ? path.resolve(s.videoPath) : '';
        const p = s.proxyPath ? path.resolve(s.proxyPath) : '';
        const t = s.thumbnailPath ? path.resolve(s.thumbnailPath) : '';
        return v === resolved || p === resolved || t === resolved;
      });
    }
  };

  public evidence: IEvidenceRepository = {
    saveEvidence: async (scanId: string, items: EvidenceItem[], leaseToken?: LeaseFencingToken) => {
      this.validateLeaseFence(scanId, leaseToken);
      this.state.evidence[scanId] = items;
      this.save();
    },
    getEvidence: async (scanId: string) => {
      return this.state.evidence[scanId] || [];
    }
  };

  public usage: IUsageRepository = {
    recordUsage: async (userId: string, scanId: string, durationMinutes: number, creditsDeducted: number, mode: string, leaseToken?: LeaseFencingToken) => {
      this.validateLeaseFence(scanId, leaseToken);
      const exists = this.state.usage.some(u => u.scanId === scanId);
      if (exists) {
        return;
      }
      this.state.usage.push({
        userId,
        scanId,
        durationMinutes,
        creditsDeducted,
        mode,
        timestamp: new Date().toISOString()
      });
      this.save();
    },
    getUsageStats: async (userId: string) => {
      const records = this.state.usage.filter(u => u.userId === userId);
      const totalMinutes = records.reduce((acc, curr) => acc + curr.durationMinutes, 0);
      const totalCredits = records.reduce((acc, curr) => acc + curr.creditsDeducted, 0);
      return { totalMinutes, totalCredits, scanCount: records.length };
    }
  };

  public billing: IBillingRepository = {
    getPlans: async () => {
      return [
        {
          id: 'free',
          name: 'Free Trial',
          priceUsd: 0,
          period: 'one-time',
          credits: 10,
          costPerMinuteStandard: 'Free (10 mins)',
          features: [
            'Up to 1080p Full HD scans',
            'Standard Scan engine',
            'Full evidence timeline',
            'Explainable risk report',
            '10 total input minutes'
          ]
        },
        {
          id: 'creator',
          name: 'Creator',
          priceUsd: 9,
          period: 'month',
          credits: 30,
          costPerMinuteStandard: '$0.30 / min',
          features: [
            '30 input minutes per month',
            'Standard & Deep Scan modes',
            '4K with 1080p proxy decode',
            'Re-scan comparison engine',
            'Exportable PDF & JSON reports',
            'Metadata coherence analysis'
          ],
          highlight: true
        },
        {
          id: 'pro',
          name: 'Pro Studio',
          priceUsd: 19,
          period: 'month',
          credits: 75,
          costPerMinuteStandard: '$0.25 / min',
          features: [
            '75 input minutes per month',
            'Prioritized analysis queue',
            'Deep cross-segment pattern audit',
            'Unlimited re-scan comparisons',
            'AI disclosure flag check',
            'Advertiser-friendly deep flags'
          ]
        },
        {
          id: 'agency',
          name: 'Agency & MCN',
          priceUsd: 99,
          period: 'month',
          credits: 600,
          costPerMinuteStandard: '$0.16 / min',
          features: [
            '600 input minutes per month',
            'Multiple channel workflows',
            'Bulk upload analysis',
            'Dedicated processing throughput',
            'Direct developer API access',
            'Priority support'
          ]
        },
        {
          id: 'audit_once',
          name: 'One-time Audit',
          priceUsd: 29,
          period: 'one-time',
          credits: 60,
          costPerMinuteStandard: '$0.48 / min',
          features: [
            '60 input minutes (never expires)',
            'Standard or Deep scan',
            'Full fix recommendations',
            'Includes 2 re-scan comparisons'
          ]
        }
      ];
    },

    isEventProcessed: async (eventId: string) => {
      return !!this.state.webhookEvents[eventId];
    },

    markEventProcessed: async (record: WebhookEventRecord) => {
      this.state.webhookEvents[record.eventId] = record;
      this.save();
    },

    saveSubscription: async (sub: SubscriptionRecord) => {
      this.state.subscriptions[sub.id] = sub;
      this.save();
    },

    getSubscription: async (id: string) => {
      return this.state.subscriptions[id] || null;
    },

    getSubscriptionsByUserId: async (userId: string) => {
      return Object.values(this.state.subscriptions).filter(s => s.userId === userId);
    }
  };

  public channelProfiles: IChannelProfileRepository = {
    getProfile: async (userId: string) => {
      return this.state.channelProfiles[userId] || null;
    },
    saveProfile: async (userId: string, data: Partial<ChannelContextProfile>) => {
      const existing = this.state.channelProfiles[userId];
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
      this.state.channelProfiles[userId] = profile;
      this.save();
      return profile;
    },
    deleteProfile: async (userId: string) => {
      if (this.state.channelProfiles[userId]) {
        delete this.state.channelProfiles[userId];
        this.save();
        return true;
      }
      return false;
    }
  };

  public uploads: IUploadRepository = {
    recordUpload: async (upload: UploadRecord) => {
      this.state.uploads[upload.fileId] = upload;
      this.save();
      return upload;
    },
    getUpload: async (fileId: string) => {
      return this.state.uploads[fileId] || null;
    },
    getUploadByPath: async (filePath: string) => {
      const resolved = path.resolve(filePath);
      return Object.values(this.state.uploads).find(u => path.resolve(u.filePath) === resolved) || null;
    },
    deleteUpload: async (fileId: string) => {
      if (this.state.uploads[fileId]) {
        delete this.state.uploads[fileId];
        this.save();
        return true;
      }
      return false;
    }
  };

  public passwordReset: IPasswordResetRepository = {
    createResetToken: async (userId: string, tokenHash: string, expiresAt: string): Promise<void> => {
      this.state.passwordResets[tokenHash] = {
        tokenHash,
        userId,
        expiresAt,
        usedAt: null,
        createdAt: new Date().toISOString()
      };
      this.save();
    },

    getResetToken: async (tokenHash: string): Promise<PasswordResetRecord | null> => {
      return this.state.passwordResets[tokenHash] || null;
    },

    markTokenUsed: async (tokenHash: string): Promise<boolean> => {
      const rec = this.state.passwordResets[tokenHash];
      if (rec && !rec.usedAt) {
        rec.usedAt = new Date().toISOString();
        this.save();
        return true;
      }
      return false;
    },

    revokeAllUserSessions: async (userId: string): Promise<void> => {
      for (const [token, sess] of Object.entries(this.state.sessions)) {
        if (sess.userId === userId) {
          delete this.state.sessions[token];
        }
      }
      this.save();
    },

    checkRateLimit: async (key: string, action: string, limit: number, windowSeconds: number): Promise<boolean> => {
      const now = Math.floor(Date.now() / 1000);
      const windowStart = now - windowSeconds;
      this.state.rateLimits = this.state.rateLimits.filter(e => e.timestamp >= windowStart);

      const recent = this.state.rateLimits.filter(e => e.key === key && e.action === action);
      if (recent.length >= limit) {
        return false;
      }

      this.state.rateLimits.push({ key, action, timestamp: now });
      return true;
    }
  };

  public queue: IJobQueueRepository = {
    enqueueJob: async (scanId: string, runAt?: string): Promise<JobQueueRecord> => {
      const now = new Date().toISOString();
      const existing = this.state.jobQueue[scanId];
      if (existing) {
        // Idempotent: repeated enqueue requests must NOT reset RUNNING or terminal jobs to QUEUED
        return existing;
      }

      const rec: JobQueueRecord = {
        id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        scanId,
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 3,
        runAt: runAt || now,
        createdAt: now,
        updatedAt: now
      };
      this.state.jobQueue[scanId] = rec;
      this.save();
      return rec;
    },

    claimNextJob: async (workerId: string, leaseDurationMs: number = 60000): Promise<JobQueueRecord | null> => {
      const now = new Date();
      const nowIso = now.toISOString();

      const candidate = Object.values(this.state.jobQueue).find(
        j => (j.status === 'QUEUED' || j.status === 'RETRYABLE') && j.runAt <= nowIso
      );

      if (!candidate) return null;

      const leaseToken = `lease_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
      candidate.status = 'RUNNING';
      candidate.attempts += 1;
      candidate.lockedAt = nowIso;
      candidate.lockedBy = workerId;
      candidate.leaseToken = leaseToken;
      candidate.leaseDurationMs = leaseDurationMs;
      candidate.leaseExpiresAt = leaseExpiresAt;
      candidate.updatedAt = nowIso;
      this.save();
      return candidate;
    },

    completeJob: async (id: string, workerId?: string, leaseToken?: string): Promise<void> => {
      if (!leaseToken || typeof leaseToken !== 'string' || leaseToken.trim() === '') {
        throw new FencingError(`Cannot complete job ${id}: worker lease token is required`);
      }
      const job = Object.values(this.state.jobQueue).find(j => j.id === id);
      if (!job || job.status !== 'RUNNING' || job.leaseToken !== leaseToken || (workerId && job.lockedBy !== workerId)) {
        throw new FencingError(`Failed to complete job ${id}: lease token expired or superseded`);
      }
      job.status = 'COMPLETED';
      job.lockedAt = null;
      job.lockedBy = null;
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.updatedAt = new Date().toISOString();
      this.save();
    },

    failJob: async (id: string, error: string, retryable: boolean, backoffMs: number = 5000, workerId?: string, leaseToken?: string): Promise<void> => {
      if (!leaseToken || typeof leaseToken !== 'string' || leaseToken.trim() === '') {
        throw new FencingError(`Cannot fail job ${id}: worker lease token is required`);
      }
      const job = Object.values(this.state.jobQueue).find(j => j.id === id);
      if (!job || job.status !== 'RUNNING' || job.leaseToken !== leaseToken || (workerId && job.lockedBy !== workerId)) {
        throw new FencingError(`Failed to fail job ${id}: lease token expired or superseded`);
      }
      const now = new Date();
      job.status = retryable ? 'RETRYABLE' : 'FAILED';
      job.runAt = new Date(now.getTime() + backoffMs).toISOString();
      job.lockedAt = null;
      job.lockedBy = null;
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.lastError = error;
      job.updatedAt = now.toISOString();
      this.save();
    },

    recoverStaleJobs: async (leaseTimeoutMs: number = 60000): Promise<number> => {
      if (leaseTimeoutMs === undefined || leaseTimeoutMs === null) {
        leaseTimeoutMs = 60000;
      }
      if (typeof leaseTimeoutMs !== 'number' || !Number.isFinite(leaseTimeoutMs) || leaseTimeoutMs <= 0) {
        throw new Error(`Invalid leaseTimeoutMs: must be a positive finite number (received: ${leaseTimeoutMs})`);
      }
      const cutoff = new Date(Date.now() - leaseTimeoutMs).toISOString();
      const now = new Date().toISOString();
      let recovered = 0;
      for (const job of Object.values(this.state.jobQueue)) {
        if (job.status === 'RUNNING' && ((job.leaseExpiresAt && job.leaseExpiresAt <= now) || (job.lockedAt && job.lockedAt <= cutoff))) {
          job.status = 'RETRYABLE';
          job.lockedAt = null;
          job.lockedBy = null;
          job.leaseToken = null;
          job.leaseExpiresAt = null;
          job.updatedAt = now;
          recovered++;
        }
      }
      if (recovered > 0) this.save();
      return recovered;
    },

    renewLease: async (id: string, workerId: string, leaseToken?: string, leaseDurationMs: number = 60000): Promise<boolean> => {
      if (!leaseToken || typeof leaseToken !== 'string' || leaseToken.trim() === '') {
        throw new FencingError(`Cannot renew lease for job ${id}: worker lease token is required`);
      }
      const job = Object.values(this.state.jobQueue).find(j => j.id === id);
      if (job && job.status === 'RUNNING' && job.lockedBy === workerId && job.leaseToken === leaseToken) {
        const now = new Date().toISOString();
        const duration = Math.min(Math.max(leaseDurationMs || 60000, 1000), 24 * 60 * 60 * 1000);
        job.lockedAt = now;
        job.leaseDurationMs = duration;
        job.leaseExpiresAt = new Date(Date.now() + duration).toISOString();
        job.updatedAt = now;
        this.save();
        return true;
      }
      return false;
    },

    retryJob: async (scanId: string): Promise<JobQueueRecord> => {
      const job = this.state.jobQueue[scanId];
      if (!job) {
        throw new Error(`Job for scan ${scanId} not found`);
      }
      if (job.status === 'RUNNING' || job.status === 'QUEUED') {
        throw new Error(`Cannot retry active or queued job for scan ${scanId} (status: ${job.status})`);
      }
      if (job.status === 'COMPLETED') {
        throw new Error(`Cannot retry completed job for scan ${scanId}; please initiate an explicit re-scan instead`);
      }
      const now = new Date().toISOString();
      job.status = 'QUEUED';
      job.attempts = 0;
      job.runAt = now;
      job.lockedAt = null;
      job.lockedBy = null;
      job.leaseToken = null;
      job.lastError = null;
      job.updatedAt = now;

      const scan = this.state.scans[scanId];
      if (scan) {
        scan.status = 'QUEUED';
        scan.error = undefined;
      }

      this.save();
      return job;
    },

    getJobByScanId: async (scanId: string): Promise<JobQueueRecord | null> => {
      return this.state.jobQueue[scanId] || null;
    }
  };

  public async getOperationalMetrics(): Promise<OperationalMetrics> {
    const totalScans = Object.keys(this.state.scans).length;
    const completedScans = Object.values(this.state.scans).filter(s => s.status === 'COMPLETED').length;
    const failedScans = Object.values(this.state.scans).filter(s => s.status === 'FAILED').length;

    const reports = Object.values(this.state.reports);
    let totalProcSec = 0;
    let inspMs = 0;
    let audioMs = 0;
    let videoMs = 0;
    let policyMs = 0;
    let reportCount = 0;

    for (const r of reports) {
      if (r.benchmarkMetrics) {
        totalProcSec += r.benchmarkMetrics.totalProcessingSeconds || 0;
        inspMs += r.benchmarkMetrics.inspectionMs || 0;
        audioMs += r.benchmarkMetrics.audioProcessingMs || 0;
        videoMs += r.benchmarkMetrics.videoAnalysisMs || 0;
        policyMs += r.benchmarkMetrics.policyReasoningMs || 0;
        reportCount++;
      }
    }

    const totalMin = this.state.usage.reduce((sum, u) => sum + u.durationMinutes, 0);

    return {
      totalScans,
      completedScans,
      failedScans,
      averageProcessingSeconds: reportCount > 0 ? parseFloat((totalProcSec / reportCount).toFixed(2)) : 0,
      totalDurationSecondsScanned: Math.round(totalMin * 60),
      estimatedComputeCostUsd: parseFloat((totalMin * 0.005).toFixed(4)),
      estimatedStorageCostUsd: parseFloat((reportCount * 0.001).toFixed(4)),
      measuredStageAveragesMs: {
        inspection: reportCount > 0 ? Math.round(inspMs / reportCount) : 0,
        audio: reportCount > 0 ? Math.round(audioMs / reportCount) : 0,
        video: reportCount > 0 ? Math.round(videoMs / reportCount) : 0,
        policy: reportCount > 0 ? Math.round(policyMs / reportCount) : 0
      }
    };
  }

  public async close(): Promise<void> {
    // In-memory does not require socket cleanup
  }
}

export { SqliteStorageRepository, migrateJsonToSqlite } from './sqliteStorage';
import { SqliteStorageRepository, migrateJsonToSqlite } from './sqliteStorage';

export function createStorage(customPath?: string): IStorageRepository {
  if (process.env.STORAGE_ENGINE === 'memory') {
    return new InMemoryStorageRepository(customPath);
  }
  return new SqliteStorageRepository(customPath);
}

// Default system-of-record storage instance:
// Uses durable SQLite in production, with seamless migration from legacy store.json if present.
function initializeDefaultStorage(): IStorageRepository {
  if (process.env.STORAGE_ENGINE === 'memory') {
    return new InMemoryStorageRepository();
  }

  const dbPath = process.env.DATABASE_PATH || path.resolve(process.cwd(), 'data', 'videorisk.db');
  const sqliteRepo = new SqliteStorageRepository(dbPath);

  // Auto-migrate legacy JSON storage if present and SQLite has 0 users
  const legacyJsonPath = process.env.STORE_PATH || path.resolve(process.cwd(), 'data', 'store.json');
  if (fs.existsSync(legacyJsonPath)) {
    try {
      const userCount = (sqliteRepo.db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
      if (userCount <= 3) { // only seed accounts or empty
        const migrationResult = migrateJsonToSqlite(legacyJsonPath, sqliteRepo);
        if (migrationResult.migratedUsers > 0 || migrationResult.migratedScans > 0) {
          console.log(`[Storage] Safely migrated legacy JSON store to SQLite: ${migrationResult.migratedUsers} users, ${migrationResult.migratedScans} scans, backup created at ${migrationResult.backupPath}`);
        }
      }
    } catch (migErr) {
      console.warn('[Storage] Legacy migration check skipped:', migErr);
    }
  }

  return sqliteRepo;
}

export const storage = initializeDefaultStorage();
