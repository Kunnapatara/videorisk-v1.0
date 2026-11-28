import assert from 'assert';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import { Server } from 'http';
import os from 'os';
import path from 'path';
import {
  enforceTestDatabaseIsolation,
} from '../src/server/storage/testIsolation';
import {
  initializeDefaultStorage,
  resolveLegacyStorePath,
  resolveSqliteDatabasePath,
  storage,
} from '../src/server/storage';
import {
  RATE_LIMIT_POLICY_SPECS,
  resolveConfiguredAppOrigin,
  resolveRateLimitInt,
  validateAppOriginUrl,
  validateStripeSecretKeyFormat,
  validateTrustProxyValue,
} from '../src/server/config/environment';
import { billingService } from '../src/server/services/billingService';
import { resolvePasswordResetAppBaseUrl } from '../src/server/services/emailService';
import { resolveExecutable } from '../src/server/pipeline/binaryResolver';
import { ThumbnailInspector, ThumbnailInspectionError, ThumbnailOcrAdapter } from '../src/server/pipeline/thumbnailInspector';
import { MediaInspector, MediaInspectionError } from '../src/server/pipeline/mediaInspector';
import { ProxyGenerator, ProxyGenerationError } from '../src/server/pipeline/proxyGenerator';
import { AudioProcessor } from '../src/server/pipeline/audioProcessor';
import { VideoProcessor, VideoProcessingError } from '../src/server/pipeline/videoProcessor';
import { apiRouter } from '../src/server/routes/api';
import { runValidatorCli, validateBillingConfiguration } from '../scripts/validate-env';

process.env.VIDEORISK_TEST_RUN = 'true';
enforceTestDatabaseIsolation();

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of keys) {
    snap[key] = process.env[key];
  }
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [key, val] of Object.entries(snap)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function makeFakeExecutableScript(filePath: string, body: string): void {
  fs.writeFileSync(filePath, `#!/usr/bin/env bash\n${body}\n`, { encoding: 'utf8' });
  fs.chmodSync(filePath, 0o755);
}

