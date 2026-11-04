import { Pool } from 'pg';
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv
} from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const scrypt = promisify(scryptCallback);
let pool;
let schemaReady;

const getPool = () => {
  if (!env.DATABASE_URL) {
    throw new AppError('Account storage is not configured. Set DATABASE_URL.', 503, 'DATABASE_NOT_CONFIGURED');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
};

const ensureSchema = async () => {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS noxridge_accounts (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(32) NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        plan VARCHAR(16) NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial','permanent')),
        trial_expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS noxridge_sessions (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES noxridge_accounts(id) ON DELETE CASCADE,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS noxridge_sessions_account_idx ON noxridge_sessions(account_id);
      CREATE TABLE IF NOT EXISTS noxridge_opencloud_keys (
        account_id BIGINT PRIMARY KEY REFERENCES noxridge_accounts(id) ON DELETE CASCADE,
        encrypted_key TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }
  try {
    await schemaReady;
  } catch (error) {
    schemaReady = undefined;
    throw error;
  }
  return getPool();
};

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

const derivePassword = async (password, salt) => {
  const result = await scrypt(password, salt, 64);
  return Buffer.from(result).toString('hex');
};

const encryptKey = (plainText) => {
  if (!env.KEY_ENCRYPTION_SECRET) {
    throw new AppError('Key vault is not configured. Set KEY_ENCRYPTION_SECRET.', 503, 'KEY_VAULT_NOT_CONFIGURED');
  }
  const key = createHash('sha256').update(env.KEY_ENCRYPTION_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return {
    encryptedKey: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64')
  };
};

// Kept for controlled backend-to-Roblox service use; never return this value to clients.
export const decryptStoredOpenCloudKey = (record) => {
  if (!env.KEY_ENCRYPTION_SECRET) throw new AppError('Key vault is not configured.', 503, 'KEY_VAULT_NOT_CONFIGURED');
  const key = createHash('sha256').update(env.KEY_ENCRYPTION_SECRET).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.encrypted_key, 'base64')),
    decipher.final()
  ]).toString('utf8');
};

export const registerAccount = async ({ username, password }) => {
  const db = await ensureSchema();
  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(normalized)) {
    throw new AppError('Username must be 3-32 characters using letters, numbers, or underscore.', 400, 'INVALID_USERNAME');
  }
  if (password.length < 10 || password.length > 128) {
    throw new AppError('Password must be 10-128 characters.', 400, 'INVALID_PASSWORD');
  }
  const salt = randomBytes(16).toString('hex');
  const passwordHash = await derivePassword(password, salt);
  const trialHours = env.TRIAL_DURATION_HOURS ?? 24;
  try {
    const result = await db.query(
      'INSERT INTO noxridge_accounts (username,password_salt,password_hash,trial_expires_at) VALUES ($1,$2,$3,NOW() + ($4 * INTERVAL \'1 hour\')) RETURNING id,username,plan,trial_expires_at,created_at',
      [normalized, salt, passwordHash, trialHours]
    );
    return createSession(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') throw new AppError('Username is already registered.', 409, 'USERNAME_TAKEN');
    throw error;
  }
};

export const loginAccount = async ({ username, password }) => {
  const db = await ensureSchema();
  const result = await db.query('SELECT * FROM noxridge_accounts WHERE username = $1', [username.trim().toLowerCase()]);
  const account = result.rows[0];
  if (!account) throw new AppError('Invalid username or password.', 401, 'INVALID_CREDENTIALS');
  const actual = Buffer.from(await derivePassword(password, account.password_salt), 'hex');
  const expected = Buffer.from(account.password_hash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError('Invalid username or password.', 401, 'INVALID_CREDENTIALS');
  }
  return createSession(account);
};

const createSession = async (account) => {
  const db = await ensureSchema();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.query(
    'INSERT INTO noxridge_sessions (account_id,token_hash,expires_at) VALUES ($1,$2,$3)',
    [account.id, hashToken(token), expiresAt]
  );
  return {
    token,
    expiresAt: expiresAt.toISOString(),
    account: publicAccount(account)
  };
};

const publicAccount = (account) => {
  const trialExpired = account.plan === 'trial' && new Date(account.trial_expires_at) <= new Date();
  return {
    id: account.id,
    username: account.username,
    plan: account.plan,
    trialExpiresAt: account.trial_expires_at,
    trialExpired
  };
};

