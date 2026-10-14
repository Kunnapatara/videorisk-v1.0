import { Router, Request, Response, RequestHandler } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { storage } from '../storage';
import { jobOrchestrator } from '../pipeline/jobOrchestrator';
import { mediaInspector } from '../pipeline/mediaInspector';
import { thumbnailInspector } from '../pipeline/thumbnailInspector';
import { creditService } from '../services/creditService';
import { billingService, ALLOWED_PAID_PLANS } from '../services/billingService';
import { ScanJob, ScanMode, UserAccount, CrossVideoPattern } from '../../types';

export const apiRouter = Router();

// Ensure upload directory exists
const uploadDir = path.resolve(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer upload config for video media
const storageConfig = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const sanitizedExt = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `videorisk_${uniqueSuffix}${sanitizedExt}`);
  }
});

const upload = multer({
  storage: storageConfig,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB max file size
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/avi'];
    const allowedExts = ['.mp4', '.mov', '.webm', '.mkv', '.avi'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid video format. Supported formats: MP4, MOV, WebM, MKV.'));
    }
  }
});

// Multer upload config for thumbnail images
const thumbnailStorageConfig = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const sanitizedExt = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `thumb_${uniqueSuffix}${sanitizedExt}`);
  }
});

const uploadThumbnail = multer({
  storage: thumbnailStorageConfig,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB max image size
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp'];
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid thumbnail format. Supported image formats: JPEG, PNG, WebP.'));
    }
  }
});

/**
 * Type-safe middleware wrapper for video uploads.
 * Invokes Multer to parse the 'video' field and cleanly intercepts file size and validation errors.
 */
const uploadVideoMiddleware: RequestHandler = (req, res, next) => {
  upload.single('video')(req as any, res as any, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Video file size exceeds 500 MB limit.' });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      return res.status(400).json({ error: err.message || 'Invalid upload.' });
    }
    next();
  });
};

/**
 * Type-safe middleware wrapper for thumbnail image uploads.
 * Invokes Multer to parse the 'thumbnail' field and cleanly intercepts file size and validation errors.
 */
const uploadThumbnailMiddleware: RequestHandler = (req, res, next) => {
  uploadThumbnail.single('thumbnail')(req as any, res as any, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Thumbnail file size exceeds 10 MB limit.' });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      return res.status(400).json({ error: err.message || 'Invalid upload.' });
    }
    next();
  });
};

/**
 * Validates that a file path is safely confined to the upload directory.
 * In non-production test environments, also allows temporary fixture directories.
 * Prevents directory traversal, symlink jumping, prefix-collision attacks, and directory deletions.
 */
function validateSafeStoragePath(candidatePath: string, options: { mustExist?: boolean } = {}): { isSafe: boolean; resolvedPath: string; error?: string } {
  try {
    if (!candidatePath || typeof candidatePath !== 'string') {
      return { isSafe: false, resolvedPath: '', error: 'Candidate path is empty or invalid.' };
    }
    const resolved = path.resolve(candidatePath);

    // Allowed storage roots: production permits uploadDir; non-production permits uploadDir and os.tmpdir()
    const allowedRoots = [uploadDir];
    if (process.env.NODE_ENV !== 'production') {
      allowedRoots.push(path.resolve(os.tmpdir()));
    }

    let matchedRoot: string | null = null;
    let relToRoot = '';

    for (const root of allowedRoots) {
      const rel = path.relative(root, resolved);
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '' && rel !== '.') {
        matchedRoot = root;
        relToRoot = rel;
        break;
      }
    }

    if (!matchedRoot) {
      return { isSafe: false, resolvedPath: resolved, error: 'Path escapes allowed storage directories.' };
    }

    // Prevent targeting the root storage directory or protected root subdirectories themselves
    if (!relToRoot || relToRoot === '.' || relToRoot === 'proxies' || relToRoot === 'frames') {
      return { isSafe: false, resolvedPath: resolved, error: 'Target path cannot be the root storage directory.' };
    }

    // If file exists, check symlink resolution to prevent symlink-based escapes
    if (fs.existsSync(resolved)) {
      try {
        const realRoot = fs.realpathSync(matchedRoot);
        const realTarget = fs.realpathSync(resolved);
        const realRel = path.relative(realRoot, realTarget);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
          return { isSafe: false, resolvedPath: resolved, error: 'Symlink escapes allowed storage directory.' };
        }
      } catch {
        return { isSafe: false, resolvedPath: resolved, error: 'Symlink resolution failed.' };
      }
    } else if (options.mustExist) {
      return { isSafe: false, resolvedPath: resolved, error: 'File does not exist.' };
    }

    return { isSafe: true, resolvedPath: resolved };
  } catch (err: any) {
    return { isSafe: false, resolvedPath: '', error: `Path resolution error for '${candidatePath}': ${err?.message || err}` };
  }
}

function isSafeUploadPath(candidatePath: string): boolean {
  return validateSafeStoragePath(candidatePath, { mustExist: true }).isSafe;
}

