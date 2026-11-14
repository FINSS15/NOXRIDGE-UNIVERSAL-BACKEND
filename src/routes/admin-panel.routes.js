import { Router } from 'express';
import { z } from 'zod';
import { requireWhitelist } from '../middleware/whitelistAuth.js';
import {
  listWhitelistAdmin,
  getWhitelistLegacySnapshot,
  addWhitelistUser,
  updateWhitelistUserTrial,
  updateWhitelistUserKey,
  removeWhitelistUser,\n  revokeWhitelistUser,
  updateWhitelistConfig,
  updateWhitelistUserPermissions,
  WHITELIST_FEATURES,
  listWhitelistBlacklist,
  addWhitelistBlacklist,
  removeWhitelistBlacklist
} from '../services/whitelist.service.js';
import { AppError } from '../utils/errors.js';
import { syncLegacyWhitelistJson } from '../services/legacy-whitelist-sync.service.js';
import { listPanelAdmins, grantPanelAdmin, updatePanelAdmin, revokePanelAdmin, deletePanelAccessForUser } from '../services/admin-role.service.js';

const syncLegacyWhitelist = async () => syncLegacyWhitelistJson(await getWhitelistLegacySnapshot());

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
      expires: z.string().trim().max(40).optional().nullable(),
      wlKey: z.string().trim().regex(/^\d{4,32}$/)
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Whitelist user data is invalid.', 400, 'VALIDATION_ERROR');
    const data = await addWhitelistUser(parsed.data);
    const sync = await syncLegacyWhitelist();
    return res.status(201).json({ success: true, message: 'WL key hanya ditampilkan sekali. Simpan dengan aman.', data, sync });
  } catch (error) { return next(error); }
});


router.put('/users/:userId/wl-key', async (req, res, next) => {
  try {
    const parsed = z.object({ wlKey: z.string().trim().regex(/^\d{4,32}$/) }).safeParse(req.body);
    if (!parsed.success) throw new AppError('WL key harus berupa angka 4 sampai 32 digit.', 400, 'WL_KEY_INVALID');
    const data = await updateWhitelistUserKey(req.params.userId, parsed.data.wlKey);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.put('/users/:userId/trial', async (req, res, next) => {
  try {
    const parsed = z.object({
      trial: z.string().trim().min(1).max(32).nullable()
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Durasi trial tidak valid.', 400, 'VALIDATION_ERROR');
    const data = await updateWhitelistUserTrial(req.params.userId, parsed.data.trial);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
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
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.get('/blacklist', async (req, res, next) => {
  try { return res.json({ success: true, data: await listWhitelistBlacklist() }); }
  catch (error) { return next(error); }
});

router.post('/blacklist', async (req, res, next) => {
  try {
    const parsed = z.object({
      userId: z.string().regex(/^\d{1,20}$/),
      username: z.string().trim().max(64).optional().default('UNKNOWN'),
      reason: z.string().trim().min(1).max(500)
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Data blacklist tidak valid.', 400, 'VALIDATION_ERROR');
    if (parsed.data.userId === OWNER_USER_ID) throw new AppError('Akun owner tidak boleh dimasukkan ke blacklist.', 400, 'OWNER_BLACKLIST_PROTECTED');
    const data = await addWhitelistBlacklist({ ...parsed.data, bannedBy: req.noxridge.userId });
    const sync = await syncLegacyWhitelist();
    return res.status(201).json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.delete('/blacklist/:userId', async (req, res, next) => {
  try { const data = await removeWhitelistBlacklist(req.params.userId); const sync = await syncLegacyWhitelist(); return res.json({ success: true, data, sync }); }
  catch (error) { return next(error); }
});

router.delete('/users/:userId', async (req, res, next) => {
  try {
    if (!/^\d{1,20}$/.test(req.params.userId)) throw new AppError('Roblox UserId tidak valid.', 400, 'INVALID_USER_ID');
    const data = await removeWhitelistUser(req.params.userId);
    await deletePanelAccessForUser(req.params.userId);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.patch('/users/:userId/revoke', async (req, res, next) => {
  try {
    if (!/^\\d{1,20}$/.test(req.params.userId)) throw new AppError('Roblox UserId tidak valid.', 400, 'INVALID_USER_ID');
    const data = await revokeWhitelistUser(req.params.userId);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.put('/config', async (req, res, next) => {
  try {
    const parsed = z.object({
      globalTrial: z.record(z.string(), z.unknown()).optional(),
      notice: z.record(z.string(), z.unknown()).optional()
    }).refine(value => value.globalTrial !== undefined || value.notice !== undefined).safeParse(req.body);
    if (!parsed.success) throw new AppError('Konfigurasi whitelist tidak valid.', 400, 'VALIDATION_ERROR');
    const data = await updateWhitelistConfig(parsed.data);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});


router.get('/admins', async (req, res, next) => {
  try { return res.json({ success: true, data: await listPanelAdmins() }); }
  catch (error) { return next(error); }
});

router.post('/admins', async (req, res, next) => {
  try {
    const parsed = z.object({
      userId: z.string().regex(/^\d{1,20}$/),
      permissions: z.object({
        view_sessions: z.boolean().optional(),
        send_messages: z.boolean().optional()
      }).optional().default({})
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Data Admin tidak valid.', 400, 'ADMIN_VALIDATION_ERROR');
    const data = await grantPanelAdmin({ ...parsed.data, grantedBy: req.noxridge.userId });
    return res.status(201).json({ success: true, data });
  } catch (error) { return next(error); }
});

router.patch('/admins/:userId', async (req, res, next) => {
  try {
    const parsed = z.object({
      enabled: z.boolean().optional(),
      permissions: z.object({
        view_sessions: z.boolean().optional(),
        send_messages: z.boolean().optional()
      }).optional()
    }).refine(value => value.enabled !== undefined || value.permissions !== undefined).safeParse(req.body);
    if (!parsed.success) throw new AppError('Perubahan Admin tidak valid.', 400, 'ADMIN_VALIDATION_ERROR');
    const data = await updatePanelAdmin(req.params.userId, parsed.data);
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
});

router.delete('/admins/:userId', async (req, res, next) => {
  try { return res.json({ success: true, data: await revokePanelAdmin(req.params.userId) }); }
  catch (error) { return next(error); }
});

export default router;
