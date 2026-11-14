import { Pool } from 'pg';
import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const scrypt = promisify(scryptCallback);
const OWNER_USER_ID = '8172230031';
export const ADMIN_PERMISSIONS = ['view_sessions', 'send_messages'];
let pool;
let schemaPromise;

const db = () => {
  if (!env.DATABASE_URL) throw new AppError('Admin role storage is not configured. Set DATABASE_URL.', 503, 'DATABASE_NOT_CONFIGURED');
  if (!pool) pool = new Pool({ connectionString: env.DATABASE_URL, ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined, max: 5 });
  return pool;
};

const ensureSchema = async () => {
  if (!schemaPromise) {
    schemaPromise = db().query(
      'CREATE TABLE IF NOT EXISTS noxridge_panel_access (' +
      ' user_id BIGINT PRIMARY KEY, panel_key_salt TEXT, panel_key_hash TEXT,' +
      " role VARCHAR(16) NOT NULL DEFAULT 'player' CHECK (role IN ('player','admin'))," +
      ' enabled BOOLEAN NOT NULL DEFAULT TRUE,' +
      " permissions JSONB NOT NULL DEFAULT '{}'::jsonb," +
      ' created_by BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),' +
      ' CHECK ((panel_key_salt IS NULL AND panel_key_hash IS NULL) OR (panel_key_salt IS NOT NULL AND panel_key_hash IS NOT NULL))' +
      '); CREATE INDEX IF NOT EXISTS noxridge_panel_access_role_enabled ON noxridge_panel_access(role,enabled);'
    );
    try { await schemaPromise; } catch (error) { schemaPromise = undefined; throw error; }
  }
  return db();
};

