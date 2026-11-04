import app from './src/app.js';
import { env } from './src/config/env.js';

const HOST = '0.0.0.0';

const server = app.listen(env.PORT, HOST, () => {
  console.log('====================================');
  console.log('       NOXRIDGE COMMUNITY');
  console.log('   UNIVERSAL BACKEND API');
  console.log('====================================');
  console.log('Status : RUNNING');
  console.log(`Port   : ${env.PORT}`);
  console.log(`Host   : ${HOST}`);
  console.log(`Mode   : ${env.NODE_ENV}`);
});

let isShuttingDown = false;

const shutdown = (signal) => {
  if (isShuttingDown) return;

  isShuttingDown = true;

  console.log(`\n${signal} received. Shutting down...`);

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
