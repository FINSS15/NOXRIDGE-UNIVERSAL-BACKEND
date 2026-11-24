import { Router } from 'express';
import { z } from 'zod';
import { requireWhitelist } from '../middleware/whitelistAuth.js';
import {
  listWhitelistAdmin,
  getWhitelistLegacySnapshot,
  addWhitelistUser,
  provisionWhitelistUser,
  updateWhitelistUserTrial,
  adjustWhitelistUserTrial,
  updateWhitelistUserExpiry,
  updateWhitelistUserKey,
  removeWhitelistUser,
  revokeWhitelistUser,
  updateWhitelistConfig,
  updateWhitelistUserPermissions,
  WHITELIST_FEATURES,
  listWhitelistBlacklist,
  addWhitelistBlacklist,
  removeWhitelistBlacklist
} from '../services/whitelist.service.js';
import { AppError } from '../utils/errors.js';
import { syncLegacyWhitelistJson } from '../services/legacy-whitelist-sync.service.js';
import { listPanelAdmins, grantPanelAdmin, updatePanelAdmin, revokePanelAdmin, deletePanelAccessForUser, requirePanelPermission } from '../services/admin-role.service.js';
import { deleteUserPresenceAndMessages } from '../services/presence-message.service.js';
import { auditAdminActivity } from '../middleware/admin-audit.js';
import { listAdminActivity } from '../services/admin-audit.service.js';

const syncLegacyWhitelist = async () => syncLegacyWhitelistJson(await getWhitelistLegacySnapshot());

const router = Router();
const OWNER_USER_ID = '8172230031';

const requireOwner = (req, res, next) => {
  if (String(req.noxridge?.userId || '') !== OWNER_USER_ID) {
    return next(new AppError('Admin Panel hanya dapat diakses oleh owner NOXRIDGE.', 403, 'ADMIN_OWNER_ONLY'));
  }
  return next();
};

const assertManageablePlayerTarget = async (req, targetUserId) => {
  const callerId = String(req.noxridge?.userId || '');
  const targetId = String(targetUserId || '');
  if (callerId === OWNER_USER_ID) return;
  if (targetId === OWNER_USER_ID) {
    throw new AppError('Akun Owner tidak dapat dikelola oleh Admin.', 403, 'OWNER_PLAYER_PROTECTED');
  }
  const admins = await listPanelAdmins();
  if (admins.some(admin => String(admin.userId) === targetId)) {
    throw new AppError('Akun Admin lain tidak dapat dikelola melalui Player Management.', 403, 'ADMIN_PLAYER_PROTECTED');
  }
};

// Every request authenticates with the caller's own active Importer WL key.
// Owner-only operations remain protected individually; player management can be delegated.
router.use(requireWhitelist);
router.use(auditAdminActivity);

router.get('/session', requireOwner, (req, res) => res.json({
  success: true,
  authenticated: true,
  owner: { userId: req.noxridge.userId, username: req.noxridge.username }
}));

router.get('/activity', requireOwner, async (req, res, next) => {
  try { return res.json({ success: true, data: await listAdminActivity(150) }); }
  catch (error) { return next(error); }
});

router.get('/users', requirePanelPermission('manage_players'), async (req, res, next) => {
  try { return res.json({ success: true, data: await listWhitelistAdmin() }); }
  catch (error) { return next(error); }
});