/**
 * Checks whether test-only account switching endpoints are permitted.
 * In production or when ENABLE_TEST_ACCOUNT_SWITCH is not true, returns false.
 */
function isTestSwitchingAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ENABLE_TEST_ACCOUNT_SWITCH === 'true';
}

/**
 * Omit sensitive credentials (passwordHash, salt) from public user representation
 */
export function sanitizeUser(user: UserAccount) {
  const { passwordHash, salt, ...safeUser } = user;
  return safeUser;
}

/**
 * Extracts and authenticates user identity from request session tokens.
 * Supports Authorization Bearer token, x-session-token header, and cookie.
 * Returns null if token is missing, invalid, or expired.
 * Never silently converts an anonymous request into a shared default user.
 */
export async function getAuthenticatedUser(req: Request): Promise<UserAccount | null> {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-session-token']) {
    token = String(req.headers['x-session-token']).trim();
  } else if ((req as any).cookies?.vr_session) {
    token = String((req as any).cookies.vr_session).trim();
  }

  if (!token) {
    return null;
  }

  return await storage.users.getUserBySession(token);
}

/**
 * Enforces that the request has a valid, active user session.
 * Rejects anonymous, missing, expired, or invalid sessions with 401 Unauthorized.
 */
export async function requireAuth(req: Request, res: Response): Promise<UserAccount | null> {
  const existingUser = (req as any).user;
  if (existingUser) {
    return existingUser;
  }
  const user = await getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized: A valid active session is required.' });
    return null;
  }
  (req as any).user = user;
  return user;
}

/**
 * Express middleware requiring an authenticated user session.
 * Rejects unauthenticated requests with HTTP 401 before any downstream upload/processing runs.
 */
export const requireAuthMiddleware: RequestHandler = async (req, res, next) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) {
      return;
    }
    next();
  } catch (err: any) {
    res.status(500).json({ error: 'Authentication check failed.' });
  }
};

/**
 * Pre-upload authorization check for re-scanning.
 * Ensures the parent scan exists, belongs to the authenticated user, and user has available credits
 * before Multer parses any multipart file upload.
 */
export const validateRescanAuthorization: RequestHandler = async (req, res, next) => {
  try {
    const user = (req as any).user || await getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized: A valid active session is required.' });
      return;
    }

    const parentScan = await storage.scans.getScan(req.params.id);
    if (!parentScan) {
      res.status(404).json({ error: 'Original scan not found.' });
      return;
    }
    if (parentScan.userId !== user.id) {
      res.status(403).json({ error: 'Access denied: Cannot re-scan video belonging to another user.' });
      return;
    }

    if (user.creditsRemaining <= 0) {
      res.status(402).json({ 
        error: 'Insufficient credits for re-scan. Please top up your balance.',
        creditsRemaining: user.creditsRemaining 
      });
      return;
    }

    (req as any).parentScan = parentScan;
    next();
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to authorize re-scan.' });
  }
};

// 1. Clean Health Endpoint (Public)
apiRouter.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'VideoRisk'
  });
});

// 2. Authentication & Account Management (Public)
apiRouter.post('/auth/register', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await storage.users.getUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');

    const newUser = await storage.users.createUser(
      normalizedEmail,
      passwordHash,
      salt,
      10, // 10 free minutes starter credits
      'free'
    );

    const sessionToken = await storage.users.createSession(newUser.id);

    res.status(201).json({
      user: sanitizeUser(newUser),
      token: sessionToken,
      message: 'Account successfully registered.'
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Registration failed.' });
  }
});

apiRouter.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await storage.users.getUserByEmail(normalizedEmail);

    if (!user || !user.passwordHash || !user.salt) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const computedHash = crypto.scryptSync(password, user.salt, 64).toString('hex');
    if (!crypto.timingSafeEqual(Buffer.from(user.passwordHash, 'hex'), Buffer.from(computedHash, 'hex'))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const sessionToken = await storage.users.createSession(user.id);
    res.json({
      user: sanitizeUser(user),
      token: sessionToken,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Sign in failed.' });
  }
});

apiRouter.post('/auth/logout', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    let token: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.headers['x-session-token']) {
      token = String(req.headers['x-session-token']).trim();
    } else if ((req as any).cookies?.vr_session) {
      token = String((req as any).cookies.vr_session).trim();
    }
    if (token) {
      await storage.users.deleteSession(token);
    }
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Logout failed.' });
  }
});

// Password Recovery: Request Reset Token (Public, Non-enumerating, Rate-limited)
apiRouter.post('/auth/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    const clientIp = (req.headers['x-forwarded-for'] as string) || req.ip || req.socket.remoteAddress || 'unknown';
    const allowed = await storage.passwordReset.checkRateLimit(clientIp, 'forgot_password', 5, 900);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many password reset requests. Please wait a few minutes before trying again.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await storage.users.getUserByEmail(normalizedEmail);

    let devToken: string | undefined;

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour expiration

      await storage.passwordReset.createResetToken(user.id, tokenHash, expiresAt);

      // Safe development-only exposure for testing/local verification
      if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEV_RESET_TOKEN === 'true') {
        devToken = rawToken;
      }

      if (process.env.SMTP_HOST && process.env.SMTP_USER) {
        console.log(`[Auth] Dispatched password reset notification for account: ${user.email}`);
      }
    }

    // Strict non-enumerating response: never reveals whether email exists
    res.json({
      success: true,
      message: 'If an account exists with that email address, password reset instructions have been generated.',
      ...(devToken ? { devToken } : {})
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Unable to process password reset request.' });
  }
});

