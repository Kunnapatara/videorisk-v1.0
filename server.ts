import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { apiRouter } from './src/server/routes/api';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const isProd = process.env.NODE_ENV === 'production';

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

  // Mount API Router
  app.use('/api', apiRouter);

  // Serve static assets or mount Vite dev middlewares
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    console.log('[VideoRisk] Dev mode: Vite middleware attached');
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('[VideoRisk] Prod mode: Serving static dist folder');
  }

  // Graceful error handler (Never leak DLOPEN / internal stack traces to users)
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
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

startServer().catch(err => {
  console.error('[VideoRisk] Fatal server startup error:', err);
  process.exit(1);
});
