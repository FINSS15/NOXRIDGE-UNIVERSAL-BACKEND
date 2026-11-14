import { Router } from 'express';
import { requireWhitelist } from '../middleware/whitelistAuth.js';
import { verifyPlayerPanelAccess } from '../services/admin-role.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();
router.post('/verify', requireWhitelist, async (req, res, next) => {
  try {
    const access = await verifyPlayerPanelAccess(req.noxridge.userId);
    return res.json({ success: true, data: { ...access, user: { userId: req.noxridge.userId, username: req.noxridge.username } } });
  } catch (error) { return next(error); }
});
export default router;
