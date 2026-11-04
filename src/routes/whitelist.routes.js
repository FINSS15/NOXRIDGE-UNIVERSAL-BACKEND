import { Router } from 'express';
import { z } from 'zod';
import { requireMasterKey } from '../middleware/auth.js';
import { requireWhitelist } from '../middleware/whitelistAuth.js';
import {
  listWhitelistAdmin,
  addWhitelistUser,
  removeWhitelistUser,
  updateWhitelistConfig,
  getWhitelistPublicConfig
} from '../services/whitelist.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();

router.get('/config', async (req, res, next) => {
  try {
    const config = await getWhitelistPublicConfig();
    return res.json({ success: true, config });
  } catch (error) { return next(error); }
});

router.get('/verify', requireWhitelist, async (req, res, next) => {
  try {
    const config = await getWhitelistPublicConfig();
    return res.json({ success: true, authenticated: true, user: req.noxridge, config });
  } catch (error) { return next(error); }
});

// All management endpoints require the backend master key. Never embed it in the importer.
router.get('/admin', requireMasterKey, async (req, res, next) => {
  try { return res.json({ success: true, data: await listWhitelistAdmin() }); }
  catch (error) { return next(error); }
});

router.post('/admin/users', requireMasterKey, async (req, res, next) => {
  try {
    const parsed = z.object({
      userId: z.string().regex(/^\d{1,20}$/),
      username: z.string().trim().min(1).max(64),
      trial: z.string().trim().max(32).optional().nullable(),
      expires: z.string().trim().max(40).optional().nullable()
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Whitelist user data is invalid.', 400, 'VALIDATION_ERROR');
    const data = await addWhitelistUser(parsed.data);
    return res.status(201).json({
      success: true,
      message: 'Whitelist user saved. Copy the WL key now; it is shown only once.',
      data
    });
  } catch (error) { return next(error); }
});

router.delete('/admin/users/:userId', requireMasterKey, async (req, res, next) => {
  try {
    if (!/^\d{1,20}$/.test(req.params.userId)) throw new AppError('Roblox UserId is invalid.', 400, 'INVALID_USER_ID');
    return res.json({ success: true, data: await removeWhitelistUser(req.params.userId) });
  } catch (error) { return next(error); }
});

router.put('/admin/config', requireMasterKey, async (req, res, next) => {
  try {
    const parsed = z.object({
      globalTrial: z.record(z.string(), z.unknown()).optional(),
      notice: z.record(z.string(), z.unknown()).optional()
    }).refine(value => value.globalTrial !== undefined || value.notice !== undefined).safeParse(req.body);
    if (!parsed.success) throw new AppError('Whitelist config is invalid.', 400, 'VALIDATION_ERROR');
    return res.json({ success: true, data: await updateWhitelistConfig(parsed.data) });
  } catch (error) { return next(error); }
});

export default router;