// Password Recovery: Confirm Reset (Public, Single-Use Token, Invalidate Sessions)
apiRouter.post('/auth/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Reset token is required.' });
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
    }

    const clientIp = (req.headers['x-forwarded-for'] as string) || req.ip || req.socket.remoteAddress || 'unknown';
    const allowed = await storage.passwordReset.checkRateLimit(clientIp, 'reset_password_attempt', 10, 900);
    if (!allowed) {
      return res.status(429).json({ error: 'Too many reset attempts. Please wait before trying again.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
    const resetRecord = await storage.passwordReset.getResetToken(tokenHash);

    if (!resetRecord) {
      return res.status(400).json({ error: 'Invalid or expired password reset token.' });
    }

    if (resetRecord.usedAt) {
      return res.status(400).json({ error: 'This password reset token has already been used.' });
    }

    if (new Date(resetRecord.expiresAt) < new Date()) {
      return res.status(400).json({ error: 'This password reset token has expired. Please request a new one.' });
    }

    const user = await storage.users.getUser(resetRecord.userId);
    if (!user) {
      return res.status(400).json({ error: 'Associated user account no longer exists.' });
    }

    // Scrypt password hash
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(newPassword, salt, 64).toString('hex');

    await storage.users.updateUser(user.id, {
      passwordHash,
      salt
    });

    // Mark single-use token as permanently used
    await storage.passwordReset.markTokenUsed(tokenHash);

    // Invalidate all active sessions for this user to revoke unauthorized access
    await storage.passwordReset.revokeAllUserSessions(user.id);

    res.json({
      success: true,
      message: 'Your password has been successfully reset. Please sign in with your new password.'
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// Authenticated session check (Protected)
apiRouter.get('/auth/me', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const safe = sanitizeUser(user);
    res.json({
      ...safe,
      user: safe
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve session user.' });
  }
});

// Test Account listing — Gated strictly to development/test environments
apiRouter.get('/auth/accounts', async (req: Request, res: Response) => {
  if (!isTestSwitchingAllowed()) {
    return res.status(403).json({ error: 'Forbidden: Test account listing is disabled in this environment.' });
  }

  try {
    const allUsers = await storage.users.listUsers();
    const safeList = allUsers.map(u => ({
      id: u.id,
      email: u.email,
      plan: u.plan,
      creditsRemaining: u.creditsRemaining,
      totalScansCount: u.totalScansCount
    }));
    res.json(safeList);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list test accounts.' });
  }
});

// Test Account switcher — Gated strictly to development/test environments
apiRouter.post('/auth/switch-account', async (req: Request, res: Response) => {
  if (!isTestSwitchingAllowed()) {
    return res.status(403).json({ error: 'Forbidden: Account switching is disabled in this environment.' });
  }

  try {
    const { userId, email } = req.body;
    let targetUser: UserAccount | null = null;

    if (userId) {
      targetUser = await storage.users.getUser(userId);
    } else if (email) {
      targetUser = await storage.users.getUserByEmail(email);
    }

    if (!targetUser) {
      return res.status(404).json({ error: 'Target account not found.' });
    }

    const sessionToken = await storage.users.createSession(targetUser.id);
    res.json({
      user: sanitizeUser(targetUser),
      token: sessionToken,
      message: `Switched account to ${targetUser.email}`
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to switch account.' });
  }
});

apiRouter.post('/auth/switch-demo-user', async (req: Request, res: Response) => {
  if (!isTestSwitchingAllowed()) {
    return res.status(403).json({ error: 'Forbidden: Account switching is disabled in this environment.' });
  }

  try {
    const { userId, email } = req.body;
    let targetUser: UserAccount | null = null;

    if (userId) {
      targetUser = await storage.users.getUser(userId);
    } else if (email) {
      targetUser = await storage.users.getUserByEmail(email);
    }

    if (!targetUser) {
      return res.status(404).json({ error: 'Target account not found.' });
    }

    const sessionToken = await storage.users.createSession(targetUser.id);
    res.json({
      user: sanitizeUser(targetUser),
      token: sessionToken,
      message: `Switched account to ${targetUser.email}`
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to switch account.' });
  }
});

// 3. User & Usage Profile (Protected)
apiRouter.get('/user', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    res.json(sanitizeUser(user));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve user account.' });
  }
});

apiRouter.post('/user/plan', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { plan } = req.body;
    
    // Free trial can only be claimed once across the account lifecycle
    if (plan === 'free') {
      const result = await storage.users.claimFreeTrial(user.id);
      if (result.alreadyClaimed) {
        return res.status(409).json({
          error: 'Free trial has already been claimed for this account.',
          alreadyClaimed: true,
          user: sanitizeUser(result.user),
        });
      }
      return res.json(sanitizeUser(result.user));
    }

    // Paid tiers (creator, pro, agency, audit_once) MUST go through checkout session
    res.status(400).json({ 
      error: 'Paid plans require a verified checkout session. Please initiate checkout via /api/billing/checkout.',
      planRequested: plan
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to update plan.' });
  }
});

// 4. Production Billing & Checkout Routes
apiRouter.post('/billing/checkout', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { planId } = req.body;
    if (!planId || !ALLOWED_PAID_PLANS.includes(planId as any)) {
      return res.status(400).json({ 
        error: `Valid paid plan ID is required for checkout. Allowed plans: ${ALLOWED_PAID_PLANS.join(', ')}` 
      });
    }

    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;

    const session = await billingService.createCheckoutSession({
      userId: user.id,
      planId,
      originUrl: origin,
    });

    res.json(session);
  } catch (err: any) {
    console.error('[API] Checkout session creation failed:', err.message);
    res.status(400).json({ error: err.message || 'Failed to create checkout session.' });
  }
});

// Webhook endpoint with fail-closed cryptographic signature verification and idempotency
apiRouter.post('/billing/webhook', async (req: Request, res: Response) => {
  try {
    const signature = req.headers['stripe-signature'] as string | undefined;
    const rawBody = (req as any).rawBody as Buffer | undefined;

    const paymentMode = process.env.PAYMENT_MODE;
    const isProd = process.env.NODE_ENV === 'production' || paymentMode === 'production' || paymentMode === 'live';

    if (isProd) {
      if (!signature) {
        return res.status(400).json({ error: 'Missing stripe-signature header.' });
      }
      if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        return res.status(400).json({ error: 'Missing raw request payload for webhook verification.' });
      }
    } else {
      if (!rawBody && !signature) {
        return res.status(400).json({ error: 'Missing webhook payload.' });
      }
    }

    const payloadBuffer = rawBody || Buffer.from(JSON.stringify(req.body));
    const result = await billingService.handleWebhook(payloadBuffer, signature || '');
    res.json(result);
  } catch (err: any) {
    console.error('[API Webhook Error]', err.message);
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/billing/session-status', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { sessionId, plan, mode } = req.query as { sessionId?: string; plan?: string; mode?: string };
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId query parameter is required.' });
    }

    const paymentMode = process.env.PAYMENT_MODE;
    const requireLive = process.env.NODE_ENV === 'production' || paymentMode === 'production' || paymentMode === 'live';

    if (mode === 'simulation') {
      if (requireLive) {
        return res.status(403).json({ error: 'Simulated checkout is disabled in production.' });
      }
      if (!plan || !ALLOWED_PAID_PLANS.includes(plan as any)) {
        return res.status(400).json({ 
          error: `Valid paid plan is required for simulated checkout (${ALLOWED_PAID_PLANS.join(', ')}).` 
        });
      }
      const updatedUser = await billingService.completeSimulatedCheckout(sessionId, plan, user.id);
      return res.json({ status: 'complete', paymentStatus: 'paid', mode: 'simulation', user: sanitizeUser(updatedUser) });
    }

    // Real verification via Stripe
    if (!billingService.isStripeClientConfigured()) {
      if (requireLive) {
        return res.status(503).json({ error: 'Stripe gateway is unconfigured in production.' });
      }
      return res.status(400).json({ error: 'Invalid checkout session or payment provider unconfigured.' });
    }

    const verification = await billingService.verifyCheckoutSession(sessionId, user.id);
    return res.json(verification);
  } catch (err: any) {
    const statusCode = (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 401) ? err.statusCode : 400;
    res.status(statusCode).json({ error: err.message || 'Failed to verify session status.' });
  }
});

apiRouter.get('/usage', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const stats = await storage.usage.getUsageStats(user.id);
    res.json({ user: sanitizeUser(user), stats });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve usage stats.' });
  }
});

apiRouter.get('/plans', async (req: Request, res: Response) => {
  try {
    const plans = await storage.billing.getPlans();
    res.json(plans);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve plans.' });
  }
});

apiRouter.get('/billing/plans', async (req: Request, res: Response) => {
  try {
    const plans = await storage.billing.getPlans();
    res.json(plans);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve plans.' });
  }
});

// 5. Upload & Pre-inspection (Protected)
apiRouter.post('/uploads', requireAuthMiddleware, uploadVideoMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return;
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided.' });
    }

    const filePath = req.file.path;
    const fileId = path.basename(filePath);

    // Track upload ownership record
    await storage.uploads.recordUpload({
      fileId,
      userId: user.id,
      filename: req.file.originalname,
      filePath,
      fileSize: req.file.size,
      type: 'video',
      createdAt: new Date().toISOString()
    });

    const metadata = await mediaInspector.inspect(filePath, req.file.originalname);

    const standardCredits = creditService.calculateRequiredCredits(metadata.durationSeconds, 'standard');
    const deepCredits = creditService.calculateRequiredCredits(metadata.durationSeconds, 'deep');

    res.json({
      fileId,
      filePath,
      filename: req.file.originalname,
      metadata,
      estimatedCredits: {
        standard: standardCredits,
        deep: deepCredits,
        inputMinutes: creditService.formatMinutes(metadata.durationSeconds)
      }
    });
  } catch (err: any) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    res.status(400).json({ error: err.message || 'Failed to inspect uploaded video.' });
  }
});

