import { Router } from 'express';

import { requireApiKey, requireMasterKey } from '../middleware/auth.js';

const router = Router();

// Verify API Key
router.get('/verify', requireApiKey, (req, res) => {
  return res.status(200).json({
    success: true,
    authenticated: true,
    access: 'api',
    message: 'API key verified successfully.',
    timestamp: new Date().toISOString()
  });
});

// Verify Master Key
router.get('/verify/master', requireMasterKey, (req, res) => {
  return res.status(200).json({
    success: true,
    authenticated: true,
    access: 'master',
    message: 'Master key verified successfully.',
    timestamp: new Date().toISOString()
  });
});

export default router;
