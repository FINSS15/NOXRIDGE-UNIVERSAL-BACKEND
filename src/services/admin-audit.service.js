import { Pool } from 'pg';
import { env } from '../config/env.js';

let pool;
const db = () => {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  if (!pool) pool = new Pool({ connectionString: env.DATABASE_URL, ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined, max: 3 });
  return pool;
};

let schemaPromise;
const ensureSchema = async () => {
  if (!schemaPromise) schemaPromise = db().query(`
    CREATE TABLE IF NOT EXISTS noxridge_admin_activity (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id BIGINT,
      actor_username VARCHAR(64) NOT NULL DEFAULT 'UNKNOWN',
      action VARCHAR(32) NOT NULL,
      resource VARCHAR(96) NOT NULL,
      target_user_id BIGINT,
      http_status INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS noxridge_admin_activity_created ON noxridge_admin_activity(created_at DESC);
  `).catch(error => { schemaPromise = undefined; throw error; });
  await schemaPromise;
  return db();
};

export const recordAdminActivity = async ({ actorUserId, actorUsername, action, resource, targetUserId, httpStatus }) => {
  try {
    const q = await ensureSchema();
    await q.query(
      'INSERT INTO noxridge_admin_activity(actor_user_id,actor_username,action,resource,target_user_id,http_status) VALUES($1,$2,$3,$4,$5,$6)',
      [String(actorUserId || '') || null, String(actorUsername || 'UNKNOWN').slice(0,64), String(action).slice(0,32), String(resource).slice(0,96), /^\\d{1,20}$/.test(String(targetUserId || '')) ? String(targetUserId) : null, Number(httpStatus) || 200]
    );
  } catch (error) {
    // Audit logging must never break the primary admin operation.
    console.error('[admin-audit] Unable to record activity:', error.message);
  }
};

export const listAdminActivity = async (limit = 100) => {
  const q = await ensureSchema();
  const result = await q.query(
    'SELECT id,actor_user_id,actor_username,action,resource,target_user_id,http_status,created_at FROM noxridge_admin_activity ORDER BY created_at DESC,id DESC LIMIT $1',
    [Math.min(250, Math.max(1, Number(limit) || 100))]
  );
  return result.rows.map(row => ({
    id: String(row.id), actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    actorUsername: row.actor_username, action: row.action, resource: row.resource,
    targetUserId: row.target_user_id ? String(row.target_user_id) : null,
    httpStatus: row.http_status, createdAt: row.created_at
  }));
};