export const authenticateSession = async (token) => {
  const db = await ensureSchema();
  const result = await db.query(
    `SELECT a.id,a.username,a.plan,a.trial_expires_at,a.created_at
     FROM noxridge_sessions s
     JOIN noxridge_accounts a ON a.id=s.account_id
     WHERE s.token_hash=$1 AND s.expires_at > NOW()`,
    [hashToken(token)]
  );
  if (!result.rows[0]) throw new AppError('Session is invalid or expired.', 401, 'SESSION_INVALID');
  return publicAccount(result.rows[0]);
};

export const logoutSession = async (token) => {
  const db = await ensureSchema();
  await db.query('DELETE FROM noxridge_sessions WHERE token_hash=$1', [hashToken(token)]);
};

export const saveOpenCloudKey = async (accountId, apiKey) => {
  const db = await ensureSchema();
  const accountResult = await db.query('SELECT plan,trial_expires_at FROM noxridge_accounts WHERE id=$1', [accountId]);
  const account = accountResult.rows[0];
  if (!account) throw new AppError('Account not found.', 404, 'ACCOUNT_NOT_FOUND');
  if (account.plan !== 'permanent') {
    throw new AppError('Trial accounts must provide their Open Cloud key per request. It is not stored.', 403, 'TRIAL_KEY_NOT_STORED');
  }
  const encrypted = encryptKey(apiKey);
  await db.query(
    `INSERT INTO noxridge_opencloud_keys (account_id,encrypted_key,iv,auth_tag)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (account_id) DO UPDATE SET encrypted_key=EXCLUDED.encrypted_key,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,updated_at=NOW()`,
    [accountId, encrypted.encryptedKey, encrypted.iv, encrypted.authTag]
  );
};

export const getOpenCloudKeyStatus = async (accountId) => {
  const db = await ensureSchema();
  const result = await db.query('SELECT updated_at FROM noxridge_opencloud_keys WHERE account_id=$1', [accountId]);
  return { configured: Boolean(result.rows[0]), updatedAt: result.rows[0]?.updated_at ?? null };
};

export const deleteOpenCloudKey = async (accountId) => {
  const db = await ensureSchema();
  await db.query('DELETE FROM noxridge_opencloud_keys WHERE account_id=$1', [accountId]);
};

export const promoteAccount = async (username) => {
  const db = await ensureSchema();
  const result = await db.query(
    `UPDATE noxridge_accounts SET plan='permanent' WHERE username=$1
     RETURNING id,username,plan,trial_expires_at,created_at`,
    [username.trim().toLowerCase()]
  );
  if (!result.rows[0]) throw new AppError('Account not found.', 404, 'ACCOUNT_NOT_FOUND');
  return publicAccount(result.rows[0]);
};

export const accountDatabaseReady = async () => {
  const db = await ensureSchema();
  await db.query('SELECT 1');
  return true;
};

export const resolveAccountOpenCloudKey = async (accountId, transientKey) => {
  const db = await ensureSchema();
  const result = await db.query(
    'SELECT a.plan,a.trial_expires_at,k.encrypted_key,k.iv,k.auth_tag FROM noxridge_accounts a LEFT JOIN noxridge_opencloud_keys k ON k.account_id=a.id WHERE a.id=$1',
    [accountId]
  );
  const account = result.rows[0];
  if (!account) throw new AppError('Account not found.', 404, 'ACCOUNT_NOT_FOUND');
  if (account.plan === 'trial') {
    if (new Date(account.trial_expires_at) <= new Date()) {
      throw new AppError('Your trial has expired.', 403, 'TRIAL_EXPIRED');
    }
    if (!transientKey) {
      throw new AppError('Trial accounts must send x-roblox-open-cloud-key for each Roblox asset operation.', 400, 'ROBLOX_KEY_REQUIRED');
    }
    return transientKey;
  }
  if (!account.encrypted_key) {
    throw new AppError('Save your Roblox Open Cloud key in your account first.', 400, 'ROBLOX_KEY_NOT_SAVED');
  }
  return decryptStoredOpenCloudKey({
    encrypted_key: account.encrypted_key,
    iv: account.iv,
    auth_tag: account.auth_tag
  });
};