const normalizePermissions = (value = {}) => Object.fromEntries(ADMIN_PERMISSIONS.map(key => [key, value?.[key] === true]));
const validateUserId = (value) => {
  const id = String(value ?? '');
  if (!/^\d{1,20}$/.test(id)) throw new AppError('Roblox UserId tidak valid.', 400, 'INVALID_USER_ID');
  if (id === OWNER_USER_ID) throw new AppError('Owner tidak dapat diubah menjadi Admin.', 400, 'OWNER_ROLE_PROTECTED');
  return id;
};
const validatePanelKey = (value) => {
  const key = String(value ?? '').trim();
  if (!/^\d{4,32}$/.test(key)) throw new AppError('Panel Access Key harus berupa angka 4 sampai 32 digit.', 400, 'PANEL_KEY_INVALID');
  return key;
};
const hashPanelKey = async (key) => {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: Buffer.from(await scrypt(key, salt, 64)).toString('hex') };
};
const verifyPanelKey = async (key, salt, expectedHash) => {
  const actual = Buffer.from(await scrypt(key, salt, 64));
  const expected = Buffer.from(expectedHash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export const setPlayerPanelKey = async (userId, rawKey, changedBy) => {
  const id = validateUserId(userId);
  const hashed = await hashPanelKey(validatePanelKey(rawKey));
  const q = await ensureSchema();
  const exists = await q.query('SELECT 1 FROM noxridge_wl_entries WHERE user_id=$1 AND active=TRUE', [id]);
  if (!exists.rowCount) throw new AppError('Player aktif tidak ditemukan di whitelist.', 404, 'WL_USER_NOT_FOUND');
  await q.query(
    "INSERT INTO noxridge_panel_access(user_id,panel_key_salt,panel_key_hash,role,enabled,created_by) VALUES($1,$2,$3,'player',TRUE,$4) " +
    'ON CONFLICT(user_id) DO UPDATE SET panel_key_salt=EXCLUDED.panel_key_salt,panel_key_hash=EXCLUDED.panel_key_hash,enabled=TRUE,updated_at=NOW()',
    [id, hashed.salt, hashed.hash, String(changedBy)]
  );
  return { userId: id, panelKeyConfigured: true };
};

export const verifyPlayerPanelAccess = async (userId) => {
  const id = String(userId ?? '');
  if (!/^\d{1,20}$/.test(id)) throw new AppError('Roblox UserId tidak valid.', 401, 'PANEL_AUTH_INVALID');
  if (id === OWNER_USER_ID) return { authenticated: true, role: 'owner', permissions: { all: true } };
  const q = await ensureSchema();
  const result = await q.query(
    "SELECT p.role,p.enabled,p.permissions FROM noxridge_panel_access p " +
    'JOIN noxridge_wl_entries w ON w.user_id=p.user_id AND w.active=TRUE LEFT JOIN noxridge_wl_blacklist b ON b.user_id=p.user_id ' +
    "WHERE p.user_id=$1 AND b.user_id IS NULL", [id]
  );
  const row = result.rows[0];
  if (!row || row.role !== 'admin' || !row.enabled) throw new AppError('Akun ini bukan Admin panel yang aktif.', 403, 'PANEL_ADMIN_REQUIRED');
  return { authenticated: true, role: 'admin', enabled: true, permissions: normalizePermissions(row.permissions) };
};

export const listPanelAdmins = async () => {
  const q = await ensureSchema();
  const result = await q.query(
    "SELECT p.user_id,w.username,p.enabled,p.permissions,p.created_at,p.updated_at FROM noxridge_panel_access p JOIN noxridge_wl_entries w ON w.user_id=p.user_id WHERE p.role='admin' ORDER BY p.created_at DESC"
  );
  return result.rows.map(row => ({ userId: String(row.user_id), username: row.username, enabled: row.enabled, permissions: normalizePermissions(row.permissions), createdAt: row.created_at, updatedAt: row.updated_at }));
};

export const grantPanelAdmin = async ({ userId, permissions = {}, grantedBy }) => {
  const id = validateUserId(userId);
  const q = await ensureSchema();
  const exists = await q.query('SELECT 1 FROM noxridge_wl_entries WHERE user_id=$1 AND active=TRUE', [id]);
  if (!exists.rowCount) throw new AppError('Admin harus terdaftar sebagai player whitelist aktif terlebih dahulu.', 404, 'WL_USER_NOT_FOUND');
  const result = await q.query(
    "INSERT INTO noxridge_panel_access(user_id,role,enabled,permissions,created_by) VALUES($1,'admin',TRUE,$2::jsonb,$3) " +
    "ON CONFLICT(user_id) DO UPDATE SET role='admin',enabled=TRUE,permissions=EXCLUDED.permissions,created_by=EXCLUDED.created_by,updated_at=NOW() RETURNING user_id,enabled,permissions",
    [id, JSON.stringify(normalizePermissions(permissions)), String(grantedBy)]
  );
  return { userId: String(result.rows[0].user_id), role: 'admin', enabled: result.rows[0].enabled, permissions: normalizePermissions(result.rows[0].permissions) };
};

export const updatePanelAdmin = async (userId, { enabled, permissions }) => {
  const id = validateUserId(userId);
  if (enabled === undefined && permissions === undefined) throw new AppError('Tidak ada perubahan Admin yang dikirim.', 400, 'ADMIN_UPDATE_EMPTY');
  const q = await ensureSchema();
  const current = await q.query("SELECT permissions FROM noxridge_panel_access WHERE user_id=$1 AND role='admin'", [id]);
  if (!current.rows[0]) throw new AppError('Admin tidak ditemukan.', 404, 'ADMIN_NOT_FOUND');
  const nextPermissions = permissions === undefined ? normalizePermissions(current.rows[0].permissions) : normalizePermissions(permissions);
  const result = await q.query(
    "UPDATE noxridge_panel_access SET enabled=COALESCE($2,enabled),permissions=$3::jsonb,updated_at=NOW() WHERE user_id=$1 AND role='admin' RETURNING user_id,enabled,permissions",
    [id, enabled ?? null, JSON.stringify(nextPermissions)]
  );
  return { userId: String(result.rows[0].user_id), role: 'admin', enabled: result.rows[0].enabled, permissions: normalizePermissions(result.rows[0].permissions) };
};

export const revokePanelAdmin = async (userId) => {
  const id = validateUserId(userId);
  const q = await ensureSchema();
  const result = await q.query(
    "UPDATE noxridge_panel_access SET role='player',permissions='{}'::jsonb,enabled=FALSE,updated_at=NOW() WHERE user_id=$1 AND role='admin' RETURNING user_id",
    [id]
  );
  if (!result.rowCount) throw new AppError('Admin tidak ditemukan.', 404, 'ADMIN_NOT_FOUND');
  return { userId: id, revoked: true };
};

export const deletePanelAccessForUser = async (userId) => {
  const id = String(userId ?? '');
  if (!/^\\d{1,20}$/.test(id)) throw new AppError('Roblox UserId tidak valid.', 400, 'INVALID_USER_ID');
  if (id === OWNER_USER_ID) throw new AppError('Owner tidak dapat dihapus.', 400, 'OWNER_ROLE_PROTECTED');
  const q = await ensureSchema();
  await q.query('DELETE FROM noxridge_panel_access WHERE user_id=$1', [id]);
  return { userId: id, deleted: true };
};


export const requirePanelPermission = (permission) => async (req, res, next) => {
  try {
    const id = String(req.noxridge?.userId ?? '');
    if (id === OWNER_USER_ID) return next();
    if (!ADMIN_PERMISSIONS.includes(permission)) throw new AppError('Permission tidak dikenal.', 403, 'ADMIN_PERMISSION_UNKNOWN');
    const q = await ensureSchema();
    const result = await q.query(
      "SELECT p.enabled,p.permissions FROM noxridge_panel_access p JOIN noxridge_wl_entries w ON w.user_id=p.user_id AND w.active=TRUE " +
      "LEFT JOIN noxridge_wl_blacklist b ON b.user_id=p.user_id WHERE p.user_id=$1 AND p.role='admin' AND b.user_id IS NULL", [id]
    );
    const row = result.rows[0];
    if (!row || !row.enabled || row.permissions?.[permission] !== true) throw new AppError('Aksi ini tidak diizinkan untuk Admin akun kamu.', 403, 'ADMIN_PERMISSION_DENIED', { permission });
    return next();
  } catch (error) { return next(error); }
};