router.post('/users/provision', requirePanelPermission('manage_players'), async (req, res, next) => {
  try {
    const parsed = z.object({
      userId: z.string().regex(/^\d{1,20}$/),
      username: z.string().trim().min(1).max(64),
      wlKey: z.string().trim().regex(/^\d{4,32}$/),
      trial: z.string().trim().max(32).optional().nullable(),
      expires: z.string().trim().max(40).optional().nullable(),
      role: z.enum(['PLAYER', 'ADMIN']).default('PLAYER'),
      permissions: z.object({
        mode: z.enum(['all', 'custom']),
        features: z.record(z.string(), z.boolean()).default({})
      }),
      adminPermissions: z.object({
        view_sessions: z.boolean().optional().default(false),
        send_messages: z.boolean().optional().default(false),
        manage_players: z.boolean().optional().default(false)
      }).optional().default({})
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Data provisioning tidak valid.', 400, 'PROVISION_VALIDATION_ERROR');
    const unknown = Object.keys(parsed.data.permissions.features).filter(key => !WHITELIST_FEATURES.includes(key));
    if (unknown.length) throw new AppError('Ada nama Player Feature yang tidak dikenal.', 400, 'UNKNOWN_FEATURE');
    if (parsed.data.role === 'ADMIN' && String(req.noxridge?.userId || '') !== OWNER_USER_ID) {
      throw new AppError('Hanya Owner yang dapat membuat Admin.', 403, 'ADMIN_OWNER_ONLY');
    }
    const data = await provisionWhitelistUser({
      ...parsed.data,
      grantedBy: req.noxridge.userId
    });
    // PostgreSQL provisioning is already committed atomically by the service.
    // A legacy JSON mirror failure must not turn a successful DB save into an
    // apparent failed request that encourages duplicate retries.
    let sync = { success: true };
    try {
      const result = await syncLegacyWhitelist();
      sync = { success: true, result };
    } catch (syncError) {
      console.error('[ADMIN PANEL] Player saved to PostgreSQL but legacy whitelist sync failed:', syncError);
      sync = { success: false, warning: 'Player tersimpan di PostgreSQL, tetapi sinkronisasi legacy whitelist gagal. Coba sinkronisasi ulang; jangan buat player yang sama lagi.' };
    }
    return res.status(201).json({
      success: true,
      persisted: true,
      message: 'Player berhasil disimpan ke PostgreSQL. WL key hanya ditampilkan sekali; simpan dengan aman.',
      data,
      sync
    });
  } catch (error) { return next(error); }
});

router.post('/users', requirePanelPermission('manage_players'), async (req, res, next) => {
  try {
    const parsed = z.object({
      userId: z.string().regex(/^\d{1,20}$/),
      username: z.string().trim().min(1).max(64),
      trial: z.string().trim().max(32).optional().nullable(),
      expires: z.string().trim().max(40).optional().nullable(),
      wlKey: z.string().trim().regex(/^\d{4,32}$/)
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Whitelist user data is invalid. WL key must be 4–32 digits.', 400, 'VALIDATION_ERROR');
    // Admins may add new players only; they cannot overwrite existing entries or privileged accounts.
    if (String(req.noxridge?.userId || '') !== OWNER_USER_ID) {
      if (parsed.data.userId === OWNER_USER_ID) throw new AppError('Akun Owner tidak dapat dikelola oleh Admin.', 403, 'OWNER_PLAYER_PROTECTED');
      const current = await listWhitelistAdmin();
      if (current.users.some(user => String(user.userId) === parsed.data.userId)) {
        throw new AppError('Player sudah terdaftar. Admin hanya dapat menambahkan player baru.', 409, 'WL_USER_ALREADY_EXISTS');
      }
      await assertManageablePlayerTarget(req, parsed.data.userId);
    }
    const data = await addWhitelistUser(parsed.data);
    const sync = await syncLegacyWhitelist();
    return res.status(201).json({ success: true, message: 'WL key hanya ditampilkan sekali. Simpan dengan aman.', data, sync });
  } catch (error) { return next(error); }
});

router.put('/users/:userId/wl-key', requireOwner, async (req, res, next) => {
  try {
    const parsed = z.object({ wlKey: z.string().trim().regex(/^\d{4,32}$/) }).safeParse(req.body);
    if (!parsed.success) throw new AppError('WL key harus berupa angka 4 sampai 32 digit.', 400, 'WL_KEY_INVALID');
    const data = await updateWhitelistUserKey(req.params.userId, parsed.data.wlKey);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.put('/users/:userId/expiry', requirePanelPermission('manage_players'), async (req, res, next) => {
  try {
    const parsed = z.object({
      expires: z.string().trim().max(40).nullable()
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Expiry WIB tidak valid.', 400, 'VALIDATION_ERROR');
    await assertManageablePlayerTarget(req, req.params.userId);
    const data = await updateWhitelistUserExpiry(req.params.userId, parsed.data.expires);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.put('/users/:userId/trial', requirePanelPermission('manage_players'), async (req, res, next) => {
  try {
    const parsed = z.object({
      trial: z.string().trim().min(1).max(32).nullable()
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Durasi trial tidak valid.', 400, 'VALIDATION_ERROR');
    await assertManageablePlayerTarget(req, req.params.userId);
    const data = await updateWhitelistUserTrial(req.params.userId, parsed.data.trial);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.post('/users/:userId/trial-adjust', requirePanelPermission('manage_players'), async (req, res, next) => {
  try {
    const parsed = z.object({ deltaSeconds: z.number().int().refine(value => value !== 0 && Math.abs(value) <= 315360000) }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Perubahan durasi trial tidak valid.', 400, 'WL_TRIAL_ADJUST_INVALID');
    await assertManageablePlayerTarget(req, req.params.userId);
    const data = await adjustWhitelistUserTrial(req.params.userId, parsed.data.deltaSeconds);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.put('/users/:userId/permissions', requirePanelPermission('manage_players'), async (req, res, next) => {
  try {
    const parsed = z.object({
      mode: z.enum(['all', 'custom']),
      features: z.record(z.string(), z.boolean()).optional().default({})
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Pengaturan izin fitur tidak valid.', 400, 'VALIDATION_ERROR');
    const unknown = Object.keys(parsed.data.features).filter(key => !WHITELIST_FEATURES.includes(key));
    if (unknown.length) throw new AppError('Ada nama fitur yang tidak dikenal.', 400, 'UNKNOWN_FEATURE');
    await assertManageablePlayerTarget(req, req.params.userId);
    const data = await updateWhitelistUserPermissions(req.params.userId, parsed.data);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.get('/blacklist', requireOwner, async (req, res, next) => {
  try { return res.json({ success: true, data: await listWhitelistBlacklist() }); }
  catch (error) { return next(error); }
});

router.post('/blacklist', requireOwner, async (req, res, next) => {
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

router.delete('/blacklist/:userId', requireOwner, async (req, res, next) => {
  try { const data = await removeWhitelistBlacklist(req.params.userId); const sync = await syncLegacyWhitelist(); return res.json({ success: true, data, sync }); }
  catch (error) { return next(error); }
});

router.delete('/users/:userId', requireOwner, async (req, res, next) => {
  try {
    if (!/^\d{1,20}$/.test(req.params.userId)) throw new AppError('Roblox UserId tidak valid.', 400, 'INVALID_USER_ID');
    // Fail closed: remove panel access and live inbox state before permanent deletion.
    const panelAccess = await deletePanelAccessForUser(req.params.userId);
    const presence = await deleteUserPresenceAndMessages(req.params.userId);
    const data = await removeWhitelistUser(req.params.userId);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, panelAccess, presence, sync });
  } catch (error) { return next(error); }
});

router.patch('/users/:userId/revoke', requireOwner, async (req, res, next) => {
  try {
    if (!/^\d{1,20}$/.test(req.params.userId)) throw new AppError('Roblox UserId tidak valid.', 400, 'INVALID_USER_ID');
    const data = await revokeWhitelistUser(req.params.userId);
    const sync = await syncLegacyWhitelist();
    return res.json({ success: true, data, sync });
  } catch (error) { return next(error); }
});

router.put('/config', requireOwner, async (req, res, next) => {
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

router.get('/admins', requireOwner, async (req, res, next) => {
  try { return res.json({ success: true, data: await listPanelAdmins() }); }
  catch (error) { return next(error); }
});

router.post('/admins', requireOwner, async (req, res, next) => {
  try {
    const parsed = z.object({
      userId: z.string().regex(/^\d{1,20}$/),
      permissions: z.object({
        view_sessions: z.boolean().optional(),
        send_messages: z.boolean().optional(),
        manage_players: z.boolean().optional()
      }).optional().default({})
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Data Admin tidak valid.', 400, 'ADMIN_VALIDATION_ERROR');
    const data = await grantPanelAdmin({ ...parsed.data, grantedBy: req.noxridge.userId });
    return res.status(201).json({ success: true, data });
  } catch (error) { return next(error); }
});

router.patch('/admins/:userId', requireOwner, async (req, res, next) => {
  try {
    const parsed = z.object({
      enabled: z.boolean().optional(),
      permissions: z.object({
        view_sessions: z.boolean().optional(),
        send_messages: z.boolean().optional(),
        manage_players: z.boolean().optional()
      }).optional()
    }).refine(value => value.enabled !== undefined || value.permissions !== undefined).safeParse(req.body);
    if (!parsed.success) throw new AppError('Perubahan Admin tidak valid.', 400, 'ADMIN_VALIDATION_ERROR');
    const data = await updatePanelAdmin(req.params.userId, parsed.data);
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
});

router.delete('/admins/:userId', requireOwner, async (req, res, next) => {
  try { return res.json({ success: true, data: await revokePanelAdmin(req.params.userId) }); }
  catch (error) { return next(error); }
});

export default router;
