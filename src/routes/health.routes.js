import { Router } from 'express';
import { env } from '../config/env.js';
import { accountDatabaseReady } from '../services/account.service.js';

const router = Router();

// Basic process health. Does not require external services.
router.get('/health', (req, res) => {
  return res.status(200).json({
    success: true,
    service: 'NOXRIDGE UNIVERSAL BACKEND',
    organization: 'NOXRIDGE COMMUNITY',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: '1.0.0'
  });
});

// Explicit database probe. Creates/validates the account schema on first use.
router.get('/health/database', async (req, res) => {
  if (!env.DATABASE_URL) {
    return res.status(503).json({
      success: false,
      database: { configured: false, connected: false },
      message: 'DATABASE_URL is not configured.'
    });
  }

  try {
    await accountDatabaseReady();
    return res.status(200).json({
      success: true,
      database: { configured: true, connected: true },
      message: 'PostgreSQL connection and account schema are ready.',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('PostgreSQL health check failed:', error.message);
    return res.status(503).json({
      success: false,
      database: { configured: true, connected: false },
      message: 'PostgreSQL connection failed. Check Render database URL and network settings.'
    });
  }
});

export default router;
