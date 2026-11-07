import { Pool } from 'pg';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const PLAYER_DAILY_LIMIT = 9;
const GLOBAL_DAILY_LIMIT = 450;
const GLOBAL_PER_MINUTE_LIMIT = 12;
const TIME_ZONE = 'America/Los_Angeles';

let pool;
let schemaPromise;

const getPool = () => {
  if (!env.DATABASE_URL) {
    throw new AppError('AI quota storage is not configured. Set DATABASE_URL in Render.', 503, 'AI_QUOTA_STORAGE_NOT_CONFIGURED');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }
  return pool;
};

const ensureSchema = async () => {
  if (!schemaPromise) {
    schemaPromise = getPool().query(`
      CREATE TABLE IF NOT EXISTS noxridge_ai_daily_usage (
        usage_date DATE PRIMARY KEY,
        request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0)
      );
      CREATE TABLE IF NOT EXISTS noxridge_ai_player_daily_usage (
        usage_date DATE NOT NULL,
        user_id BIGINT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
        PRIMARY KEY (usage_date, user_id)
      );
      CREATE TABLE IF NOT EXISTS noxridge_ai_rate_guard (
        guard_id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (guard_id = TRUE)
      );
      INSERT INTO noxridge_ai_rate_guard(guard_id) VALUES(TRUE) ON CONFLICT(guard_id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS noxridge_ai_request_log (
        id BIGSERIAL PRIMARY KEY,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS noxridge_ai_request_log_requested_at_idx
        ON noxridge_ai_request_log(requested_at);
    `);
  }
  try {
    await schemaPromise;
  } catch (error) {
    schemaPromise = undefined;
    throw error;
  }
  return getPool();
};

const getPacificDate = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

export const reserveAiChatQuota = async (userId) => {
  if (!/^\d{1,20}$/.test(String(userId || ''))) {
    throw new AppError('A valid authenticated Roblox UserId is required for NOXRIDGE AI.', 401, 'AI_USER_ID_REQUIRED');
  }

  const db = await ensureSchema();
  const client = await db.connect();
  const now = new Date();
  const usageDate = getPacificDate(now);

  try {
    await client.query('BEGIN');

    await client.query(
      'INSERT INTO noxridge_ai_daily_usage(usage_date,request_count) VALUES($1,0) ON CONFLICT(usage_date) DO NOTHING',
      [usageDate]
    );
    const globalDaily = await client.query(
      'SELECT request_count FROM noxridge_ai_daily_usage WHERE usage_date=$1 FOR UPDATE',
      [usageDate]
    );
    if (Number(globalDaily.rows[0].request_count) >= GLOBAL_DAILY_LIMIT) {
      throw new AppError(
        'NOXRIDGE AI daily free quota is exhausted. It resets at midnight Pacific time. No paid fallback is enabled.',
        429,
        'AI_GLOBAL_DAILY_LIMIT'
      );
    }

    await client.query(
      'INSERT INTO noxridge_ai_player_daily_usage(usage_date,user_id,request_count) VALUES($1,$2,0) ON CONFLICT(usage_date,user_id) DO NOTHING',
      [usageDate, String(userId)]
    );
    const playerDaily = await client.query(
      'SELECT request_count FROM noxridge_ai_player_daily_usage WHERE usage_date=$1 AND user_id=$2 FOR UPDATE',
      [usageDate, String(userId)]
    );
    if (Number(playerDaily.rows[0].request_count) >= PLAYER_DAILY_LIMIT) {
      throw new AppError(
        'Daily NOXRIDGE AI limit reached: 9 chats per player. Please try again after the daily reset.',
        429,
        'AI_PLAYER_DAILY_LIMIT'
      );
    }

    // Serialize the rolling 60-second counter across all backend instances.
    await client.query('SELECT guard_id FROM noxridge_ai_rate_guard WHERE guard_id=TRUE FOR UPDATE');
    await client.query("DELETE FROM noxridge_ai_request_log WHERE requested_at < NOW() - INTERVAL '60 seconds'");
    const minuteUsage = await client.query('SELECT COUNT(*)::INTEGER AS request_count FROM noxridge_ai_request_log');
    if (Number(minuteUsage.rows[0].request_count) >= GLOBAL_PER_MINUTE_LIMIT) {
      throw new AppError(
        'NOXRIDGE AI is busy. The free-tier request rate is temporarily full; wait a minute and try again.',
        429,
        'AI_GLOBAL_PER_MINUTE_LIMIT'
      );
    }

    await client.query(
      'UPDATE noxridge_ai_daily_usage SET request_count=request_count+1 WHERE usage_date=$1',
      [usageDate]
    );
    await client.query(
      'UPDATE noxridge_ai_player_daily_usage SET request_count=request_count+1 WHERE usage_date=$1 AND user_id=$2',
      [usageDate, String(userId)]
    );
    await client.query('INSERT INTO noxridge_ai_request_log(requested_at) VALUES(NOW())');

    await client.query('COMMIT');

    return {
      playerRemaining: Math.max(0, PLAYER_DAILY_LIMIT - Number(playerDaily.rows[0].request_count) - 1),
      globalRemaining: Math.max(0, GLOBAL_DAILY_LIMIT - Number(globalDaily.rows[0].request_count) - 1),
      playerDailyLimit: PLAYER_DAILY_LIMIT,
      globalDailyLimit: GLOBAL_DAILY_LIMIT,
      globalPerMinuteLimit: GLOBAL_PER_MINUTE_LIMIT,
      resetTimeZone: TIME_ZONE
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};
