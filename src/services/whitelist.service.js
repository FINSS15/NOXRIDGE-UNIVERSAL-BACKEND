import { Pool } from 'pg';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const WL_URL = 'https://raw.githubusercontent.com/FINSS15/Last/refs/heads/main/whitelist.json';
let pool, schemaPromise, cache;
const db = () => {
  if (!env.DATABASE_URL) throw new AppError('User key storage is not configured. Set DATABASE_URL.', 503, 'DATABASE_NOT_CONFIGURED');
  if (!pool) pool = new Pool({ connectionString: env.DATABASE_URL, ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  return pool;
};
const schema = async () => {
  if (!schemaPromise) schemaPromise = db().query(`
    CREATE TABLE IF NOT EXISTS noxridge_wl_users (
      user_id BIGINT PRIMARY KEY, encrypted_key TEXT, iv TEXT, auth_tag TEXT,
      wl_key_hash CHAR(24) NOT NULL, trial_started_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS noxridge_wl_entries (
      user_id BIGINT PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      key_hash CHAR(24) NOT NULL,
      trial TEXT,
      expires TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS noxridge_wl_settings (
      setting_key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS noxridge_wl_asset_operations (
      user_id BIGINT NOT NULL, operation_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, operation_id)
    );
    ALTER TABLE noxridge_wl_asset_operations
      ADD COLUMN IF NOT EXISTS asset_type TEXT,
      ADD COLUMN IF NOT EXISTS creator_type TEXT,
      ADD COLUMN IF NOT EXISTS creator_id TEXT,
      ADD COLUMN IF NOT EXISTS creator_store_status TEXT NOT NULL DEFAULT 'not_requested',
      ADD COLUMN IF NOT EXISTS creator_store_result JSONB,
      ADD COLUMN IF NOT EXISTS creator_store_error TEXT;
    CREATE TABLE IF NOT EXISTS noxridge_wl_open_cloud_key_history (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL,
      encrypted_key TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL,
      key_suffix VARCHAR(8) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS noxridge_wl_open_cloud_key_history_user_created
      ON noxridge_wl_open_cloud_key_history(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS noxridge_wl_storage_objects (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, object_key TEXT NOT NULL UNIQUE,
      filename VARCHAR(255) NOT NULL, category VARCHAR(16) NOT NULL CHECK(category IN ('image','music')),
      content_type VARCHAR(128) NOT NULL, size_bytes BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  try { await schemaPromise; } catch (error) { schemaPromise = undefined; throw error; }
  return db();
};
const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
const wlHash = (value) => {
  const s = `NXR|${String(value)}|${String(value).length}`;
  let a = 2166136261 >>> 0, b = 5381 >>> 0, c = 2654435769 >>> 0;
  for (let i = 1; i <= s.length; i++) {
    const x = s.charCodeAt(i - 1);
    a = (rotl(a, 5) + x + i * 31) >>> 0;
    a = (a ^ (a >>> 13)) >>> 0;
    b = (b * 131 + x) % 4294967296;
    c = (c * 65599 + x) % 4294967296;
    c = (c ^ rotl(a, 7)) >>> 0;
  }
  return [a, b >>> 0, c].map(v => v.toString(16).padStart(8, '0')).join('');
};
const ensureLegacyMigration = async (q) => {
  const client = await q.connect();
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(8142031)");
    const check = await client.query("SELECT 1 FROM noxridge_wl_settings WHERE setting_key='legacy_json_migrated'");
    if (!check.rows.length) {
      let legacy;
      try {
        const response = await fetch(`${WL_URL}?migration=${Date.now()}`, { signal: AbortSignal.timeout(8000), headers: { 'cache-control': 'no-cache' } });
        if (!response.ok) throw new Error('legacy source unavailable');
        legacy = await response.json();
      } catch {
        throw new AppError('Legacy whitelist could not be migrated. Existing WL data was not changed.', 503, 'WHITELIST_MIGRATION_UNAVAILABLE');
      }
      if (!Array.isArray(legacy?.whitelist)) throw new AppError('Legacy whitelist format is invalid.', 503, 'WHITELIST_INVALID');
      for (const entry of legacy.whitelist) {
        if (!/^\d{1,20}$/.test(String(entry?.id ?? '')) || typeof entry?.key !== 'string' || !/^[a-f0-9]{24}$/i.test(entry.key)) continue;
        await client.query(
          `INSERT INTO noxridge_wl_entries(user_id,username,key_hash,trial,expires)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO NOTHING`,
          [String(entry.id), String(entry.name || 'NOXRIDGE_USER').slice(0,64), entry.key.toLowerCase(), entry.trial ? String(entry.trial) : null, entry.expires ? String(entry.expires) : null]
        );
      }
      await client.query(
        "INSERT INTO noxridge_wl_settings(setting_key,value) VALUES('global_trial',$1::jsonb),('notice',$2::jsonb) ON CONFLICT(setting_key) DO NOTHING",
        [JSON.stringify(legacy.global_trial || { status: 'off' }), JSON.stringify(legacy.notice || { status: 'off' })]
      );
      await client.query("INSERT INTO noxridge_wl_settings(setting_key,value) VALUES('legacy_json_migrated','true'::jsonb)");
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
};
const getWhitelist = async () => {
  const q = await schema();
  await ensureLegacyMigration(q);
  const [users, settings] = await Promise.all([
    q.query("SELECT user_id,username,key_hash,trial,expires FROM noxridge_wl_entries WHERE active=TRUE ORDER BY user_id"),
    q.query("SELECT setting_key,value FROM noxridge_wl_settings WHERE setting_key IN ('global_trial','notice')")
  ]);
  const config = Object.fromEntries(settings.rows.map(row => [row.setting_key, row.value]));
  return {
    whitelist: users.rows.map(row => ({
      id: String(row.user_id), name: row.username, key: row.key_hash,
      ...(row.trial ? { trial: row.trial } : {}),
      ...(row.expires ? { expires: row.expires } : {})
    })),
    global_trial: config.global_trial || { status: 'off' },
    notice: config.notice || { status: 'off' }
  };
};
const duration = (value) => {
  if (typeof value === 'number') return value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const units = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0;
  for (const m of value.toLowerCase().matchAll(/(\d+)\s*([smhdw])/g)) total += Number(m[1]) * units[m[2]];
  return total > 0 ? total : null;
};
const expiryWib = (value) => {
  if (typeof value === 'number') return new Date(value * 1000);
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T]*(\d{1,2})?:?(\d{1,2})?$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0) - 7, +(m[5] || 0)));
};

export const authenticateWhitelist = async (idInput, rawKey) => {
  const userId = String(idInput || '').trim();
  if (!/^\d{1,20}$/.test(userId) || !rawKey || String(rawKey).length > 256) throw new AppError('WL identity is invalid.', 401, 'WL_AUTH_INVALID');
  const data = await getWhitelist();
  const entry = data.whitelist.find(v => String(v?.id ?? '') === userId);
  if (!entry || typeof entry.key !== 'string' || wlHash(rawKey).toLowerCase() !== entry.key.toLowerCase()) throw new AppError('Player is not authorized by the current NOXRIDGE whitelist.', 403, 'WL_ACCESS_DENIED');
  const q = await schema();
  const previous = await q.query('SELECT trial_started_at FROM noxridge_wl_users WHERE user_id=$1', [userId]);
  let started = previous.rows[0]?.trial_started_at || null;
  if (entry.trial) {
    const seconds = duration(entry.trial);
    if (!seconds) throw new AppError('Whitelist trial duration is invalid.', 403, 'WL_TRIAL_INVALID');
    if (!started) {
      started = new Date();
      await q.query(`INSERT INTO noxridge_wl_users(user_id,wl_key_hash,trial_started_at) VALUES($1,$2,$3)
        ON CONFLICT(user_id) DO UPDATE SET wl_key_hash=EXCLUDED.wl_key_hash,trial_started_at=COALESCE(noxridge_wl_users.trial_started_at,EXCLUDED.trial_started_at)`, [userId, entry.key, started]);
    }
    if (Date.now() >= new Date(started).getTime() + seconds * 1000) throw new AppError('NOXRIDGE WL trial has expired.', 403, 'WL_TRIAL_EXPIRED');
  }
  if (entry.expires) {
    const exp = expiryWib(entry.expires);
    if (!exp || Date.now() >= exp.getTime()) throw new AppError('NOXRIDGE WL access has expired.', 403, 'WL_ACCESS_EXPIRED');
  }
  await q.query(`INSERT INTO noxridge_wl_users(user_id,wl_key_hash) VALUES($1,$2)
    ON CONFLICT(user_id) DO UPDATE SET wl_key_hash=EXCLUDED.wl_key_hash,updated_at=NOW()`, [userId, entry.key]);
  let expiresAt = null;
  if (entry.trial && started) {
    const seconds = duration(entry.trial);
    if (seconds) expiresAt = Math.floor((new Date(started).getTime() + seconds * 1000) / 1000);
  }
  if (entry.expires) {
    const absolute = expiryWib(entry.expires);
    const absoluteSeconds = absolute ? Math.floor(absolute.getTime() / 1000) : null;
    if (absoluteSeconds && (!expiresAt || absoluteSeconds < expiresAt)) expiresAt = absoluteSeconds;
  }
  return { userId, username: String(entry.name || ''), plan: entry.trial ? 'trial' : 'whitelist', expiresAt };
};
const encrypt = (plain) => {
  if (!env.KEY_ENCRYPTION_SECRET) throw new AppError('Key vault is not configured. Set KEY_ENCRYPTION_SECRET.', 503, 'KEY_VAULT_NOT_CONFIGURED');
  const key = createHash('sha256').update(env.KEY_ENCRYPTION_SECRET).digest(), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { body: body.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
};
const decrypt = (row) => {
  if (!env.KEY_ENCRYPTION_SECRET) throw new AppError('Key vault is not configured.', 503, 'KEY_VAULT_NOT_CONFIGURED');
  const key = createHash('sha256').update(env.KEY_ENCRYPTION_SECRET).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.encrypted_key, 'base64')), decipher.final()]).toString('utf8');
};
const archiveActiveOpenCloudKey = async (client, id) => {
  const current = await client.query(`
    SELECT encrypted_key,iv,auth_tag FROM noxridge_wl_users
    WHERE user_id=$1 AND encrypted_key IS NOT NULL
  `, [id]);
  if (!current.rows[0]) return;
  const row = current.rows[0];
  const plain = decrypt(row);
  await client.query(`
    INSERT INTO noxridge_wl_open_cloud_key_history(user_id,encrypted_key,iv,auth_tag,key_suffix)
    VALUES($1,$2,$3,$4,$5)
  `, [id, row.encrypted_key, row.iv, row.auth_tag, plain.slice(-8)]);
};
export const saveWhitelistOpenCloudKey = async (id, apiKey) => {
  const normalizedApiKey = String(apiKey ?? '').trim();
  if (normalizedApiKey.length < 20) throw new AppError('Roblox Open Cloud key is invalid or empty.', 400, 'ROBLOX_KEY_INVALID');
  const q = await schema(), client = await q.connect(), e = encrypt(normalizedApiKey);
  try {
    await client.query('BEGIN');
    await archiveActiveOpenCloudKey(client, id);
    const saved = await client.query('UPDATE noxridge_wl_users SET encrypted_key=$2,iv=$3,auth_tag=$4,updated_at=NOW() WHERE user_id=$1',
      [id, e.body, e.iv, e.tag]);
    if (saved.rowCount !== 1) throw new AppError('WL user vault record was not found; API Key was not saved.', 409, 'KEY_VAULT_USER_MISSING');
    await client.query(`
      DELETE FROM noxridge_wl_open_cloud_key_history
      WHERE user_id=$1 AND id NOT IN (
        SELECT id FROM noxridge_wl_open_cloud_key_history WHERE user_id=$1
        ORDER BY created_at DESC,id DESC LIMIT 10
      )
    `, [id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
};
export const getWhitelistOpenCloudKeyStatus = async (id) => {
  const q = await schema(), r = await q.query('SELECT encrypted_key,iv,auth_tag,updated_at FROM noxridge_wl_users WHERE user_id=$1', [id]);
  const row = r.rows[0];
  let maskedKey = null;
  if (row?.encrypted_key) {
    const plain = decrypt({ encrypted_key: row.encrypted_key, iv: row.iv, auth_tag: row.auth_tag }).trim();
    maskedKey = `••••••••${plain.slice(-8)}`;
  }
  return {
    configured: Boolean(row?.encrypted_key),
    maskedKey,
    updatedAt: row?.updated_at ?? null
  };
};
export const listWhitelistOpenCloudKeyHistory = async (id) => {
  const q = await schema();
  const r = await q.query(`
    SELECT id,key_suffix,created_at FROM noxridge_wl_open_cloud_key_history
    WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 10
  `, [id]);
  return r.rows.map(row => ({
    id: String(row.id), maskedKey: `••••••••${row.key_suffix}`, createdAt: row.created_at
  }));
};
export const restoreWhitelistOpenCloudKeyHistory = async (id, historyId) => {
  const q = await schema(), client = await q.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`
      SELECT encrypted_key,iv,auth_tag FROM noxridge_wl_open_cloud_key_history
      WHERE user_id=$1 AND id=$2
    `, [id, historyId]);
    if (!found.rows[0]) throw new AppError('Riwayat API Key tidak ditemukan untuk akun WL ini.', 404, 'API_KEY_HISTORY_NOT_FOUND');
    await archiveActiveOpenCloudKey(client, id);
    const old = found.rows[0];
    await client.query('UPDATE noxridge_wl_users SET encrypted_key=$2,iv=$3,auth_tag=$4,updated_at=NOW() WHERE user_id=$1',
      [id, old.encrypted_key, old.iv, old.auth_tag]);
    await client.query(`
      DELETE FROM noxridge_wl_open_cloud_key_history
      WHERE user_id=$1 AND id NOT IN (
        SELECT id FROM noxridge_wl_open_cloud_key_history WHERE user_id=$1
        ORDER BY created_at DESC,id DESC LIMIT 10
      )
    `, [id]);
    await client.query('COMMIT');
    return { restored: true };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
};
export const deleteWhitelistOpenCloudKey = async (id) => {
  const q = await schema(), client = await q.connect();
  try {
    await client.query('BEGIN');
    // Explicit user deletion means permanent removal: do not archive the active key.
    await client.query(
      'UPDATE noxridge_wl_users SET encrypted_key=NULL,iv=NULL,auth_tag=NULL,updated_at=NOW() WHERE user_id=$1',
      [id]
    );
    // Purge only this WL user's saved key history; never affect other users.
    await client.query(
      'DELETE FROM noxridge_wl_open_cloud_key_history WHERE user_id=$1',
      [id]
    );
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
};
export const resolveWhitelistOpenCloudKey = async (id) => {
  const q = await schema(), r = await q.query('SELECT encrypted_key,iv,auth_tag FROM noxridge_wl_users WHERE user_id=$1', [id]);
  if (!r.rows[0]?.encrypted_key) throw new AppError('Masukkan dan simpan Roblox Open Cloud API Key terlebih dahulu.', 400, 'ROBLOX_KEY_NOT_SAVED');
  try {
    return decrypt({ encrypted_key: r.rows[0].encrypted_key, iv: r.rows[0].iv, auth_tag: r.rows[0].auth_tag }).trim();
  } catch (error) {
    console.error('[NOXRIDGE KEY VAULT DECRYPT ERROR]', { userId: String(id), code: error?.code || 'DECRYPT_FAILED' });
    throw new AppError('Saved Roblox API Key could not be decrypted. Check that KEY_ENCRYPTION_SECRET in Render is unchanged.', 500, 'KEY_VAULT_DECRYPT_FAILED');
  }
};
export const saveWhitelistAssetOperation = async (id, operationId, metadata = null) => {
  const q = await schema();
  await q.query(`INSERT INTO noxridge_wl_asset_operations
    (user_id,operation_id,asset_type,creator_type,creator_id,creator_store_status)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(user_id,operation_id) DO UPDATE SET
      asset_type=COALESCE(EXCLUDED.asset_type,noxridge_wl_asset_operations.asset_type),
      creator_type=COALESCE(EXCLUDED.creator_type,noxridge_wl_asset_operations.creator_type),
      creator_id=COALESCE(EXCLUDED.creator_id,noxridge_wl_asset_operations.creator_id)`,
    [id, operationId, metadata?.assetType || null, metadata?.creatorType || null,
      metadata?.creatorId == null ? null : String(metadata.creatorId),
      metadata ? 'pending' : 'not_requested']);
};
export const getWhitelistAssetPublication = async (id, operationId) => {
  const q = await schema();
  const r = await q.query(`SELECT asset_type,creator_type,creator_id,creator_store_status,
    creator_store_result,creator_store_error
    FROM noxridge_wl_asset_operations WHERE user_id=$1 AND operation_id=$2`, [id, operationId]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    assetType: row.asset_type,
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    status: row.creator_store_status,
    result: row.creator_store_result,
    error: row.creator_store_error
  };
};
export const claimWhitelistAssetPublication = async (id, operationId) => {
  const q = await schema();
  const r = await q.query(`UPDATE noxridge_wl_asset_operations
    SET creator_store_status='publishing',creator_store_error=NULL
    WHERE user_id=$1 AND operation_id=$2 AND creator_store_status='pending'
    RETURNING asset_type,creator_type,creator_id`, [id, operationId]);
  if (!r.rows[0]) return null;
  return {
    assetType: r.rows[0].asset_type,
    creatorType: r.rows[0].creator_type,
    creatorId: r.rows[0].creator_id
  };
};
export const finishWhitelistAssetPublication = async (id, operationId, { status, result = null, error = null }) => {
  const q = await schema();
  await q.query(`UPDATE noxridge_wl_asset_operations
    SET creator_store_status=$3,creator_store_result=$4::jsonb,creator_store_error=$5
    WHERE user_id=$1 AND operation_id=$2`,
    [id, operationId, status, result == null ? null : JSON.stringify(result),
      error == null ? null : String(error).slice(0,500)]);
};
export const assertWhitelistAssetOperationOwner = async (id, operationId) => {
  const q = await schema(), r = await q.query('SELECT 1 FROM noxridge_wl_asset_operations WHERE user_id=$1 AND operation_id=$2', [id, operationId]);
  if (!r.rows[0]) throw new AppError('Operation was not created by this WL player.', 404, 'ASSET_OPERATION_NOT_FOUND');
};
export const recordWhitelistStorageObject = async ({ userId, key, filename, category, contentType, size }) => {
  const q = await schema();
  const r = await q.query(`INSERT INTO noxridge_wl_storage_objects(user_id,object_key,filename,category,content_type,size_bytes)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id,filename,category,content_type,size_bytes,created_at`, [userId, key, filename, category, contentType, size]);
  return r.rows[0];
};


// Central whitelist administration. Raw generated keys are returned only once.
export const listWhitelistAdmin = async () => {
  const q = await schema();
  await ensureLegacyMigration(q);
  const [users, settings] = await Promise.all([
    q.query("SELECT user_id,username,trial,expires,active,created_at,updated_at FROM noxridge_wl_entries ORDER BY user_id"),
    q.query("SELECT setting_key,value FROM noxridge_wl_settings WHERE setting_key IN ('global_trial','notice')")
  ]);
  return {
    users: users.rows.map(row => ({
      userId: String(row.user_id), username: row.username, trial: row.trial,
      expires: row.expires, active: row.active, createdAt: row.created_at, updatedAt: row.updated_at
    })),
    config: Object.fromEntries(settings.rows.map(row => [row.setting_key, row.value]))
  };
};
export const addWhitelistUser = async ({ userId, username, trial, expires }) => {
  const q = await schema();
  await ensureLegacyMigration(q);
  if (!/^\d{1,20}$/.test(String(userId))) throw new AppError('Roblox UserId is invalid.', 400, 'INVALID_USER_ID');
  const rawKey = randomBytes(18).toString('hex');
  const keyHash = wlHash(rawKey).toLowerCase();
  await q.query(
    `INSERT INTO noxridge_wl_entries(user_id,username,key_hash,trial,expires,active)
     VALUES($1,$2,$3,$4,$5,TRUE)
     ON CONFLICT(user_id) DO UPDATE SET username=EXCLUDED.username,key_hash=EXCLUDED.key_hash,
       trial=EXCLUDED.trial,expires=EXCLUDED.expires,active=TRUE,updated_at=NOW()`,
    [String(userId), String(username).trim().slice(0,64) || 'NOXRIDGE_USER', keyHash, trial || null, expires || null]
  );
  cache = undefined;
  return { userId: String(userId), username: String(username).trim().slice(0,64) || 'NOXRIDGE_USER', wlKey: rawKey };
};
export const removeWhitelistUser = async (userId) => {
  const q = await schema();
  await ensureLegacyMigration(q);
  const result = await q.query("UPDATE noxridge_wl_entries SET active=FALSE,updated_at=NOW() WHERE user_id=$1 RETURNING user_id", [String(userId)]);
  if (!result.rows[0]) throw new AppError('Whitelist user was not found.', 404, 'WL_USER_NOT_FOUND');
  cache = undefined;
  return { userId: String(userId), revoked: true };
};
export const updateWhitelistConfig = async ({ globalTrial, notice }) => {
  const q = await schema();
  await ensureLegacyMigration(q);
  if (globalTrial !== undefined) await q.query(
    "INSERT INTO noxridge_wl_settings(setting_key,value) VALUES('global_trial',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()",
    [JSON.stringify(globalTrial)]
  );
  if (notice !== undefined) await q.query(
    "INSERT INTO noxridge_wl_settings(setting_key,value) VALUES('notice',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()",
    [JSON.stringify(notice)]
  );
  const data = await getWhitelist();
  return { global_trial: data.global_trial, notice: data.notice };
};
export const getWhitelistPublicConfig = async () => {
  const data = await getWhitelist();
  return { global_trial: data.global_trial, notice: data.notice };
};
