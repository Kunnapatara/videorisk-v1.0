import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { apiRouter, configureTrustProxy } from './src/server/routes/api';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const isProd = process.env.NODE_ENV === 'production';

  // Configure and validate reverse proxy trust settings at startup
  configureTrustProxy(app, process.env.TRUST_PROXY);

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

  // Serve static assets from public / uploads (thumbnails, proxies)
  app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads')));

  // In production, serve built client from dist/
  if (isProd) {
    const distPath = path.resolve(__dirname, 'dist');
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
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      console.log('[VideoRisk] Dev mode: Vite middleware attached');
    } catch (e) {
      console.warn('[VideoRisk] Vite middleware load failed, falling back to static/API only:', e);
    }
  }

  // Global error handler
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[VideoRisk Error]', err);
    res.status(500).json({
      error: 'We couldn’t complete this request. Please try again.',
      code: err.code || 'INTERNAL_ERROR'
    });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[VideoRisk Server] Running at http://0.0.0.0:${PORT}`);
  });
}

// Start server when executed directly as entrypoint
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer().catch(err => {
    console.error('[VideoRisk] Fatal server startup error:', err);
    process.exit(1);
  });
}

export { startServer };
