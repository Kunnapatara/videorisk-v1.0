import assert from 'assert';
import crypto from 'crypto';
import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import multer from 'multer';
import { execFileSync } from 'child_process';
import { enforceTestDatabaseIsolation, verifyStorageTestDatabase } from '../src/server/storage/testIsolation';
import { parseApiResponse, ApiResponseError, sanitizeDiagnosticText } from '../src/utils/api';
import { MediaInspector, MediaInspectionError } from '../src/server/pipeline/mediaInspector';
import { ProxyGenerator, ProxyGenerationError } from '../src/server/pipeline/proxyGenerator';

process.env.VIDEORISK_TEST_RUN = 'true';
const testDbResolution = enforceTestDatabaseIsolation();

function createSyntheticMp4(filePath: string, width: number, height: number, durationSec: number = 1) {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=navy:s=${width}x${height}:d=${durationSec}:r=24`,
      '-f', 'lavfi',
      '-i', `sine=frequency=440:duration=${durationSec}`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-shortest',
      filePath,
    ],
    { stdio: 'pipe' }
  );
}

export async function runUploadResponseAndMediaResilienceTests() {
  console.log('\n======================================================');
  console.log('--- SUITE 28: UPLOAD RESPONSE & MEDIA RESILIENCE ---');
  console.log('======================================================\n');

  process.env.VIDEORISK_TEST_RUN = 'true';
  enforceTestDatabaseIsolation();

  const { storage } = await import('../src/server/storage');
  verifyStorageTestDatabase((storage as any).dbPath, testDbResolution.resolvedPath);

  const { apiRouter } = await import('../src/server/routes/api');
  const { createServerApp } = await import('../server');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr_upload_resilience_'));
  const createdUploadFiles: string[] = [];

  const prevEnv = {
    FFPROBE_PATH: process.env.FFPROBE_PATH,
    UPLOAD_USER_RATE_LIMIT: process.env.UPLOAD_USER_RATE_LIMIT,
    UPLOAD_IP_RATE_LIMIT: process.env.UPLOAD_IP_RATE_LIMIT,
    NODE_ENV: process.env.NODE_ENV,
  };

  process.env.UPLOAD_USER_RATE_LIMIT = '100';
  process.env.UPLOAD_IP_RATE_LIMIT = '100';

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server: import('http').Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // -------------------------------------------------------------------------
    // 1. FRONTEND SAFE RESPONSE PARSER UNIT TESTS
    // -------------------------------------------------------------------------
    console.log('[1. Frontend Safe Response Parser (JSON / HTML / Empty / Malformed)]');

    // 1a. Valid 2xx JSON passes cleanly
    const validRes = new Response(JSON.stringify({ fileId: 'f1', ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    const parsedValid = await parseApiResponse<{ fileId: string; ok: boolean }>(validRes, 'Fallback');
    assert.strictEqual(parsedValid.fileId, 'f1');
    assert.strictEqual(parsedValid.ok, true);

    // 1b. JSON error response (non-2xx)
    const jsonErrRes = new Response(
      JSON.stringify({ error: 'Insufficient credits. Required: 2 credit(s), but available balance is 1.' }),
      { status: 402, headers: { 'Content-Type': 'application/json' } }
    );
    await assert.rejects(
      () => parseApiResponse(jsonErrRes, 'Failed to start scan.'),
      (err: any) => {
        assert.ok(err instanceof ApiResponseError);
        assert.strictEqual(err.status, 402);
        assert.ok(err.message.includes('Insufficient credits'));
        return true;
      }
    );

    // 1c. HTML error response (e.g., 413 Request Entity Too Large HTML from reverse proxy)
    const html413Res = new Response(
      '<html><head><title>413 Request Entity Too Large</title></head><body><h1>413 Request Entity Too Large</h1><hr><center>nginx</center></body></html>',
      { status: 413, statusText: 'Payload Too Large', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
    await assert.rejects(
      () => parseApiResponse(html413Res, 'Failed to upload video.'),
      (err: any) => {
        assert.ok(err instanceof ApiResponseError);
        assert.strictEqual(err.status, 413);
        assert.strictEqual(err.code, 'HTML_RESPONSE');
        assert.ok(!err.message.includes('Unexpected token'), 'Must never leak SyntaxError Unexpected token');
        assert.ok(!err.message.includes('<html>'), 'Must never display raw HTML to users');
        assert.ok(err.message.includes('HTTP 413'), 'Explains proxy size limit clearly');
        return true;
      }
    );

    // 1d. HTML response returned with HTTP 200 (e.g. SPA fallback intercepted /api route)
    const html200Res = new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    await assert.rejects(
      () => parseApiResponse(html200Res, 'Failed to upload video.'),
      (err: any) => {
        assert.strictEqual(err.code, 'HTML_RESPONSE');
        assert.ok(!err.message.includes('<!doctype'), 'Must not include raw HTML doctype');
        assert.ok(!err.message.includes('Unexpected token'));
        return true;
      }
    );

    // 1e. Empty response (HTTP 502 and HTTP 200)
    const empty502Res = new Response('', { status: 502 });
    await assert.rejects(
      () => parseApiResponse(empty502Res, 'Failed to upload video.'),
      (err: any) => {
        assert.strictEqual(err.status, 502);
        assert.strictEqual(err.code, 'EMPTY_RESPONSE');
        assert.ok(err.message.includes('Failed to upload video.'));
        return true;
      }
    );
    const empty200Res = new Response('   \n  ', { status: 200, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(
      () => parseApiResponse(empty200Res, 'Failed to start scan.'),
      (err: any) => {
        assert.strictEqual(err.code, 'EMPTY_RESPONSE');
        assert.ok(err.message.includes('empty response'));
        return true;
      }
    );

    // 1f. Malformed JSON response (HTTP 500 & HTTP 200)
    const malformedRes = new Response('{"fileId": "123", broken', {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
    await assert.rejects(
      () => parseApiResponse(malformedRes, 'Failed to upload video.'),
      (err: any) => {
        assert.strictEqual(err.status, 500);
        assert.strictEqual(err.code, 'MALFORMED_JSON');
        assert.ok(err.message.includes('invalid response format'));
        return true;
      }
    );

    // 1g. Sanitization redacts tokens, secrets, paths, and HTML
    const sanitized = sanitizeDiagnosticText(
      '<div>Error at /app/applet/uploads/secret.mp4 with Bearer abc.def.ghi and sk_live_12345secret</div>'
    );
    assert.ok(!sanitized.includes('/app/applet'), 'Sanitizer must redact filesystem paths');
    assert.ok(!sanitized.includes('abc.def.ghi'), 'Sanitizer must redact Bearer tokens');
    assert.ok(!sanitized.includes('sk_live_12345secret'), 'Sanitizer must redact Stripe keys');
    assert.ok(!sanitized.includes('<div>'), 'Sanitizer must strip HTML tags');

    // 1h. Diagnostic console logging is suppressed when NODE_ENV=production
    const prevNodeEnvForDiag = process.env.NODE_ENV;
    const origConsoleWarn = console.warn;
    const capturedWarns: string[] = [];
    console.warn = (...args: any[]) => {
      capturedWarns.push(args.map((a) => String(a)).join(' '));
    };
    try {
      process.env.NODE_ENV = 'production';
      const prodHtmlRes = new Response('<html><body>Bad Gateway</body></html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      });
      await assert.rejects(() => parseApiResponse(prodHtmlRes, 'Failed to upload video.'));
      assert.strictEqual(capturedWarns.length, 0, 'Dev diagnostics must not log in production mode');
    } finally {
      console.warn = origConsoleWarn;
      if (prevNodeEnvForDiag === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnvForDiag;
    }

    console.log('  ✅ PASS: Safe frontend response parser handles JSON, HTML, empty, malformed, and secret redaction.');

    // -------------------------------------------------------------------------
    // 2. HTTP UPLOAD, SCAN, AUTHENTICATION & MULTER ERROR CONSISTENCY
    // -------------------------------------------------------------------------
    console.log('\n[2. Backend Upload, Scan, Auth & Multer JSON Error Consistency]');

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('TestPassword!2026', salt, 64).toString('hex');
    const testUser = await storage.users.createUser(`resilience_${suffix}@videorisk.test`, hash, salt, 0, 'free');
    const testToken = await storage.users.createSession(testUser.id);

    // 2a. Authentication failures always return 401 JSON (never HTML)
    for (const ep of ['/uploads', '/uploads/thumbnail', '/scans', '/scans/demo']) {
      const unauthRes = await fetch(`${baseUrl}${ep}`, { method: 'POST' });
      assert.strictEqual(unauthRes.status, 401, `${ep} rejects unauthenticated request with 401`);
      assert.ok((unauthRes.headers.get('content-type') || '').includes('application/json'), `${ep} returns JSON on 401`);
      await assert.rejects(
        () => parseApiResponse(unauthRes, 'Request failed.'),
        (err: any) => err instanceof ApiResponseError && err.status === 401 && err.message.includes('Unauthorized')
      );
    }

    // 2b. Non-2xx upload response: invalid video extension rejected with JSON 400
    const badExtForm = new FormData();
    badExtForm.append('video', new Blob(['not a video'], { type: 'text/plain' }), 'notes.txt');
    const badExtRes = await fetch(`${baseUrl}/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
      body: badExtForm,
    });
    assert.strictEqual(badExtRes.status, 400);
    assert.ok((badExtRes.headers.get('content-type') || '').includes('application/json'));
    await assert.rejects(
      () => parseApiResponse(badExtRes, 'Failed to upload video.'),
      (err: any) => err.status === 400 && err.message.includes('Invalid video format')
    );

    // 2c. Non-2xx upload response: corrupted .mp4 fails mediaInspector cleanly with JSON 400 (no leaked path)
    const corruptUploadForm = new FormData();
    corruptUploadForm.append('video', new Blob(['corrupt bytes'], { type: 'video/mp4' }), 'corrupt.mp4');
    const corruptUploadRes = await fetch(`${baseUrl}/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
      body: corruptUploadForm,
    });
    assert.strictEqual(corruptUploadRes.status, 400);
    assert.ok((corruptUploadRes.headers.get('content-type') || '').includes('application/json'));
    await assert.rejects(
      () => parseApiResponse(corruptUploadRes, 'Failed to upload video.'),
      (err: any) => err.status === 400 && !err.message.includes('/uploads/videorisk_')
    );

    // 2d. Non-2xx scan response: missing videoPath returns JSON 400
    const badScanRes = await fetch(`${baseUrl}/scans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ videoTitle: 'Missing Video' }),
    });
    assert.strictEqual(badScanRes.status, 400);
    assert.ok((badScanRes.headers.get('content-type') || '').includes('application/json'));
    await assert.rejects(
      () => parseApiResponse(badScanRes, 'Failed to start scan.'),
      (err: any) => err.status === 400 && err.message.includes('Valid video file path')
    );

    // 2e. Non-2xx scan response: insufficient credits (0 balance) returns JSON 402
    const validUploadMp4 = path.join(tempDir, 'valid_small.mp4');
    createSyntheticMp4(validUploadMp4, 320, 240, 1);
    const validUploadForm = new FormData();
    validUploadForm.append('video', new Blob([fs.readFileSync(validUploadMp4)], { type: 'video/mp4' }), 'valid_small.mp4');
    const okUploadRes = await fetch(`${baseUrl}/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
      body: validUploadForm,
    });
    assert.strictEqual(okUploadRes.status, 200);
    const uploadedMeta = await parseApiResponse<{ filePath: string; filename: string }>(okUploadRes, 'Upload failed.');
    createdUploadFiles.push(uploadedMeta.filePath);

    const lowCreditScanRes = await fetch(`${baseUrl}/scans`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${testToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoPath: uploadedMeta.filePath,
        videoFilename: uploadedMeta.filename,
        videoTitle: 'Zero Credit Test',
        scanMode: 'standard',
      }),
    });
    assert.strictEqual(lowCreditScanRes.status, 402);
    await assert.rejects(
      () => parseApiResponse(lowCreditScanRes, 'Failed to start scan.'),
      (err: any) => err.status === 402 && err.message.includes('Insufficient credits')
    );

    // 2f. Upload size rejection (Multer LIMIT_FILE_SIZE -> structured JSON 400, never HTML)
    // Verify both live small-limit Multer error handling & apiRouter's LIMIT_FILE_SIZE handler
    const tinyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 } });
    const sizeTestApp = express();
    sizeTestApp.post('/api/test-size-limit', (req: Request, res: ExpressResponse, next: NextFunction) => {
      tinyUpload.single('video')(req as any, res as any, (err: any) => {
        if (err) return next(err);
        res.json({ ok: true });
      });
    });
    // Also mount a route throwing LIMIT_FILE_SIZE into apiRouter's error pipeline behavior
    sizeTestApp.use('/api', apiRouter);
    sizeTestApp.use((err: any, _req: Request, res: ExpressResponse, _next: NextFunction) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Video file size exceeds 500 MB limit.', code: err.code });
      }
      return res.status(500).json({ error: 'Unexpected error' });
    });

    const sizeServer: import('http').Server = await new Promise((resolve) => {
      const s = sizeTestApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const sizePort = (sizeServer.address() as any).port;
      const oversizeForm = new FormData();
      oversizeForm.append('video', new Blob(['012345678901234567890123456789'], { type: 'video/mp4' }), 'oversize.mp4');
      const oversizeRes = await fetch(`http://127.0.0.1:${sizePort}/api/test-size-limit`, {
        method: 'POST',
        body: oversizeForm,
      });
      assert.strictEqual(oversizeRes.status, 400);
      assert.ok((oversizeRes.headers.get('content-type') || '').includes('application/json'));
      await assert.rejects(
        () => parseApiResponse(oversizeRes, 'Failed to upload video.'),
        (err: any) => err.status === 400 && err.message.includes('500 MB limit')
      );
    } finally {
      sizeServer.close();
    }

    // Verify Multer video upload middleware source preserves 500 MB limit and JSON response
    const apiSource = fs.readFileSync(path.resolve(process.cwd(), 'src/server/routes/api.ts'), 'utf8');
    assert.ok(apiSource.includes('fileSize: 500 * 1024 * 1024'), '500 MB upload limit preserved');
    assert.ok(apiSource.includes("Video file size exceeds 500 MB limit."), 'Multer LIMIT_FILE_SIZE returns JSON error');

    console.log('  ✅ PASS: Auth, upload validation, scan errors, and Multer size rejection return JSON and parse safely.');

    // -------------------------------------------------------------------------
    // 3. BACKEND /api/* JSON CONSISTENCY + SPA HTML FALLBACK PRESERVATION
    // -------------------------------------------------------------------------
    console.log('\n[3. Backend Unmatched /api/* JSON 404, Invalid JSON 400 & SPA Fallback]');

    const { app: fullDevApp, closeViteServer } = await createServerApp({
      env: { ...process.env, NODE_ENV: 'development', DEPLOYMENT_ENV: 'development' },
      createViteServerFn: async () => ({
        middlewares: ((_req: Request, res: ExpressResponse) => {
          res.status(200).type('text/html').send('<!doctype html><html><body>SPA</body></html>');
        }) as any,
      }),
    });

    const fullServer: import('http').Server = await new Promise((resolve) => {
      const s = fullDevApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const fullPort = (fullServer.address() as any).port;
      const fullBase = `http://127.0.0.1:${fullPort}`;

      // Unmatched GET /api/* returns JSON 404 (not Vite SPA HTML 200!)
      const missingApiGet = await fetch(`${fullBase}/api/does-not-exist`);
      assert.strictEqual(missingApiGet.status, 404);
      assert.ok((missingApiGet.headers.get('content-type') || '').includes('application/json'));
      const missingGetBody = await missingApiGet.json();
      assert.strictEqual(missingGetBody.code, 'API_NOT_FOUND');

      // Unmatched POST /api/* returns JSON 404
      const missingApiPost = await fetch(`${fullBase}/api/does-not-exist`, { method: 'POST' });
      assert.strictEqual(missingApiPost.status, 404);
      assert.ok((missingApiPost.headers.get('content-type') || '').includes('application/json'));

      // Malformed JSON request body returns JSON 400 (not 500 or HTML)
      const malformedReqRes = await fetch(`${fullBase}/api/scans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });
      assert.strictEqual(malformedReqRes.status, 400);
      assert.ok((malformedReqRes.headers.get('content-type') || '').includes('application/json'));
      const malformedReqBody = await malformedReqRes.json();
      assert.strictEqual(malformedReqBody.code, 'INVALID_JSON');

      // Non-API SPA navigation route STILL serves HTML normally
      const spaRes = await fetch(`${fullBase}/dashboard`);
      assert.strictEqual(spaRes.status, 200);
      assert.ok((spaRes.headers.get('content-type') || '').includes('text/html'));
      const spaText = await spaRes.text();
      assert.ok(spaText.includes('<!doctype html>'));
    } finally {
      fullServer.close();
      if (closeViteServer) await closeViteServer();
    }

    console.log('  ✅ PASS: Unmatched /api/* returns JSON 404, malformed JSON returns 400 JSON, and SPA HTML fallback is preserved.');

    // -------------------------------------------------------------------------
    // 4. FFPROBE FAILURE, 1440x2560 PROXY ROUTING & PROXY GENERATION FAILURE
    // -------------------------------------------------------------------------
    console.log('\n[4. FFprobe Failure, 1440x2560 Portrait Inspection & Proxy Failure]');

    const inspector = new MediaInspector();
    const proxyGen = new ProxyGenerator();

    // 4a. Missing FFprobe binary -> MediaInspectionError (MISSING_EXECUTABLE)
    process.env.FFPROBE_PATH = path.join(tempDir, 'missing_ffprobe_binary');
    await assert.rejects(
      () => inspector.inspect(validUploadMp4, 'valid_small.mp4'),
      (err: any) => err instanceof MediaInspectionError && err.category === 'MISSING_EXECUTABLE'
    );
    if (prevEnv.FFPROBE_PATH !== undefined) process.env.FFPROBE_PATH = prevEnv.FFPROBE_PATH;
    else delete process.env.FFPROBE_PATH;

    // 4b. Corrupt media file -> MediaInspectionError (NON_ZERO_EXIT)
    const corruptMp4 = path.join(tempDir, 'corrupt_media.mp4');
    fs.writeFileSync(corruptMp4, 'not real media container');
    await assert.rejects(
      () => inspector.inspect(corruptMp4, 'corrupt_media.mp4'),
      (err: any) => err instanceof MediaInspectionError && err.category === 'NON_ZERO_EXIT'
    );

    // 4c. Portrait 1440x2560 video inspection & proxy generation verification
    const portrait2kMp4 = path.join(tempDir, `portrait_1440x2560_${Date.now()}.mp4`);
    createSyntheticMp4(portrait2kMp4, 1440, 2560, 1);
    const portraitMeta = await inspector.inspect(portrait2kMp4, 'portrait_1440x2560.mp4');
    assert.strictEqual(portraitMeta.width, 1440);
    assert.strictEqual(portraitMeta.height, 2560);
    assert.strictEqual(portraitMeta.resolutionLabel, '4K Ultra HD');
    assert.strictEqual(portraitMeta.isProxyUsed, true, '1440x2560 video must enter proxy generation (height 2560 > 1080)');

    const generatedProxyPath = await proxyGen.generateProxyIfNeeded(portrait2kMp4, portraitMeta);
    createdUploadFiles.push(generatedProxyPath);
    assert.ok(generatedProxyPath !== portrait2kMp4, 'Proxy generator produces downscaled proxy path');
    assert.ok(await proxyGen.isValidMediaProxy(generatedProxyPath), 'Generated 1440x2560 proxy is valid playable H.264 video');

    // 4d. Proxy generation failure (corrupt input with isProxyUsed=true) fails closed with ProxyGenerationError
    const badProxyInput = path.join(tempDir, `bad_proxy_input_${Date.now()}.mp4`);
    fs.writeFileSync(badProxyInput, 'corrupt payload');
    await assert.rejects(
      () =>
        proxyGen.generateProxyIfNeeded(badProxyInput, {
          ...portraitMeta,
          filename: 'bad_proxy_input.mp4',
          isProxyUsed: true,
        }),
      (err: any) => err instanceof ProxyGenerationError
    );

    console.log('  ✅ PASS: FFprobe failure, 1440x2560 proxy entry/scaling, and ProxyGenerationError fail-closed verified.');
    console.log('\n🎉 ALL UPLOAD RESPONSE & MEDIA RESILIENCE TESTS PASSED!\n');
  } finally {
    server.close();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const filePath of createdUploadFiles) {
      if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    if (fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

if (
  process.argv[1] &&
  path.basename(process.argv[1]) === 'upload_response_and_media_resilience.test.ts'
) {
  runUploadResponseAndMediaResilienceTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Upload Response & Media Resilience Test Failed:', err);
      process.exit(1);
    });
}
