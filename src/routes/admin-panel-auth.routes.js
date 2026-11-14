import { Router } from 'express';
import { z } from 'zod';
import { requireWhitelist } from '../middleware/whitelistAuth.js';
import { verifyPlayerPanelAccess } from '../services/admin-role.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();
router.post('/verify', requireWhitelist, async (req, res, next) => {
  try {
    const parsed = z.object({ panelKey: z.string().trim().max(32).optional().default('') }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Panel Access Key tidak valid.', 400, 'PANEL_KEY_INVALID');
    const access = await verifyPlayerPanelAccess(req.noxridge.userId, parsed.data.panelKey);
    return res.json({ success: true, data: { ...access, user: { userId: req.noxridge.userId, username: req.noxridge.username } } });
  } catch (error) { return next(error); }
});
export default router;
