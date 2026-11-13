import express from 'express';
import { env } from './src/config/env.js';

const HOST = '0.0.0.0';
const PORT = env.PORT;

// Bind the Render web-service port before loading the full route tree.
// This prevents slow module initialization from making Render's port scan
// time out before the HTTP server has a chance to listen.
const bootstrapApp = express();
let applicationReady = false;

bootstrapApp.get('/_render/healthz', (req, res) => {
  return res.status(applicationReady ? 200 : 503).json({
    success: applicationReady,
    status: applicationReady ? 'ready' : 'starting'
  });
});

const server = bootstrapApp.listen(PORT, HOST, async () => {
  console.log('[BOOT] HTTP listener is accepting connections.');
  console.log(`[BOOT] Port: ${PORT} | Host: ${HOST} | Mode: ${env.NODE_ENV}`);

  try {
    const { default: app } = await import('./src/app.js');
    bootstrapApp.use(app);
    applicationReady = true;

    console.log('====================================');
    console.log('       NOXRIDGE COMMUNITY');
    console.log('   UNIVERSAL BACKEND API');
    console.log('====================================');
    console.log('Status : RUNNING');
    console.log(`Port   : ${PORT}`);
    console.log(`Host   : ${HOST}`);
    console.log(`Mode   : ${env.NODE_ENV}`);
  } catch (error) {
    console.error('[BOOT] Application failed to initialize:', error);
    server.close(() => {
      process.exit(1);
    });
  }
});

server.on('error', (error) => {
  console.error('[BOOT] HTTP listener failed:', error);
  process.exit(1);
});

let isShuttingDown = false;

const shutdown = (signal) => {
  if (isShuttingDown) return;

  isShuttingDown = true;
  console.log(`\\n${signal} received. Shutting down...`);

  server.close((error) => {
    if (error) {
      console.error('Server shutdown failed:', error);
      process.exitCode = 1;
      return;
    }

    console.log('NOXRIDGE backend stopped.');
    process.exitCode = 0;
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
