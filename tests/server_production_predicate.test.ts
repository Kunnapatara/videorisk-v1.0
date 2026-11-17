import assert from 'assert';
import express from 'express';
import http from 'http';
import { enforceTestDatabaseIsolation } from '../src/server/storage/testIsolation';

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

async function runServerProductionPredicateTests() {
  console.log('======================================================');
  console.log('--- GROUP A: SERVER.TS PRODUCTION PREDICATE TESTS ----');
  console.log('Canonical isProductionEnvironment() Decision in server.ts');
  console.log('======================================================');

  const trackedKeys = [
    'NODE_ENV',
    'PAYMENT_MODE',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'MEDIA_TOKEN_SECRET',
    'TRUST_PROXY',
  ];
  const initialEnv = snapshotEnv(trackedKeys);

  const { createServerApp } = await import('../server');
  const strongSecret = 'vr_test_server_prod_media_secret_0123456789abcdef';

  const makeViteSpy = () => {
    let calls = 0;
    let closed = false;
    const fn = async (_cfg: any) => {
      calls++;
      const mw: express.RequestHandler = (req, res, next) => {
        res.setHeader('X-Test-Vite-Attached', 'true');
        if (req.path === '/__vite_probe') {
          res.status(200).send('vite-dev-ok');
          return;
        }
        next();
      };
      return {
        middlewares: mw,
        close: async () => {
          closed = true;
        },
      };
    };
    return {
      fn,
      getCalls: () => calls,
      isClosed: () => closed,
    };
  };

  const probeAppLiveness = async (app: express.Express) => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const addr = server.address() as { port: number };
      const livenessRes = await fetch(`http://127.0.0.1:${addr.port}/api/health/liveness`);
      const viteProbeRes = await fetch(`http://127.0.0.1:${addr.port}/__vite_probe`);
      return {
        livenessStatus: livenessRes.status,
        viteProbeHeader: viteProbeRes.headers.get('X-Test-Vite-Attached'),
        viteProbeStatus: viteProbeRes.status,
      };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  try {
    // 1. NODE_ENV=production -> production mode, Vite NOT attached
    const spy1 = makeViteSpy();
    const res1 = await createServerApp({
      env: {
        ...process.env,
        NODE_ENV: 'production',
        MEDIA_TOKEN_SECRET: strongSecret,
      },
      createViteServerFn: spy1.fn,
    });
    assert.strictEqual(res1.isProd, true, '1a NODE_ENV=production resolves server.ts isProd=true');
    assert.strictEqual(res1.viteMiddlewareAttached, false, '1b NODE_ENV=production does NOT attach Vite middleware');
    assert.strictEqual(spy1.getCalls(), 0, '1c Vite createServer never invoked in production');
    const http1 = await probeAppLiveness(res1.app);
    assert.strictEqual(http1.livenessStatus, 200, '1d Liveness route responds 200 in production app');
    assert.strictEqual(http1.viteProbeHeader, null, '1e Vite middleware header absent in production HTTP pipeline');

    // 2. NODE_ENV=development + PAYMENT_MODE=live (+ sk_live) -> production mode in server.ts!
    const spy2 = makeViteSpy();
    const res2 = await createServerApp({
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PAYMENT_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_live_mock_key_1234567890abcdef',
        MEDIA_TOKEN_SECRET: strongSecret,
      },
      createViteServerFn: spy2.fn,
    });
    assert.strictEqual(res2.isProd, true, '2a NODE_ENV=development + live payment activates production mode in server.ts');
    assert.strictEqual(res2.viteMiddlewareAttached, false, '2b Vite middleware is NOT attached when live payment is active');
    assert.strictEqual(spy2.getCalls(), 0, '2c Vite createServer never called when live payment is active');
    const http2 = await probeAppLiveness(res2.app);
    assert.strictEqual(http2.livenessStatus, 200, '2d Liveness responds 200');
    assert.strictEqual(http2.viteProbeHeader, null, '2e Vite middleware absent in live-payment HTTP pipeline');

    // 2b. NODE_ENV=development + sk_live alone (no PAYMENT_MODE) -> production mode in server.ts!
    const spy2b = makeViteSpy();
    const res2b = await createServerApp({
      env: {
        ...process.env,
        NODE_ENV: 'development',
        STRIPE_SECRET_KEY: 'sk_live_mock_key_1234567890abcdef',
        MEDIA_TOKEN_SECRET: strongSecret,
      },
      createViteServerFn: spy2b.fn,
    });
    assert.strictEqual(res2b.isProd, true, '2b1 NODE_ENV=development + sk_live activates production mode in server.ts');
    assert.strictEqual(res2b.viteMiddlewareAttached, false, '2b2 Vite middleware disabled with sk_live');
    assert.strictEqual(spy2b.getCalls(), 0, '2b3 Vite createServer not called with sk_live');

    // 2c. Live payment mode under NODE_ENV=development also enforces MEDIA_TOKEN_SECRET at server.ts startup
    await assert.rejects(
      async () => {
        await createServerApp({
          env: {
            NODE_ENV: 'development',
            PAYMENT_MODE: 'live',
            STRIPE_SECRET_KEY: 'sk_live_mock_key_1234567890abcdef',
          },
          createViteServerFn: spy2.fn,
        });
      },
      /MEDIA_TOKEN_SECRET/,
      '2c Server startup fails closed without MEDIA_TOKEN_SECRET when live payment activates prod mode'
    );

    // 3. NODE_ENV=development + test payment configuration (no prod indicators) -> development mode, Vite attached
    const spy3 = makeViteSpy();
    const res3 = await createServerApp({
      env: {
        NODE_ENV: 'development',
        PAYMENT_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_mock_key_1234567890abcdef',
      },
      createViteServerFn: spy3.fn,
    });
    assert.strictEqual(res3.isProd, false, '3a NODE_ENV=development + test payment keeps development mode');
    assert.strictEqual(res3.viteMiddlewareAttached, true, '3b Test payment dev mode attaches Vite middleware');
    assert.strictEqual(spy3.getCalls(), 1, '3c Vite createServer invoked once in dev+test mode');
    const http3 = await probeAppLiveness(res3.app);
    assert.strictEqual(http3.livenessStatus, 200, '3d Liveness route responds 200 in dev+test');
    assert.strictEqual(http3.viteProbeHeader, 'true', '3e Vite middleware active on dev+test HTTP pipeline');
    assert.strictEqual(http3.viteProbeStatus, 200, '3f Vite probe handled by Vite middleware');

    // 4. NODE_ENV=development + ordinary dev config -> development mode (including real Vite middleware boot & clean shutdown)
    const realDevApp = await createServerApp({
      env: {
        NODE_ENV: 'development',
      },
    });
    try {
      assert.strictEqual(realDevApp.isProd, false, '4a Ordinary dev config keeps isProd=false');
      assert.strictEqual(realDevApp.viteMiddlewareAttached, true, '4b Real Vite middleware attaches in ordinary dev config');
      const http4 = await probeAppLiveness(realDevApp.app);
      assert.strictEqual(http4.livenessStatus, 200, '4c Real dev app liveness responds 200');
    } finally {
      await realDevApp.closeViteServer?.();
    }

    // 5. Verify process.env was not dirtied by default calls & isolate process.env toggle
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_MODE = 'live';
    process.env.STRIPE_SECRET_KEY = 'sk_live_mock_key_1234567890abcdef';
    process.env.MEDIA_TOKEN_SECRET = strongSecret;
    const spy5 = makeViteSpy();
    const res5 = await createServerApp({ createViteServerFn: spy5.fn });
    assert.strictEqual(res5.isProd, true, '5a Default env (process.env) respects live-payment production predicate in server.ts');
    assert.strictEqual(res5.viteMiddlewareAttached, false, '5b Default env does not attach Vite in live-payment mode');

    console.log('  ✅ PASS: All Group A server.ts canonical production predicate & Vite/static decision tests passed!');
  } finally {
    restoreEnv(initialEnv);
  }
}

if (process.argv[1]?.includes('server_production_predicate.test.ts')) {
  runServerProductionPredicateTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ SERVER PRODUCTION PREDICATE TEST FAILED:', err);
      process.exit(1);
    });
}

export { runServerProductionPredicateTests };