export async function runConfigIntegrityRemediationTests(): Promise<void> {
  console.log('\n======================================================');
  console.log('--- TEST SUITE 30: CONFIGURATION INTEGRITY REMEDIATION ---');
  console.log('Workstreams 1-8: SQLite Precedence, Origins, Binaries, Rate Limits, Stripe & Env Validation');
  console.log('======================================================');

  const trackedKeys = [
    'NODE_ENV',
    'DEPLOYMENT_ENV',
    'PAYMENT_MODE',
    'PAYMENT_PROVIDER',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_CREATOR',
    'STRIPE_PRICE_PRO',
    'STRIPE_PRICE_AGENCY',
    'STRIPE_PRICE_AUDIT_ONCE',
    'APP_BASE_URL',
    'APP_URL',
    'PUBLIC_APP_URL',
    'ALLOWED_ORIGINS',
    'MEDIA_TOKEN_SECRET',
    'STORAGE_ENGINE',
    'DATABASE_PATH',
    'DATA_DIR',
    'TRUST_PROXY',
    'ALLOW_SIMULATION_WEBHOOK',
    'TESSERACT_PATH',
    'FFMPEG_PATH',
    'FFPROBE_PATH',
    'WHISPER_PATH',
    'LOCAL_STT_PATH',
    'WHISPER_MODEL_PATH',
    'MUSIC_CLASSIFIER_PATH',
    'PATH',
    'AUTH_LOGIN_IP_RATE_LIMIT',
    'AUTH_LOGIN_RATE_LIMIT',
    'AUTH_LOGIN_IP_RATE_WINDOW',
    'AUTH_LOGIN_RATE_WINDOW',
    'AUTH_REGISTER_RATE_LIMIT',
    'AUTH_REGISTRATION_RATE_LIMIT',
    'AUTH_REGISTER_RATE_WINDOW',
    'AUTH_REGISTRATION_RATE_WINDOW',
  ];

  const baselineEnv = snapshotEnv(trackedKeys);
  const tmpRoots: string[] = [];
  const sampleVideoPath = path.resolve(process.cwd(), 'src/server/fixtures/demo/sample_demo_problematic.mp4');
  const sampleThumbPath = path.resolve(process.cwd(), 'src/server/fixtures/demo/sample_demo_thumbnail.jpg');

  try {
    // =========================================================================
    // WORKSTREAM 1: SQLite DATA_DIR and DATABASE_PATH Precedence
    // =========================================================================
    console.log('\n[WS1: SQLite DATA_DIR & DATABASE_PATH Precedence]');
    {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_ws1_'));
      tmpRoots.push(tmpRoot);

      const explicitCustom = path.join(tmpRoot, 'custom.db');
      const envDbPath = path.join(tmpRoot, 'env_override.db');
      const dataDir = path.join(tmpRoot, 'datadir');

      assert.strictEqual(
        resolveSqliteDatabasePath(explicitCustom, { DATABASE_PATH: envDbPath, DATA_DIR: dataDir }),
        path.resolve(explicitCustom),
        'Explicit customPath must take highest precedence'
      );
      assert.strictEqual(
        resolveSqliteDatabasePath(undefined, { DATABASE_PATH: envDbPath, DATA_DIR: dataDir }),
        path.resolve(envDbPath),
        'DATABASE_PATH must take precedence over DATA_DIR'
      );
      assert.strictEqual(
        resolveSqliteDatabasePath(undefined, { DATA_DIR: dataDir }),
        path.resolve(dataDir, 'videorisk.db'),
        'DATA_DIR must resolve <DATA_DIR>/videorisk.db when DATABASE_PATH is absent'
      );
      assert.strictEqual(
        resolveSqliteDatabasePath(undefined, {}),
        path.resolve(process.cwd(), 'data', 'videorisk.db'),
        'Default data/videorisk.db must be preserved when both DATABASE_PATH and DATA_DIR are absent'
      );

      assert.strictEqual(
        resolveLegacyStorePath(undefined, { DATA_DIR: dataDir }),
        path.resolve(dataDir, 'store.json'),
        'resolveLegacyStorePath must respect DATA_DIR fallback'
      );

      // Verify initializeDefaultStorage honors DATA_DIR without falling back to default path
      // (Run in a clean subprocess without VIDEORISK_TEST_RUN so testIsolation's filename guard stays intact)
      const dataDirSub = path.join(tmpRoot, 'init_datadir');
      fs.mkdirSync(dataDirSub, { recursive: true });
      const { execFileSync } = await import('child_process');
      const tsxBin = path.resolve(process.cwd(), 'node_modules', '.bin', 'tsx');
      const probeScript = [
        "import { initializeDefaultStorage } from './src/server/storage';",
        '(async () => {',
        '  const repo: any = initializeDefaultStorage(process.env);',
        "  const wal = repo.db.prepare('PRAGMA journal_mode;').get();",
        "  console.log(JSON.stringify({ dbPath: repo.dbPath, wal: String(wal?.journal_mode || '').toLowerCase() }));",
        '  await repo.close();',
        '})();',
      ].join(' ');
      const probeOut = execFileSync(tsxBin, ['-e', probeScript], {
        cwd: process.cwd(),
        env: {
          PATH: baselineEnv.PATH,
          HOME: process.env.HOME,
          NODE_ENV: 'development',
          DATA_DIR: dataDirSub,
        },
        encoding: 'utf8',
      }).trim();
      const probeParsed = JSON.parse(probeOut.split('\n').pop() || '{}');
      assert.strictEqual(
        probeParsed.dbPath,
        path.resolve(dataDirSub, 'videorisk.db'),
        'initializeDefaultStorage must open <DATA_DIR>/videorisk.db when DATABASE_PATH is absent'
      );
      assert.strictEqual(
        probeParsed.wal,
        'wal',
        'SQLite WAL mode must remain active under DATA_DIR initialization'
      );
      assert(
        fs.existsSync(path.resolve(dataDirSub, 'videorisk.db')),
        '<DATA_DIR>/videorisk.db file must be created on disk'
      );

      // Verify DATABASE_PATH overrides DATA_DIR inside initializeDefaultStorage
      const overrideDir = path.join(tmpRoot, 'override');
      fs.mkdirSync(overrideDir, { recursive: true });
      const overrideDb = path.join(overrideDir, 'chosen_test.db');
      const repoFromDbPath = initializeDefaultStorage({
        DATABASE_PATH: overrideDb,
        TEST_DATABASE_PATH: overrideDb,
        DATA_DIR: dataDirSub,
      });
      try {
        assert.strictEqual(
          (repoFromDbPath as any).dbPath,
          path.resolve(overrideDb),
          'initializeDefaultStorage must prioritize DATABASE_PATH over DATA_DIR'
        );
      } finally {
        await (repoFromDbPath as any).close();
      }
      console.log('  ✅ PASS: WS1 SQLite precedence & WAL behavior verified in isolated temp directories');
    }

    // =========================================================================
    // WORKSTREAM 2 & 3: APP_BASE_URL Validation & AI Studio APP_URL Handling
    // =========================================================================
    console.log('\n[WS2 & WS3: APP_BASE_URL Staging/Prod Fail-Closed & APP_URL Attribution]');
    try {
      const baseValidProd: NodeJS.ProcessEnv = {
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'production',
        PAYMENT_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_validtestkey123456',
        STRIPE_WEBHOOK_SECRET: 'whsec_validwebhooksecret123456',
        STRIPE_PRICE_CREATOR: 'price_creator_live_1',
        STRIPE_PRICE_PRO: 'price_pro_live_1',
        STRIPE_PRICE_AGENCY: 'price_agency_live_1',
        STRIPE_PRICE_AUDIT_ONCE: 'price_audit_live_1',
        MEDIA_TOKEN_SECRET: '0123456789abcdef0123456789abcdef',
      };

      const prodMissingOrigin = validateBillingConfiguration('production', { ...baseValidProd });
      assert.strictEqual(prodMissingOrigin.valid, false, 'Production must fail when all origin env vars are missing');
      assert(
        prodMissingOrigin.issues.some((i) => i.type === 'ERROR' && i.variable === 'APP_BASE_URL'),
        'Production missing origin must emit ERROR naming APP_BASE_URL'
      );

      const baseValidStaging: NodeJS.ProcessEnv = {
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'staging',
        PAYMENT_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_validtestkey123456',
        STRIPE_WEBHOOK_SECRET: 'whsec_validwebhooksecret123456',
        MEDIA_TOKEN_SECRET: '0123456789abcdef0123456789abcdef',
      };

      const stagingMissingOrigin = validateBillingConfiguration('staging', { ...baseValidStaging });
      assert.strictEqual(stagingMissingOrigin.valid, false, 'Staging must fail when all origin env vars are missing');
      assert(
        stagingMissingOrigin.issues.some((i) => i.type === 'ERROR' && i.variable === 'APP_BASE_URL'),
        'Staging missing origin must emit ERROR naming APP_BASE_URL'
      );

      const prodHttpOrigin = validateBillingConfiguration('production', {
        ...baseValidProd,
        APP_BASE_URL: 'http://videorisk.com',
      });
      assert.strictEqual(prodHttpOrigin.valid, false, 'Production must reject non-HTTPS APP_BASE_URL');

      const devMissingOrigin = validateBillingConfiguration('development', {
        NODE_ENV: 'development',
      });
      assert(
        !devMissingOrigin.issues.some((i) => i.type === 'ERROR' && i.variable === 'APP_BASE_URL'),
        'Development must preserve local preview compatibility when origin vars are absent'
      );

      // AI Studio APP_URL injection without APP_BASE_URL
      const originMeta = resolveConfiguredAppOrigin({ APP_URL: 'https://ais-preview.example.com/' });
      assert.strictEqual(originMeta.variable, 'APP_URL');
      assert.strictEqual(originMeta.hasExplicitAppBaseUrl, false);

      const prodWithAppUrlOnly = validateBillingConfiguration('production', {
        ...baseValidProd,
        APP_URL: 'https://ais-prod-fallback.example.com',
      });
      assert.strictEqual(prodWithAppUrlOnly.valid, true, 'Default mode retains runtime compatibility with HTTPS APP_URL');
      const fallbackWarn = prodWithAppUrlOnly.issues.find(
        (i) => i.variable === 'APP_BASE_URL' && i.type === 'WARNING'
      );
      assert(fallbackWarn, 'Production with only APP_URL must warn that APP_BASE_URL itself is unset');
      assert(
        fallbackWarn!.message.includes('APP_URL') && fallbackWarn!.message.includes('not explicitly set'),
        'Warning must accurately report APP_URL satisfied origin without claiming APP_BASE_URL is configured'
      );

      // --strict-origin / { strictOrigin: true }
      const prodStrictWithAppUrlOnly = validateBillingConfiguration(
        'production',
        { ...baseValidProd, APP_URL: 'https://ais-prod-fallback.example.com' },
        { strictOrigin: true }
      );
      assert.strictEqual(prodStrictWithAppUrlOnly.valid, false, 'strictOrigin must fail when only APP_URL is set');
      assert(
        prodStrictWithAppUrlOnly.issues.some((i) => i.type === 'ERROR' && i.variable === 'APP_BASE_URL'),
        'strictOrigin failure must emit ERROR for APP_BASE_URL'
      );

      const cliCode = await runValidatorCli(['--mode=production', '--strict-origin'], {
        ...baseValidProd,
        APP_URL: 'https://ais-prod-fallback.example.com',
      });
      assert.strictEqual(cliCode, 1, 'CLI --strict-origin must return exit code 1 when APP_BASE_URL is unset');

      const prodStrictWithExplicit = validateBillingConfiguration(
        'production',
        {
          ...baseValidProd,
          APP_BASE_URL: 'https://videorisk.com',
          APP_URL: 'https://ais-prod-fallback.example.com',
        },
        { strictOrigin: true }
      );
      assert.strictEqual(prodStrictWithExplicit.valid, true, 'Explicit APP_BASE_URL satisfies strictOrigin');

      // Runtime service parity across BillingService, EmailService, and validateAppOriginUrl
      process.env.NODE_ENV = 'production';
      process.env.DEPLOYMENT_ENV = 'production';
      delete process.env.APP_BASE_URL;
      delete process.env.APP_URL;
      delete process.env.PUBLIC_APP_URL;
      assert.throws(
        () => billingService.resolveTrustedCheckoutOrigin({}),
        /APP_BASE_URL|origin/i,
        'BillingService.resolveTrustedCheckoutOrigin must fail closed in production when origin is missing'
      );
      assert.strictEqual(
        validateAppOriginUrl('http://videorisk.com', true, 'APP_BASE_URL').valid,
        false,
        'validateAppOriginUrl rejects HTTP in public HTTPS mode'
      );
      const stagingResetOrigin = resolvePasswordResetAppBaseUrl({
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'staging',
      });
      assert.strictEqual(stagingResetOrigin.valid, false, 'resolvePasswordResetAppBaseUrl must fail closed in staging when origin is missing');
      assert.strictEqual(stagingResetOrigin.reason, 'MISSING_APP_BASE_URL');

      const fallbackResetOrigin = resolvePasswordResetAppBaseUrl({
        NODE_ENV: 'production',
        APP_URL: 'https://ais-staging.example.com/',
      });
      assert.strictEqual(fallbackResetOrigin.valid, true);
      assert.strictEqual(
        fallbackResetOrigin.origin,
        'https://ais-staging.example.com',
        'resolvePasswordResetAppBaseUrl honors HTTPS APP_URL consistently'
      );

      console.log('  ✅ PASS: WS2 & WS3 origin validation, APP_URL attribution, and --strict-origin verified');
    } finally {
      restoreEnv(baselineEnv);
    }

    // =========================================================================
    // WORKSTREAM 4: OCR Executable Resolution
    // =========================================================================
    console.log('\n[WS4: OCR Executable Resolution (TESSERACT_PATH > PATH > NOT_ASSESSED)]');
    try {
      const tmpOcrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_ws4_'));
      tmpRoots.push(tmpOcrDir);

      const explicitBinDir = path.join(tmpOcrDir, 'explicit');
      const pathBinDir = path.join(tmpOcrDir, 'pathbin');
      fs.mkdirSync(explicitBinDir, { recursive: true });
      fs.mkdirSync(pathBinDir, { recursive: true });

      const explicitMarker = path.join(tmpOcrDir, 'explicit_used.txt');
      const pathMarker = path.join(tmpOcrDir, 'path_used.txt');
      const tsvPayload = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t100\t30\t95\tURGENT';

      const explicitTess = path.join(explicitBinDir, 'custom-tesseract');
      makeFakeExecutableScript(
        explicitTess,
        `echo "explicit" >> "${explicitMarker}"\nprintf '${tsvPayload}\\n'`
      );
      const pathTess = path.join(pathBinDir, 'tesseract');
      makeFakeExecutableScript(
        pathTess,
        `echo "path" >> "${pathMarker}"\nprintf '${tsvPayload}\\n'`
      );
      const nonExecTess = path.join(explicitBinDir, 'non-exec-tesseract');
      fs.writeFileSync(nonExecTess, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
      fs.chmodSync(nonExecTess, 0o644);

      const ocrAdapter = new ThumbnailOcrAdapter();
      const videoProc = new VideoProcessor();
      const videoSize = fs.statSync(sampleVideoPath).size;
      const mediaMeta = {
        filename: 'sample_demo_problematic.mp4',
        originalSize: videoSize,
        fileSizeBytes: videoSize,
        durationSeconds: 3,
        width: 640,
        height: 360,
        resolutionLabel: '360p',
        fps: 30,
        hasAudio: true,
        videoCodec: 'h264',
        audioCodec: 'aac',
        bitrateKbps: 500,
        isProxyUsed: false,
      };

      // 1. Explicit TESSERACT_PATH overrides PATH
      process.env.TESSERACT_PATH = explicitTess;
      process.env.PATH = `${pathBinDir}:/usr/bin:/bin`;
      const thumbExplicitRes = await ocrAdapter.extractText(sampleThumbPath, 1280, 720);
      assert.strictEqual(thumbExplicitRes.status, 'DETECTED', 'Explicit TESSERACT_PATH should succeed');
      assert(fs.existsSync(explicitMarker), 'Explicit TESSERACT_PATH must be invoked over PATH tesseract');
      assert(!fs.existsSync(pathMarker), 'PATH tesseract must NOT be invoked when explicit TESSERACT_PATH is valid');

      // 2. Missing explicit TESSERACT_PATH must NOT silently fall back to PATH
      process.env.TESSERACT_PATH = path.join(explicitBinDir, 'does_not_exist');
      const thumbMissingRes = await ocrAdapter.extractText(sampleThumbPath, 1280, 720);
      assert.strictEqual(
        thumbMissingRes.status,
        'ANALYSIS_UNAVAILABLE',
        'ThumbnailOcrAdapter must report ANALYSIS_UNAVAILABLE for broken explicit TESSERACT_PATH'
      );
      const videoMissingRes = await videoProc.performVideoOcr(sampleVideoPath, mediaMeta, { maxFrames: 1 });
      assert.strictEqual(
        videoMissingRes.status,
        'ANALYSIS_UNAVAILABLE',
        'VideoProcessor.performVideoOcr must report ANALYSIS_UNAVAILABLE for broken explicit TESSERACT_PATH'
      );

      // 3. Non-executable explicit TESSERACT_PATH must fail cleanly
      process.env.TESSERACT_PATH = nonExecTess;
      const thumbNonExecRes = await ocrAdapter.extractText(sampleThumbPath, 1280, 720);
      assert.strictEqual(thumbNonExecRes.status, 'ANALYSIS_UNAVAILABLE');
      const videoNonExecRes = await videoProc.performVideoOcr(sampleVideoPath, mediaMeta, { maxFrames: 1 });
      assert.strictEqual(videoNonExecRes.executionStatus, 'FAILED');
      assert.strictEqual(videoNonExecRes.status, 'INSUFFICIENT_EVIDENCE');
      assert.strictEqual(videoNonExecRes.framesSucceeded, 0);
      assert.strictEqual(videoNonExecRes.failureClassification, 'OCR_ENGINE_FAILURE');

      // 4. Unset TESSERACT_PATH falls back to PATH
      delete process.env.TESSERACT_PATH;
      process.env.PATH = `${pathBinDir}:/usr/bin:/bin`;
      const thumbPathRes = await ocrAdapter.extractText(sampleThumbPath, 1280, 720);
      assert.strictEqual(thumbPathRes.status, 'DETECTED', 'Unset TESSERACT_PATH must resolve tesseract via PATH');
      assert(fs.existsSync(pathMarker), 'PATH tesseract wrapper must run on fallback');

      const videoPathRes = await videoProc.performVideoOcr(sampleVideoPath, mediaMeta, { maxFrames: 1 });
      assert.strictEqual(videoPathRes.status, 'DETECTED', 'performVideoOcr must resolve tesseract via PATH fallback');

      // 5. Unset TESSERACT_PATH and absent from PATH -> NOT_ASSESSED
      delete process.env.TESSERACT_PATH;
      process.env.PATH = path.join(tmpOcrDir, 'empty_path');
      fs.mkdirSync(process.env.PATH, { recursive: true });
      const thumbNotAssessed = await ocrAdapter.extractText(sampleThumbPath, 1280, 720);
      assert.strictEqual(thumbNotAssessed.status, 'NOT_ASSESSED', 'Missing tesseract everywhere -> NOT_ASSESSED');
      const videoNotAssessed = await videoProc.performVideoOcr(sampleVideoPath, mediaMeta, { maxFrames: 1 });
      assert.strictEqual(videoNotAssessed.status, 'NOT_ASSESSED', 'Video OCR missing tesseract everywhere -> NOT_ASSESSED');

      console.log('  ✅ PASS: WS4 OCR resolution (explicit > PATH > NOT_ASSESSED, broken explicit -> ANALYSIS_UNAVAILABLE)');
    } finally {
      restoreEnv(baselineEnv);
    }

    // =========================================================================
    // WORKSTREAM 5: FFmpeg and FFprobe Path Consistency
    // =========================================================================
    console.log('\n[WS5: FFmpeg & FFprobe Resolution Consistency Across Media Pipeline]');
    try {
      const tmpMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_ws5_'));
      tmpRoots.push(tmpMediaDir);

      const sysFfmpeg = resolveExecutable('ffmpeg', 'FFMPEG_PATH', { PATH: baselineEnv.PATH }).resolvedPath;
      const sysFfprobe = resolveExecutable('ffprobe', 'FFPROBE_PATH', { PATH: baselineEnv.PATH }).resolvedPath;
      assert(sysFfmpeg && sysFfprobe, 'System ffmpeg and ffprobe must exist in test environment');

      const ffmpegMarker = path.join(tmpMediaDir, 'ffmpeg_wrapper.log');
      const ffprobeMarker = path.join(tmpMediaDir, 'ffprobe_wrapper.log');
      const ffmpegWrapper = path.join(tmpMediaDir, 'custom-ffmpeg');
      const ffprobeWrapper = path.join(tmpMediaDir, 'custom-ffprobe');
      makeFakeExecutableScript(ffmpegWrapper, `echo "ffmpeg" >> "${ffmpegMarker}"\nexec "${sysFfmpeg}" "$@"`);
      makeFakeExecutableScript(ffprobeWrapper, `echo "ffprobe" >> "${ffprobeMarker}"\nexec "${sysFfprobe}" "$@"`);

      const nonExecFfmpeg = path.join(tmpMediaDir, 'nonexec-ffmpeg');
      fs.writeFileSync(nonExecFfmpeg, 'not executable', 'utf8');
      fs.chmodSync(nonExecFfmpeg, 0o644);

      const mediaInspector = new MediaInspector();
      const proxyGenerator = new ProxyGenerator();
      const thumbnailInspector = new ThumbnailInspector();
      const audioProcessor = new AudioProcessor();
      const videoProcessor = new VideoProcessor();

      // 1. Explicit wrappers take precedence over PATH across every pipeline module
      process.env.FFMPEG_PATH = ffmpegWrapper;
      process.env.FFPROBE_PATH = ffprobeWrapper;
      delete process.env.TESSERACT_PATH;

      const inspectedMeta = await mediaInspector.inspect(sampleVideoPath, 'sample.mp4');
      assert(inspectedMeta.durationSeconds > 0, 'MediaInspector succeeded with explicit FFPROBE_PATH');
      assert(fs.existsSync(ffprobeMarker), 'MediaInspector must use explicit FFPROBE_PATH');

      const proxyValid = await proxyGenerator.isValidMediaProxy(sampleVideoPath);
      assert.strictEqual(proxyValid, true, 'ProxyGenerator.isValidMediaProxy succeeded with explicit FFPROBE_PATH');

      // Trigger ProxyGenerator.generateProxyIfNeeded using explicit FFMPEG_PATH on a temp copy
      const highResCopy = path.join(tmpMediaDir, 'proxy_src_test.mp4');
      fs.copyFileSync(sampleVideoPath, highResCopy);
      const proxyOut = await proxyGenerator.generateProxyIfNeeded(highResCopy, {
        ...inspectedMeta,
        isProxyUsed: true,
        resolutionLabel: '4K',
      });
      try {
        assert(fs.existsSync(proxyOut), 'ProxyGenerator created proxy using explicit FFMPEG_PATH');
        assert(fs.existsSync(ffmpegMarker), 'ProxyGenerator must honor explicit FFMPEG_PATH');
      } finally {
        try { fs.unlinkSync(proxyOut); } catch { /* ignore */ }
      }

      const thumbMeta = await thumbnailInspector.inspect(sampleThumbPath, 'thumb.jpg');
      assert(thumbMeta.width > 0 && thumbMeta.height > 0, 'ThumbnailInspector succeeded with explicit FFPROBE_PATH/FFMPEG_PATH');

      const pcmRes = await audioProcessor.extractPcmAudio(sampleVideoPath, inspectedMeta.durationSeconds);
      assert(pcmRes.status !== 'ANALYSIS_UNAVAILABLE', 'AudioProcessor.extractPcmAudio succeeded with explicit FFMPEG_PATH');

      const vidRes = await videoProcessor.analyzeVideo(sampleVideoPath, inspectedMeta, 'standard');
      assert(vidRes.framesSampled > 0, 'VideoProcessor.analyzeVideo succeeded with explicit FFMPEG_PATH');
      if (vidRes.tempFramesDir && fs.existsSync(vidRes.tempFramesDir)) {
        fs.rmSync(vidRes.tempFramesDir, { recursive: true, force: true });
      }

      // 2. Missing / non-executable FFMPEG_PATH / FFPROBE_PATH fail safely with typed diagnostics
      process.env.FFPROBE_PATH = path.join(tmpMediaDir, 'missing-ffprobe');
      process.env.FFMPEG_PATH = nonExecFfmpeg;

      await assert.rejects(
        () => mediaInspector.inspect(sampleVideoPath, 'sample.mp4'),
        (err: any) => err instanceof MediaInspectionError && err.category === 'MISSING_EXECUTABLE'
      );
      assert.strictEqual(
        await proxyGenerator.isValidMediaProxy(sampleVideoPath),
        false,
        'ProxyGenerator.isValidMediaProxy returns false safely when FFPROBE_PATH is missing'
      );
      await assert.rejects(
        () =>
          proxyGenerator.generateProxyIfNeeded(highResCopy, {
            ...inspectedMeta,
            isProxyUsed: true,
            resolutionLabel: '4K',
          }),
        (err: any) => err instanceof ProxyGenerationError && /not executable/i.test(err.message)
      );
      await assert.rejects(
        () => thumbnailInspector.inspect(sampleThumbPath, 'thumb.jpg'),
        (err: any) => err instanceof ThumbnailInspectionError
      );
      const failedPcm = await audioProcessor.extractPcmAudio(sampleVideoPath, inspectedMeta.durationSeconds);
      assert.strictEqual(failedPcm.status, 'ANALYSIS_UNAVAILABLE');
      await assert.rejects(
        () => videoProcessor.analyzeVideo(sampleVideoPath, inspectedMeta, 'standard'),
        (err: any) => err instanceof VideoProcessingError && err.category === 'NON_EXECUTABLE'
      );

      // 3. Unset env vars fall back to PATH seamlessly
      delete process.env.FFMPEG_PATH;
      delete process.env.FFPROBE_PATH;
      const fallbackMeta = await mediaInspector.inspect(sampleVideoPath, 'sample.mp4');
      assert(fallbackMeta.durationSeconds > 0, 'MediaInspector falls back to PATH ffprobe when unset');

      console.log('  ✅ PASS: WS5 FFmpeg & FFprobe precedence, fallback, and fail-safe diagnostics verified');
    } finally {
      restoreEnv(baselineEnv);
    }

    // =========================================================================
    // WORKSTREAM 6: Rate Limit Documentation & Precedence Contract
    // =========================================================================
    console.log('\n[WS6: Rate Limit Precedence Contract, .env.example Alignment & HTTP Enforcement]');
    try {
      const envExampleContent = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
      assert(
        envExampleContent.includes('AUTH_LOGIN_IP_RATE_LIMIT=20') &&
          envExampleContent.includes('AUTH_LOGIN_IP_RATE_WINDOW=900'),
        '.env.example must document AUTH_LOGIN_IP_RATE_LIMIT=20 and AUTH_LOGIN_IP_RATE_WINDOW=900 matching runtime defaults'
      );

      assert.strictEqual(resolveRateLimitInt(undefined, undefined, 20), 20);
      assert.strictEqual(resolveRateLimitInt('15', '50', 20), 15, 'Primary overrides legacy fallback');
      assert.strictEqual(resolveRateLimitInt(undefined, '45', 20), 45, 'Legacy fallback applies when primary unset');
      assert.strictEqual(resolveRateLimitInt('0', '45', 20), 45, 'Non-positive primary falls back cleanly');
      assert.strictEqual(resolveRateLimitInt('abc', undefined, 30), 30, 'Non-numeric falls back to default');

      assert(
        RATE_LIMIT_POLICY_SPECS.some((s) => s.primaryVar === 'AUTH_LOGIN_IP_RATE_LIMIT' && s.defaultValue === 20) &&
          RATE_LIMIT_POLICY_SPECS.some((s) => s.primaryVar === 'AUTH_REGISTER_RATE_LIMIT' && s.defaultValue === 30),
        'RATE_LIMIT_POLICY_SPECS must encode exact canonical defaults'
      );

      const rateValSummary = validateBillingConfiguration('development', {
        NODE_ENV: 'development',
        AUTH_LOGIN_IP_RATE_LIMIT: 'notanumber',
        AUTH_REGISTER_RATE_LIMIT: '25',
        AUTH_REGISTRATION_RATE_LIMIT: '40',
      });
      assert(
        rateValSummary.issues.some((i) => i.type === 'WARNING' && i.variable === 'AUTH_LOGIN_IP_RATE_LIMIT'),
        'Invalid rate limit var produces WARNING'
      );
      assert(
        rateValSummary.issues.some((i) => i.type === 'INFO' && i.variable === 'AUTH_REGISTER_RATE_LIMIT'),
        'Conflicting primary & legacy rate limit vars emit INFO explaining primary precedence'
      );

      // HTTP route verification for /api/auth/register & /api/auth/login precedence
      await storage.rateLimits.clearRateLimits?.();
      const { server, baseUrl } = await startTestServer();
      try {
        // Legacy AUTH_REGISTRATION_RATE_LIMIT=2 applies when AUTH_REGISTER_RATE_LIMIT is unset
        delete process.env.AUTH_REGISTER_RATE_LIMIT;
        process.env.AUTH_REGISTRATION_RATE_LIMIT = '2';

        for (let i = 0; i < 2; i++) {
          const r = await fetch(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: '', password: 'short' }),
          });
          assert.notStrictEqual(r.status, 429, `Request ${i + 1} should pass legacy registration limit`);
        }
        const rBlockedLegacy = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: '', password: 'short' }),
        });
        assert.strictEqual(rBlockedLegacy.status, 429, 'Legacy AUTH_REGISTRATION_RATE_LIMIT=2 blocks 3rd call');

        // Primary AUTH_REGISTER_RATE_LIMIT=3 overrides lower legacy limit=1
        await storage.rateLimits.clearRateLimits?.();
        process.env.AUTH_REGISTER_RATE_LIMIT = '3';
        process.env.AUTH_REGISTRATION_RATE_LIMIT = '1';
        for (let i = 0; i < 3; i++) {
          const r = await fetch(`${baseUrl}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: '', password: 'short' }),
          });
          assert.notStrictEqual(r.status, 429, `Primary AUTH_REGISTER_RATE_LIMIT=3 allows call ${i + 1}`);
        }
        const rBlockedPrimary = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: '', password: 'short' }),
        });
        assert.strictEqual(rBlockedPrimary.status, 429, 'Primary AUTH_REGISTER_RATE_LIMIT=3 blocks 4th call');

        // Login precedence: AUTH_LOGIN_IP_RATE_LIMIT=2 overrides AUTH_LOGIN_RATE_LIMIT=10
        await storage.rateLimits.clearRateLimits?.();
        process.env.AUTH_LOGIN_IP_RATE_LIMIT = '2';
        process.env.AUTH_LOGIN_RATE_LIMIT = '10';
        for (let i = 0; i < 2; i++) {
          const r = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: `nonexistent_${i}@example.com`, password: 'wrongpassword' }),
          });
          assert.notStrictEqual(r.status, 429, `Login IP call ${i + 1} within AUTH_LOGIN_IP_RATE_LIMIT=2`);
        }
        const rLoginBlocked = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'nonexistent_3@example.com', password: 'wrongpassword' }),
        });
        assert.strictEqual(rLoginBlocked.status, 429, 'AUTH_LOGIN_IP_RATE_LIMIT=2 overrides AUTH_LOGIN_RATE_LIMIT=10');
      } finally {
        server.close();
        await storage.rateLimits.clearRateLimits?.();
      }
      console.log('  ✅ PASS: WS6 rate limit documentation, defaults, and HTTP precedence verified');
    } finally {
      restoreEnv(baselineEnv);
    }

    // =========================================================================
    // WORKSTREAM 7: Stripe Secret Format Validation & Malformed Key Guardrails
    // =========================================================================
    console.log('\n[WS7: Stripe Secret Format Validation Across Modes & Runtime Billing]');
    try {
      const malformedKeys = ['bad_key', 'sk_test_short', 'sk_live_short', 'pk_test_123456789012', 'sk_test_!@#$%^&*'];
      for (const badKey of malformedKeys) {
        assert.strictEqual(
          validateStripeSecretKeyFormat(badKey).validFormat,
          false,
          `Canonical validator must reject malformed key (${badKey.slice(0, 7)}...)`
        );
        for (const mode of ['development', 'test', 'staging', 'production', 'ci'] as const) {
          const summary = validateBillingConfiguration(mode, {
            NODE_ENV: mode === 'production' || mode === 'staging' ? 'production' : mode,
            DEPLOYMENT_ENV: mode === 'staging' ? 'staging' : undefined,
            PAYMENT_MODE: mode === 'production' ? 'live' : 'test',
            STRIPE_SECRET_KEY: badKey,
            STRIPE_WEBHOOK_SECRET: 'whsec_validwebhooksecret123456',
            APP_BASE_URL: 'https://videorisk.com',
            MEDIA_TOKEN_SECRET: '0123456789abcdef0123456789abcdef',
          });
          assert.strictEqual(summary.valid, false, `Validator in ${mode} mode must fail on malformed Stripe key`);
          const errIssue = summary.issues.find((i) => i.type === 'ERROR' && i.variable === 'STRIPE_SECRET_KEY');
          assert(errIssue, `Validator in ${mode} mode must emit STRIPE_SECRET_KEY ERROR`);
          assert(!errIssue!.message.includes(badKey), 'Error output must NEVER expose full secret key value');
        }
      }

      // Valid test & live patterns
      assert.strictEqual(validateStripeSecretKeyFormat('sk_test_mock_key_for_unit_tests_123').mode, 'test');
      assert.strictEqual(validateStripeSecretKeyFormat('rk_live_validrestricted987654').mode, 'live');

      // Runtime BillingService: malformed key in development MUST NOT fall back to simulation!
      const testUser = await storage.users.getOrCreateDefaultUser();
      process.env.NODE_ENV = 'development';
      delete process.env.DEPLOYMENT_ENV;
      delete process.env.PAYMENT_MODE;
      process.env.STRIPE_SECRET_KEY = 'sk_test_bad';
      billingService.reconfigure();

      assert.strictEqual(billingService.getStripeClient(), null, 'Malformed key clears Stripe client');
      assert.strictEqual(billingService.getStripeMode(), 'unconfigured', 'Malformed key reports unconfigured mode');
      assert(billingService.getStripeConfigurationError(), 'Malformed key exposes non-disclosing config error');
      await assert.rejects(
        () =>
          billingService.createCheckoutSession({
            planId: 'pro',
            userId: testUser.id,
            originUrl: 'http://localhost:3000',
          }),
        (err: any) => err?.statusCode === 500 && !String(err?.message || '').includes('sk_test_bad'),
        'createCheckoutSession must reject malformed key with HTTP 500 even in development without leaking secret'
      );

      // Missing key in development preserves simulation mode cleanly even after previously holding a valid key
      process.env.STRIPE_SECRET_KEY = 'sk_test_validtestkey123456';
      billingService.reconfigure();
      assert(billingService.getStripeClient() !== null, 'Valid dev test key instantiates Stripe client');
      delete process.env.STRIPE_SECRET_KEY;
      assert.strictEqual(billingService.getStripeClient(), null, 'Deleting STRIPE_SECRET_KEY clears cached Stripe client');
      assert.strictEqual(billingService.getStripeMode(), 'unconfigured');
      const simSession = await billingService.createCheckoutSession({
        planId: 'pro',
        userId: testUser.id,
        originUrl: 'http://localhost:3000',
      });
      assert.strictEqual(simSession.mode, 'simulation', 'Missing dev key preserves simulation fallback');

      // Health readiness reports degraded on malformed key without leaking secret value
      process.env.STRIPE_SECRET_KEY = 'sk_test_bad';
      const { server, baseUrl } = await startTestServer();
      try {
        const res = await fetch(`${baseUrl}/api/health/readiness`);
        const body = (await res.json()) as any;
        assert.strictEqual(body.checks?.billing?.status, 'degraded', '/api/health/readiness marks malformed key degraded');
        assert(
          !JSON.stringify(body).includes('sk_test_bad'),
          '/api/health/readiness must never leak secret key value'
        );
      } finally {
        server.close();
      }

      console.log('  ✅ PASS: WS7 Stripe canonical format validation & fail-closed runtime guards verified');
    } finally {
      restoreEnv(baselineEnv);
      billingService.reconfigure();
    }

    // =========================================================================
    // WORKSTREAM 8: Expanded ENV Validation Coverage
    // =========================================================================
    console.log('\n[WS8: ENV Validation Coverage (STORAGE_ENGINE, TRUST_PROXY, Simulation Webhook, Tools)]');
    try {
      const tmpWs8 = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_ws8_'));
      tmpRoots.push(tmpWs8);

      const nonEmptyModel = path.join(tmpWs8, 'ggml-base.bin');
      fs.writeFileSync(nonEmptyModel, 'dummy-model-bytes', 'utf8');
      const emptyModel = path.join(tmpWs8, 'empty.bin');
      fs.writeFileSync(emptyModel, '', 'utf8');
      const validScript = path.join(tmpWs8, 'fake-whisper');
      makeFakeExecutableScript(validScript, 'exit 0');
      const nonExecScript = path.join(tmpWs8, 'nonexec-whisper');
      fs.writeFileSync(nonExecScript, '#!/bin/sh\n', 'utf8');
      fs.chmodSync(nonExecScript, 0o644);

      const cleanProdBase: NodeJS.ProcessEnv = {
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'production',
        PAYMENT_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_validtestkey123456',
        STRIPE_WEBHOOK_SECRET: 'whsec_validwebhooksecret123456',
        STRIPE_PRICE_CREATOR: 'price_creator_live_1',
        STRIPE_PRICE_PRO: 'price_pro_live_1',
        STRIPE_PRICE_AGENCY: 'price_agency_live_1',
        STRIPE_PRICE_AUDIT_ONCE: 'price_audit_live_1',
        APP_BASE_URL: 'https://videorisk.com',
        MEDIA_TOKEN_SECRET: '0123456789abcdef0123456789abcdef',
        PATH: baselineEnv.PATH,
      };

      // STORAGE_ENGINE=memory forbidden in prod & staging, INFO in dev
      const prodMem = validateBillingConfiguration('production', { ...cleanProdBase, STORAGE_ENGINE: 'memory' });
      assert.strictEqual(prodMem.valid, false);
      assert(prodMem.issues.some((i) => i.type === 'ERROR' && i.variable === 'STORAGE_ENGINE'));

      const devMem = validateBillingConfiguration('development', {
        NODE_ENV: 'development',
        STORAGE_ENGINE: 'memory',
        PATH: baselineEnv.PATH,
      });
      assert(devMem.issues.some((i) => i.type === 'INFO' && i.variable === 'STORAGE_ENGINE'));

      // ALLOW_SIMULATION_WEBHOOK=true forbidden in staging & prod, WARNING in dev
      const prodSimWebhook = validateBillingConfiguration('production', {
        ...cleanProdBase,
        ALLOW_SIMULATION_WEBHOOK: 'true',
      });
      assert.strictEqual(prodSimWebhook.valid, false);
      assert(prodSimWebhook.issues.some((i) => i.type === 'ERROR' && i.variable === 'ALLOW_SIMULATION_WEBHOOK'));

      const devSimWebhook = validateBillingConfiguration('development', {
        NODE_ENV: 'development',
        ALLOW_SIMULATION_WEBHOOK: 'true',
        PATH: baselineEnv.PATH,
      });
      assert(devSimWebhook.issues.some((i) => i.type === 'WARNING' && i.variable === 'ALLOW_SIMULATION_WEBHOOK'));

      // TRUST_PROXY checks
      assert.strictEqual(validateTrustProxyValue('invalid_proxy_token').valid, false);
      assert.strictEqual(validateTrustProxyValue('1').valid, true);
      assert.strictEqual(validateTrustProxyValue('loopback').valid, true);
      assert.strictEqual(validateTrustProxyValue('10.0.0.0/8, 172.16.0.0/12').valid, true);
      assert(validateTrustProxyValue('true').warning, "TRUST_PROXY='true' should emit a warning");

      const prodBadProxy = validateBillingConfiguration('production', {
        ...cleanProdBase,
        TRUST_PROXY: 'not_valid_proxy',
      });
      assert.strictEqual(prodBadProxy.valid, false);
      assert(prodBadProxy.issues.some((i) => i.type === 'ERROR' && i.variable === 'TRUST_PROXY'));

      // Optional tools unconfigured -> NOT CONFIGURED without failing validation
      const cleanProdResult = validateBillingConfiguration('production', { ...cleanProdBase });
      assert.strictEqual(cleanProdResult.valid, true, 'Clean prod without optional OCR/Whisper/Music still passes');
      assert(cleanProdResult.notConfiguredCount >= 3, 'Unconfigured optional tools counted in notConfiguredCount');
      assert(
        cleanProdResult.issues.some((i) => i.type === 'NOT CONFIGURED' && i.variable === 'WHISPER_PATH'),
        'Unconfigured WHISPER_PATH marked NOT CONFIGURED'
      );

      // Configured invalid/non-exec binaries & empty model file -> ERROR
      const badToolsResult = validateBillingConfiguration('development', {
        NODE_ENV: 'development',
        PATH: baselineEnv.PATH,
        WHISPER_PATH: nonExecScript,
        LOCAL_STT_PATH: path.join(tmpWs8, 'missing-stt'),
        WHISPER_MODEL_PATH: emptyModel,
        TESSERACT_PATH: path.join(tmpWs8, 'missing-tesseract'),
        FFMPEG_PATH: nonExecScript,
        FFPROBE_PATH: path.join(tmpWs8, 'missing-ffprobe'),
        MUSIC_CLASSIFIER_PATH: nonExecScript,
      });
      assert.strictEqual(badToolsResult.valid, false);
      for (const expectedVar of [
        'WHISPER_PATH',
        'LOCAL_STT_PATH',
        'WHISPER_MODEL_PATH',
        'TESSERACT_PATH',
        'FFMPEG_PATH',
        'FFPROBE_PATH',
        'MUSIC_CLASSIFIER_PATH',
      ]) {
        assert(
          badToolsResult.issues.some((i) => i.type === 'ERROR' && i.variable === expectedVar),
          `Invalid ${expectedVar} must report ERROR`
        );
      }

      // Valid configured optional tools -> INFO and valid
      const goodToolsResult = validateBillingConfiguration('development', {
        NODE_ENV: 'development',
        PATH: baselineEnv.PATH,
        WHISPER_PATH: validScript,
        WHISPER_MODEL_PATH: nonEmptyModel,
        MUSIC_CLASSIFIER_PATH: validScript,
      });
      assert.strictEqual(goodToolsResult.valid, true);
      assert(goodToolsResult.issues.some((i) => i.type === 'INFO' && i.variable === 'WHISPER_PATH'));
      assert(goodToolsResult.issues.some((i) => i.type === 'INFO' && i.variable === 'WHISPER_MODEL_PATH'));

      console.log('  ✅ PASS: WS8 environment validator coverage verified');
    } finally {
      restoreEnv(baselineEnv);
    }

    console.log('\n✅ TEST SUITE 30 PASSED: ALL WORKSTREAMS 1-8 VERIFIED!');
  } finally {
    restoreEnv(baselineEnv);
    billingService.reconfigure();
    for (const dir of tmpRoots) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('config_integrity_remediation.test.ts')) {
  runConfigIntegrityRemediationTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Test Suite 30 Failed:', err);
      process.exit(1);
    });
}
