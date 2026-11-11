import { Router } from 'express';
import { z } from 'zod';
import { requireWhitelist } from '../middleware/whitelistAuth.js';
import {
  listWhitelistAdmin,
  addWhitelistUser,
  removeWhitelistUser,
  updateWhitelistConfig,
  updateWhitelistUserPermissions,
  WHITELIST_FEATURES
} from '../services/whitelist.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();
const OWNER_USER_ID = '8172230031';

const requireOwner = (req, res, next) => {
  if (String(req.noxridge?.userId || '') !== OWNER_USER_ID) {
    return next(new AppError('Admin Panel hanya dapat diakses oleh owner NOXRIDGE.', 403, 'ADMIN_OWNER_ONLY'));
  }
  return next();
};

// Every request authenticates with the owner's existing Importer WL key.
// Owner identity is verified server-side; MASTER_KEY is never sent to Lua.
router.use(requireWhitelist, requireOwner);

router.get('/session', (req, res) => res.json({
  success: true,
  authenticated: true,
  owner: { userId: req.noxridge.userId, username: req.noxridge.username }
}));

router.get('/users', async (req, res, next) => {
  try { return res.json({ success: true, data: await listWhitelistAdmin() }); }
  catch (error) { return next(error); }
});

router.post('/users', async (req, res, next) => {
  try {
    const parsed = z.object({
      userId: z.string().regex(/^\d{1,20}$/),
      username: z.string().trim().min(1).max(64),
      trial: z.string().trim().max(32).optional().nullable(),
      expires: z.string().trim().max(40).optional().nullable()
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Whitelist user data is invalid.', 400, 'VALIDATION_ERROR');
    const data = await addWhitelistUser(parsed.data);
    return res.status(201).json({ success: true, message: 'WL key hanya ditampilkan sekali. Simpan dengan aman.', data });
  } catch (error) { return next(error); }
});

router.put('/users/:userId/permissions', async (req, res, next) => {
  try {
    const parsed = z.object({
      mode: z.enum(['all', 'custom']),
      features: z.record(z.string(), z.boolean()).optional().default({})
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Pengaturan izin fitur tidak valid.', 400, 'VALIDATION_ERROR');
    const unknown = Object.keys(parsed.data.features).filter(key => !WHITELIST_FEATURES.includes(key));
    if (unknown.length) throw new AppError('Ada nama fitur yang tidak dikenal.', 400, 'UNKNOWN_FEATURE');
    const data = await updateWhitelistUserPermissions(req.params.userId, parsed.data);
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
});

router.delete('/users/:userId', async (req, res, next) => {
  try {
    if (!/^\d{1,20}$/.test(req.params.userId)) throw new AppError('Roblox UserId tidak valid.', 400, 'INVALID_USER_ID');
    return res.json({ success: true, data: await removeWhitelistUser(req.params.userId) });
  } catch (error) { return next(error); }
});

router.put('/config', async (req, res, next) => {
  try {
    const parsed = z.object({
      globalTrial: z.record(z.string(), z.unknown()).optional(),
      notice: z.record(z.string(), z.unknown()).optional()
    }).refine(value => value.globalTrial !== undefined || value.notice !== undefined).safeParse(req.body);
    if (!parsed.success) throw new AppError('Konfigurasi whitelist tidak valid.', 400, 'VALIDATION_ERROR');
    return res.json({ success: true, data: await updateWhitelistConfig(parsed.data) });
  } catch (error) { return next(error); }
});

export default router;