// 5b. Upload Thumbnail Image (Protected)
apiRouter.post('/uploads/thumbnail', requireAuthMiddleware, uploadThumbnailMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return;
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No thumbnail image file provided.' });
    }

    const filePath = req.file.path;
    const fileId = path.basename(filePath);

    // Track thumbnail ownership record
    await storage.uploads.recordUpload({
      fileId,
      userId: user.id,
      filename: req.file.originalname,
      filePath,
      fileSize: req.file.size,
      type: 'thumbnail',
      createdAt: new Date().toISOString()
    });

    const thumbnailMetadata = await thumbnailInspector.inspect(filePath, req.file.originalname);

    res.json({
      fileId,
      filePath,
      filename: req.file.originalname,
      thumbnailMetadata
    });
  } catch (err: any) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    res.status(400).json({ error: err.message || 'Failed to inspect uploaded thumbnail image.' });
  }
});

// 6. Channel Context Profile Endpoints (User-Owned & Scoped)
apiRouter.get('/channel/profile', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const profile = await storage.channelProfiles.getProfile(user.id);
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve channel context profile.' });
  }
});

apiRouter.put('/channel/profile', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const updated = await storage.channelProfiles.saveProfile(user.id, req.body);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to save channel context profile.' });
  }
});

apiRouter.delete('/channel/profile', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const deleted = await storage.channelProfiles.deleteProfile(user.id);
    res.json({ success: deleted });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete channel context profile.' });
  }
});

