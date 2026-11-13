import { Pool } from 'pg';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

let pool;
let schemaPromise;

const db = () => {
  if (!env.DATABASE_URL) throw new AppError('Presence storage is not configured. Set DATABASE_URL.', 503, 'DATABASE_NOT_CONFIGURED');
  if (!pool) pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  return pool;
};

const ensureSchema = async () => {
  if (!schemaPromise) {
    schemaPromise = db().query([
      'CREATE TABLE IF NOT EXISTS noxridge_importer_presence (',
      ' user_id BIGINT PRIMARY KEY, username VARCHAR(64) NOT NULL,',
      ' session_id VARCHAR(80) NOT NULL, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      ');',
      'CREATE INDEX IF NOT EXISTS noxridge_importer_presence_last_seen ON noxridge_importer_presence(last_seen DESC);',
      'CREATE TABLE IF NOT EXISTS noxridge_importer_messages (',
      ' id BIGSERIAL PRIMARY KEY, recipient_user_id BIGINT NOT NULL, sender_user_id BIGINT NOT NULL,',
      ' sender_username VARCHAR(64) NOT NULL, message_type VARCHAR(16) NOT NULL CHECK (message_type IN (\\'broadcast\\',\\'private\\')),',
      ' title VARCHAR(120) NOT NULL, body VARCHAR(1200) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),',
      ' delivered_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL \\'7 days\\')',
      ');',
      'CREATE INDEX IF NOT EXISTS noxridge_importer_messages_inbox ON noxridge_importer_messages(recipient_user_id, delivered_at, id);'
    ].join('\n'));
    try { await schemaPromise; } catch (error) { schemaPromise = undefined; throw error; }
  }
  return db();
};

export const heartbeatImporter = async ({ userId, username, sessionId }) => {
  const q = await ensureSchema();
  await q.query(
    'INSERT INTO noxridge_importer_presence(user_id,username,session_id,last_seen) VALUES($1,$2,$3,NOW()) ' +
    'ON CONFLICT(user_id) DO UPDATE SET username=EXCLUDED.username,session_id=EXCLUDED.session_id,last_seen=NOW()',
    [String(userId), String(username || 'UNKNOWN').slice(0, 64), sessionId]
  );
  return { active: true, heartbeatAt: new Date().toISOString() };
};

export const listActiveImporterSessions = async () => {
  const q = await ensureSchema();
  const result = await q.query(
    "SELECT user_id,username,last_seen FROM noxridge_importer_presence WHERE last_seen >= NOW() - INTERVAL '75 seconds' ORDER BY username ASC"
  );
  return result.rows.map(row => ({
    userId: String(row.user_id),
    username: row.username,
    lastSeen: row.last_seen,
    active: true
  }));
};

export const enqueueBroadcast = async ({ senderId, senderUsername, title, body }) => {
  const q = await ensureSchema();
  const client = await q.connect();
  try {
    await client.query('BEGIN');
    const recipients = await client.query(
      "SELECT user_id FROM noxridge_importer_presence WHERE last_seen >= NOW() - INTERVAL '75 seconds' ORDER BY user_id"
    );
    const ids = [];
    for (const recipient of recipients.rows) {
      const saved = await client.query(
        "INSERT INTO noxridge_importer_messages(recipient_user_id,sender_user_id,sender_username,message_type,title,body) VALUES($1,$2,$3,'broadcast',$4,$5) RETURNING id",
        [String(recipient.user_id), String(senderId), String(senderUsername || 'NOXRIDGE OWNER'), title, body]
      );
      ids.push(String(saved.rows[0].id));
    }
    await client.query('COMMIT');
    return { recipientCount: ids.length, messageIds: ids };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
};

export const enqueuePrivateMessage = async ({ senderId, senderUsername, recipientId, title, body }) => {
  const q = await ensureSchema();
  const active = await q.query(
    "SELECT 1 FROM noxridge_importer_presence WHERE user_id=$1 AND last_seen >= NOW() - INTERVAL '75 seconds'",
    [String(recipientId)]
  );
  if (!active.rowCount) throw new AppError('Player tidak sedang aktif menggunakan Importer.', 409, 'IMPORTER_PLAYER_NOT_ACTIVE');
  const saved = await q.query(
    "INSERT INTO noxridge_importer_messages(recipient_user_id,sender_user_id,sender_username,message_type,title,body) VALUES($1,$2,$3,'private',$4,$5) RETURNING id",
    [String(recipientId), String(senderId), String(senderUsername || 'NOXRIDGE OWNER'), title, body]
  );
  return { recipientUserId: String(recipientId), messageId: String(saved.rows[0].id) };
};

export const readImporterInbox = async ({ userId, sessionId }) => {
  const q = await ensureSchema();
  const client = await q.connect();
  try {
    await client.query('BEGIN');
    const session = await client.query(
      "SELECT 1 FROM noxridge_importer_presence WHERE user_id=$1 AND session_id=$2 AND last_seen >= NOW() - INTERVAL '75 seconds' FOR UPDATE",
      [String(userId), sessionId]
    );
    if (!session.rowCount) {
      await client.query('COMMIT');
      return [];
    }
    const pending = await client.query(
      "SELECT id,message_type,title,body,sender_username,created_at FROM noxridge_importer_messages WHERE recipient_user_id=$1 AND delivered_at IS NULL AND expires_at > NOW() ORDER BY id ASC LIMIT 10 FOR UPDATE SKIP LOCKED",
      [String(userId)]
    );
    if (pending.rowCount) {
      await client.query('UPDATE noxridge_importer_messages SET delivered_at=NOW() WHERE id = ANY($1::bigint[])', [pending.rows.map(row => row.id)]);
    }
    await client.query('COMMIT');
    return pending.rows.map(row => ({
      id: String(row.id),
      type: row.message_type,
      title: row.title,
      body: row.body,
      from: row.sender_username,
      createdAt: row.created_at
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
};

export const closeImporterSession = async ({ userId, sessionId }) => {
  const q = await ensureSchema();
  await q.query('DELETE FROM noxridge_importer_presence WHERE user_id=$1 AND session_id=$2', [String(userId), sessionId]);
};
