import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { apiRouter, configureTrustProxy, secureUploadsHandler, validateAndGetMediaTokenSecret } from './src/server/routes/api';
import { isProductionEnvironment } from './src/server/config/environment';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerAppOptions {
  env?: NodeJS.ProcessEnv;
  createViteServerFn?: (config: {
    server: { middlewareMode: boolean };
    appType: 'spa';
  }) => Promise<{ middlewares: express.RequestHandler; close?: () => Promise<void> }>;
}

export async function createServerApp(options?: ServerAppOptions) {
  const env = options?.env ?? process.env;
  const app = express();
  const isProd = isProductionEnvironment(env);

  // Validate critical security environment variables before accepting any traffic
  validateAndGetMediaTokenSecret(env);

  // Configure and validate reverse proxy trust settings at startup
  configureTrustProxy(app, env.TRUST_PROXY);

  app.use(express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    }
  }));
  app.use(express.urlencoded({ extended: true }));

  // Request logger for API calls
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      console.log(`[API] ${req.method} ${req.path}`);
    }
    next();
  });

  // Mount API router
  app.use('/api', apiRouter);

  // Secure authorized delivery of uploaded media, proxies, and thumbnails
  app.use('/uploads', secureUploadsHandler);

  let viteMiddlewareAttached = false;
  let closeViteServer: (() => Promise<void>) | undefined;

  // In production or staging, serve built client from dist/
  if (isProd) {
    const distPath = path.basename(__dirname) === 'dist-server'
      ? path.resolve(__dirname, '..', 'dist')
      : path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));

    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
        return next();
      }
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  } else {
    // Vite middleware for development
    try {
      const createViteServer =
        options?.createViteServerFn ??
        (await import('vite')).createServer;
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      viteMiddlewareAttached = true;
      closeViteServer = typeof vite.close === 'function' ? () => vite.close!() : undefined;
      console.log('[VideoRisk] Dev mode: Vite middleware attached');
    } catch (e) {
      console.warn('[VideoRisk] Vite middleware load failed, falling back to static/API only:', e);
    }
  }

  // Global error handler
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }
    console.error('[VideoRisk Error]', err?.message || err);

    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: 'Invalid JSON request body.',
        code: 'INVALID_JSON'
      });
    }
    if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
      return res.status(413).json({
        error: 'Request payload exceeds the allowed size limit.',
        code: 'PAYLOAD_TOO_LARGE'
      });
    }

    const rawStatus = Number(err?.status ?? err?.statusCode);
    const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
    return res.status(status).json({
      error: status < 500 && typeof err?.message === 'string' && err.message.trim()
        ? err.message
        : 'We couldn’t complete this request. Please try again.',
      code: err?.code || (status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR')
    });
  });

  return { app, isProd, viteMiddlewareAttached, closeViteServer };
}

async function startServer() {
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const { app, isProd, viteMiddlewareAttached, closeViteServer } = await createServerApp({ env: process.env });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[VideoRisk Server] Running at http://0.0.0.0:${PORT}`);
  });

  // Graceful shutdown handling for operational restarts and deployments
  const gracefulShutdown = (signal: string) => {
    console.log(`[VideoRisk Server] Received ${signal}. Initiating graceful shutdown...`);
    server.close(async () => {
      try {
        if (closeViteServer) {
          await closeViteServer();
        }
      } catch {}
      console.log('[VideoRisk Server] HTTP server closed cleanly.');
      process.exit(0);
    });
    // Force shutdown after 10 seconds if lingering sockets exist
    setTimeout(() => {
      console.error('[VideoRisk Server] Graceful shutdown timed out after 10s. Forcing exit.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return { server, app, isProd, viteMiddlewareAttached, closeViteServer };
}

// Start server when executed directly as entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer().catch(err => {
    console.error('[VideoRisk] Fatal server startup error:', err);
    process.exit(1);
  });
}

export { startServer };