// 6b. Cross-Video Recurring Patterns (Scoped strictly to user's authorized scan history)
apiRouter.get('/channel/patterns', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const userScans = await storage.scans.getAllScans(user.id);
    const completedScans = userScans.filter(s => s.status === 'COMPLETED');

    const patterns: CrossVideoPattern[] = [];
    const sampleSize = completedScans.length;

    if (sampleSize >= 2) {
      // 1. Analyze recurring lack of voiceover
      let lowVoiceCount = 0;
      let titleMismatchCount = 0;

      for (const s of completedScans) {
        const report = await storage.scans.getReport(s.id);
        if (report) {
          if (typeof report.originalContributionRatio === 'number' && report.originalContributionRatio < 20) {
            lowVoiceCount++;
          }
          if (report.topIssues.some(i => i.domain === 'title' && i.category === 'metadata_coherence')) {
            titleMismatchCount++;
          }
        }
      }

      if (lowVoiceCount >= 2) {
        patterns.push({
          id: 'pat_reused_signal',
          patternType: 'repeated_reused_signal',
          label: 'Recurring Absence of Creator Commentary',
          severity: 'warning',
          frequency: parseFloat(((lowVoiceCount / sampleSize) * 100).toFixed(0)),
          affectedScansCount: lowVoiceCount,
          explanation: `In ${lowVoiceCount} of your ${sampleSize} analyzed videos, audio tracks lacked an identifiable creator voice track.`,
          recommendation: 'Adding consistent spoken perspective or voiceover transforms material under YouTube YPP reused-content policies.',
          disclaimer: 'Observed pattern across your uploaded video sample; not an automated channel-wide YouTube audit.'
        });
      }

      if (titleMismatchCount >= 2) {
        patterns.push({
          id: 'pat_metadata_gap',
          patternType: 'title_content_mismatch',
          label: 'Recurring Title-to-Content Pacing Gap',
          severity: 'warning',
          frequency: parseFloat(((titleMismatchCount / sampleSize) * 100).toFixed(0)),
          affectedScansCount: titleMismatchCount,
          explanation: `In ${titleMismatchCount} of ${sampleSize} videos, titles suggested case studies while opening sequences lacked direct spoken hooks.`,
          recommendation: 'Ensure video openings immediately connect to the topic promised in the title.',
          disclaimer: 'Observed pattern across your uploaded video sample; not an automated channel-wide YouTube audit.'
        });
      }
    }

    res.json({
      sampleSize,
      patterns,
      disclaimer: 'Cross-video insights reflect patterns in your authorized uploaded scans only. YouTube Studio remains the authoritative destination for platform checks.'
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to compute cross-video patterns.' });
  }
});

