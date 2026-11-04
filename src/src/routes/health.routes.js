import { Router } from 'express';

const router = Router();

// Backend health check
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

export default router;