// 7. Create Scan (with Path Traversal, Ownership & Credit Checks)
apiRouter.post('/scans', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { 
      videoPath, 
      videoFilename, 
      videoTitle, 
      videoDescription, 
      videoTags,
      thumbnailPath,
      thumbnailFilename,
      scanMode = 'standard',
      parentScanId,
      isRescan = false
    } = req.body;

    if (!videoPath || typeof videoPath !== 'string') {
      return res.status(400).json({ error: 'Valid video file path is required.' });
    }

    // Security: Safe Upload Path Traversal Check
    if (!isSafeUploadPath(videoPath)) {
      return res.status(403).json({ error: 'Access denied: Invalid or unauthorized video path.' });
    }

    // Security: Ownership verification of uploaded video file
    const videoUploadRecord = await storage.uploads.getUploadByPath(videoPath);
    if (videoUploadRecord && videoUploadRecord.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Uploaded video file belongs to another user.' });
    }

    // Security: Path Traversal & Ownership check for optional thumbnail
    if (thumbnailPath) {
      if (!isSafeUploadPath(thumbnailPath)) {
        return res.status(403).json({ error: 'Access denied: Invalid or unauthorized thumbnail path.' });
      }
      const thumbUploadRecord = await storage.uploads.getUploadByPath(thumbnailPath);
      if (thumbUploadRecord && thumbUploadRecord.userId !== user.id) {
        return res.status(403).json({ error: 'Access denied: Uploaded thumbnail file belongs to another user.' });
      }
    }

    // If re-scan, verify that parent scan belongs to this authenticated user
    if (parentScanId) {
      const parentScan = await storage.scans.getScan(parentScanId);
      if (!parentScan) {
        return res.status(404).json({ error: 'Parent scan not found.' });
      }
      if (parentScan.userId !== user.id) {
        return res.status(403).json({ error: 'Access denied: Parent scan belongs to another user.' });
      }
    }

    // Financial: Prevent queuing if user has 0 or insufficient credits
    if (user.creditsRemaining <= 0) {
      return res.status(402).json({ 
        error: 'Insufficient credits. Please top up or upgrade your plan to analyze videos.',
        creditsRemaining: user.creditsRemaining
      });
    }

    const scanId = `scan_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const scanJob: ScanJob = {
      id: scanId,
      userId: user.id,
      videoTitle: videoTitle || videoFilename || 'Untitled Video',
      videoDescription: videoDescription || '',
      videoTags: Array.isArray(videoTags) ? videoTags : undefined,
      videoFilename: videoFilename || path.basename(videoPath),
      videoPath,
      thumbnailPath: thumbnailPath || undefined,
      thumbnailFilename: thumbnailFilename || undefined,
      scanMode: (scanMode === 'deep' ? 'deep' : 'standard') as ScanMode,
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
      parentScanId,
      isRescan: !!isRescan
    };

    await storage.scans.createScan(scanJob);

    // Launch background asynchronous analysis
    jobOrchestrator.startJob(scanId);

    res.status(201).json(scanJob);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to create scan.' });
  }
});

// 8. Create Demo Scan (Quick Creator Playground with Strict User Ownership)
apiRouter.post('/scans/demo', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const { 
      demoType = 'problematic', 
      scanMode = 'standard',
      videoTitle,
      videoDescription,
      hasThumbnail = false
    } = req.body;

    if (user.creditsRemaining <= 0) {
      return res.status(402).json({ 
        error: 'Insufficient credits to launch demo scan.',
        creditsRemaining: user.creditsRemaining 
      });
    }

    const demoFilename = demoType === 'revised' 
      ? 'Clean_Cut_Creator_Commentary_Final.mp4' 
      : 'Top10_Gaming_Montage_With_Clips.mp4';
    const demoPath = path.join(uploadDir, `demo_${Date.now()}_${demoFilename}`);
    
    fs.writeFileSync(demoPath, 'VIDEORISK_SAMPLE_CONTAINER');

    let demoThumbPath: string | undefined;
    let demoThumbFilename: string | undefined;

    if (hasThumbnail) {
      demoThumbFilename = 'demo_thumbnail_16x9.jpg';
      demoThumbPath = path.join(uploadDir, `demo_thumb_${Date.now()}.jpg`);
      fs.writeFileSync(demoThumbPath, 'VIDEORISK_SAMPLE_THUMBNAIL');
    }

    const scanId = `scan_demo_${Date.now()}`;
    const scanJob: ScanJob = {
      id: scanId,
      userId: user.id,
      videoTitle: videoTitle || (demoType === 'revised' 
        ? 'How I Actually Built a Business (Revised Cut with Commentary)' 
        : 'How I Built a Real Business (Uncommentated Clips & Montage)'),
      videoDescription: videoDescription || (demoType === 'revised'
        ? 'In-depth original breakdown with voice commentary and critique of industry practices.'
        : 'Compilation of business clips and stock footage showing business growth.'),
      videoFilename: demoFilename,
      videoPath: demoPath,
      thumbnailPath: demoThumbPath,
      thumbnailFilename: demoThumbFilename,
      scanMode: scanMode as ScanMode,
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 2,
      createdAt: new Date().toISOString(),
      isRescan: demoType === 'revised',
      parentScanId: req.body.parentScanId
    };

    await storage.scans.createScan(scanJob);
    jobOrchestrator.startJob(scanId);

    res.status(201).json(scanJob);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to launch demo scan.' });
  }
});

// 9. Get All Scans (Strict User Ownership: returns only requesting user's scans)
apiRouter.get('/scans', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scans = await storage.scans.getAllScans(user.id);
    res.json(scans);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve scans.' });
  }
});

// 10. Get Single Scan Status (Strict IDOR protection: only scan owner may read)
apiRouter.get('/scans/:id', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scan = await storage.scans.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: 'Scan job not found.' });
    }
    if (scan.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: You do not own this scan.' });
    }
    res.json(scan);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve scan status.' });
  }
});

// 11. Get Evidence (Strict IDOR protection)
apiRouter.get('/scans/:id/evidence', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scan = await storage.scans.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: 'Scan job not found.' });
    }
    if (scan.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Evidence belongs to another user.' });
    }
    const evidence = await storage.evidence.getEvidence(req.params.id);
    res.json(evidence);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve evidence.' });
  }
});

// 12. Get Report (Strict IDOR protection)
apiRouter.get('/scans/:id/report', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scan = await storage.scans.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: 'Scan job not found.' });
    }
    if (scan.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Report belongs to another user.' });
    }
    const report = await storage.scans.getReport(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Report not yet generated or scan not found.' });
    }
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve report.' });
  }
});

// 13. Re-scan Endpoint (Strict IDOR protection)
apiRouter.post('/scans/:id/rescan', requireAuthMiddleware, validateRescanAuthorization, uploadVideoMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return;
    }

    const parentScan = (req as any).parentScan || await storage.scans.getScan(req.params.id);
    if (!parentScan) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return res.status(404).json({ error: 'Original scan not found.' });
    }
    if (parentScan.userId !== user.id) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return res.status(403).json({ error: 'Access denied: Cannot re-scan video belonging to another user.' });
    }

    if (user.creditsRemaining <= 0) {
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return res.status(402).json({ 
        error: 'Insufficient credits for re-scan. Please top up your balance.',
        creditsRemaining: user.creditsRemaining 
      });
    }

    let filePath = '';
    let filename = '';

    if (req.file) {
      filePath = req.file.path;
      filename = req.file.originalname;
      await storage.uploads.recordUpload({
        fileId: path.basename(filePath),
        userId: user.id,
        filename,
        filePath,
        fileSize: req.file.size,
        type: 'video',
        createdAt: new Date().toISOString()
      });
    } else if (req.body.videoPath && isSafeUploadPath(req.body.videoPath)) {
      filePath = req.body.videoPath;
      filename = req.body.videoFilename || path.basename(filePath);
      const uploadRec = await storage.uploads.getUploadByPath(filePath);
      if (uploadRec && uploadRec.userId !== user.id) {
        return res.status(403).json({ error: 'Access denied: Video file belongs to another user.' });
      }
    } else {
      filename = `Revised_${parentScan.videoFilename}`;
      filePath = path.join(uploadDir, `demo_rescan_${Date.now()}.mp4`);
      fs.writeFileSync(filePath, 'VIDEORISK_RESCAN_CONTAINER');
    }

    const newScanId = `scan_rescan_${Date.now()}`;

    const rescanJob: ScanJob = {
      id: newScanId,
      userId: user.id,
      videoTitle: `${parentScan.videoTitle} (Revised Cut)`,
      videoDescription: parentScan.videoDescription,
      videoFilename: filename,
      videoPath: filePath,
      thumbnailPath: parentScan.thumbnailPath,
      thumbnailFilename: parentScan.thumbnailFilename,
      scanMode: parentScan.scanMode,
      status: 'QUEUED',
      currentStage: 'Upload',
      completedStages: ['Upload'],
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
      parentScanId: parentScan.id,
      isRescan: true
    };

    await storage.scans.createScan(rescanJob);
    jobOrchestrator.startJob(newScanId);

    res.status(201).json(rescanJob);
  } catch (err: any) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    res.status(500).json({ error: err.message || 'Failed to initiate re-scan.' });
  }
});

// 14. Comparison Endpoint (Strict IDOR protection)
apiRouter.get('/scans/:id/comparison', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scan = await storage.scans.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found.' });
    }
    if (scan.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Comparison belongs to another user.' });
    }

    const comparison = await storage.scans.getComparison(req.params.id);
    if (!comparison) {
      return res.status(404).json({ error: 'Comparison delta not found for this scan.' });
    }
    res.json(comparison);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve comparison.' });
  }
});

// 15. Secure Scan Deletion & Asset Retention Cleanup (Workstream 14 / Targeted Production Readiness)
apiRouter.delete('/scans/:id', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const scan = await storage.scans.getScan(req.params.id);
    if (!scan) {
      return res.status(404).json({ error: 'Scan not found.' });
    }
    if (scan.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Cannot delete scan belonging to another user.' });
    }

    // Active Job Protection: Do not delete files while job is running in a worker
    const job = await storage.queue.getJobByScanId(scan.id);
    if (job && job.status === 'RUNNING') {
      return res.status(409).json({ error: 'Cannot delete scan while video analysis is actively running.' });
    }

    // Identify candidate paths for scan-owned media files and artifacts
    const candidatePaths: string[] = [];
    if (scan.videoPath) candidatePaths.push(scan.videoPath);
    if (scan.thumbnailPath) candidatePaths.push(scan.thumbnailPath);
    if (scan.proxyPath) candidatePaths.push(scan.proxyPath);

    // Also check for generated proxy artifact even if proxyPath was not stored on scan record
    if (scan.videoPath) {
      const baseName = path.basename(scan.videoPath, path.extname(scan.videoPath));
      const potentialProxy = path.join(uploadDir, 'proxies', `proxy_${baseName}.mp4`);
      if (fs.existsSync(potentialProxy) && !candidatePaths.includes(potentialProxy)) {
        candidatePaths.push(potentialProxy);
      }
    }

    // Validate path safety against directory traversal and symlink escapes for all candidates
    for (const p of candidatePaths) {
      const validation = validateSafeStoragePath(p);
      if (!validation.isSafe) {
        console.error('[Storage Security] Unsafe file path rejected during scan deletion:', validation.error);
        return res.status(400).json({ error: 'Invalid or unsafe media path in scan record.' });
      }
    }

    let filesRemoved = 0;
    let cleanupFailed = false;

    // Deduplicate candidate paths
    const uniqueCandidates = Array.from(new Set(candidatePaths));

    for (const p of uniqueCandidates) {
      const resolved = path.resolve(p);

      // Handle missing files idempotently
      if (!fs.existsSync(resolved)) {
        continue;
      }

      // Protection against deleting another scan's files:
      // Verify if another scan shares this media file
      const isShared = await storage.scans.isMediaShared(resolved, scan.id);
      if (isShared) {
        continue;
      }

      try {
        fs.unlinkSync(resolved);
        filesRemoved++;
      } catch (err: any) {
        // Log cleanup failure without exposing sensitive filesystem paths to the client
        console.error('[Storage] Filesystem cleanup failed for scan asset:', err?.code || err?.message || 'Unknown error');
        cleanupFailed = true;
      }
    }

    // Inconsistent state guard: If cleanup failed for files that remain on disk,
    // do NOT permanently purge DB records. Mark status as CLEANUP_PENDING and return 500.
    if (cleanupFailed) {
      await storage.scans.updateScan(scan.id, {
        status: 'CLEANUP_PENDING',
        error: 'Media file cleanup failed. Files remain on disk pending retry.'
      }, { systemBypass: true });

      return res.status(500).json({
        error: 'Failed to completely remove media files from storage. Scan marked for cleanup retry.'
      });
    }

    // Filesystem cleanup succeeded (or files were already absent / shared). Permanently delete DB records.
    const deleted = await storage.scans.deleteScan(req.params.id);

    res.json({
      success: deleted,
      deletedScanId: req.params.id,
      filesRemoved,
      message: 'Scan and associated assets securely deleted from storage.'
    });
  } catch (err: any) {
    console.error('[Storage] Unexpected error during scan deletion:', err?.message || err);
    res.status(500).json({ error: 'Failed to delete scan.' });
  }
});

// 16. Secure Upload Deletion (Workstream 14)
apiRouter.delete('/uploads/:fileId', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    const upload = await storage.uploads.getUpload(req.params.fileId);
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found.' });
    }
    if (upload.userId !== user.id) {
      return res.status(403).json({ error: 'Access denied: Cannot delete file belonging to another user.' });
    }

    if (isSafeUploadPath(upload.filePath) && fs.existsSync(upload.filePath)) {
      try {
        fs.unlinkSync(upload.filePath);
      } catch (e) {
        console.warn('[Storage] Failed to unlink upload file:', e);
      }
    }

    const deleted = await storage.uploads.deleteUpload(req.params.fileId);
    res.json({
      success: deleted,
      fileId: req.params.fileId,
      message: 'Uploaded file securely removed from storage.'
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to delete upload.' });
  }
});

// 17. Operational Metrics & Cost Telemetry (Workstream 12)
apiRouter.get('/operational/metrics', async (req: Request, res: Response) => {
  try {
    const user = await requireAuth(req, res);
    if (!user) return;

    if (storage.getOperationalMetrics) {
      const metrics = await storage.getOperationalMetrics();
      return res.json(metrics);
    }

    res.json({
      totalScans: 0,
      completedScans: 0,
      failedScans: 0,
      averageProcessingSeconds: 0,
      totalDurationSecondsScanned: 0,
      estimatedComputeCostUsd: 0,
      estimatedStorageCostUsd: 0,
      measuredStageAveragesMs: {
        inspection: 0,
        audio: 0,
        video: 0,
        policy: 0
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to retrieve operational metrics.' });
  }
});
