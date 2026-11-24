import { Router } from 'express';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { authenticateWhitelist, authenticateWhitelistByKey } from '../services/whitelist.service.js';
import { verifyPlayerPanelAccess } from '../services/admin-role.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();
const COOKIE_NAME = 'noxridge_web_panel';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const encryptionKey = () => {
  if (!env.WEB_PANEL_SESSION_SECRET) {
    throw new AppError('Web Panel session is not configured. Set WEB_PANEL_SESSION_SECRET in Render.', 503, 'WEB_PANEL_SESSION_NOT_CONFIGURED');
  }
  return createHash('sha256').update(env.WEB_PANEL_SESSION_SECRET).digest();
};

const sealSession = (payload) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
};

const openSession = (token) => {
  try {
    const [ivText, tagText, encryptedText, extra] = String(token || '').split('.');
    if (!ivText || !tagText || !encryptedText || extra !== undefined) return null;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64url')),
      decipher.final()
    ]).toString('utf8');
    const payload = JSON.parse(plain);
    if (!payload || typeof payload.userId !== 'string' || typeof payload.wlKey !== 'string' ||
        !Number.isFinite(payload.expiresAt) || Date.now() >= payload.expiresAt) return null;
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return null;
  }
};

const readCookie = (req, name) => {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; }
    }
  }
  return null;
};

const cookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/admin-panel-web',
  maxAge: SESSION_TTL_MS
});

export const requireWebPanelSession = async (req, res, next) => {
  try {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch {}
        if (!originHost || originHost !== req.get('host')) {
          throw new AppError('Cross-origin Web Panel request ditolak.', 403, 'WEB_PANEL_CSRF_BLOCKED');
        }
      }
    }

    const payload = openSession(readCookie(req, COOKIE_NAME));
    if (!payload) throw new AppError('Sesi Web Panel berakhir. Silakan login kembali.', 401, 'WEB_PANEL_SESSION_INVALID');

    // Re-check the current WL key, trial, expiry and blacklist on every request.
    // Changing or revoking the Importer WL key therefore invalidates this web session too.
    const identity = await authenticateWhitelist(payload.userId, payload.wlKey);
    const panelAccess = await verifyPlayerPanelAccess(identity.userId);
    req.noxridge = { ...identity, webSession: true };
    req.panelAccess = panelAccess;
    return next();
  } catch (error) { return next(error); }
};

router.post('/login', async (req, res, next) => {
  try {
    const wlKey = String(req.body?.wlKey ?? '').trim();
    if (!/^\d{4,32}$/.test(wlKey)) {
      throw new AppError('Masukkan WL Key angka 4 sampai 32 digit.', 400, 'WEB_PANEL_WL_KEY_INVALID');
    }
    // Identify the account from the WL key itself; the browser cannot choose a UserId or role.
    const identity = await authenticateWhitelistByKey(wlKey);
    const panelAccess = await verifyPlayerPanelAccess(identity.userId);
    const token = sealSession({
      userId: identity.userId,
      wlKey,
      expiresAt: Date.now() + SESSION_TTL_MS
    });
    res.cookie(COOKIE_NAME, token, cookieOptions());
    return res.json({
      success: true,
      authenticated: true,
      user: { userId: identity.userId, username: identity.username },
      access: panelAccess
    });
  } catch (error) { return next(error); }
});

router.get('/me', requireWebPanelSession, (req, res) => res.json({
  success: true,
  authenticated: true,
  user: { userId: req.noxridge.userId, username: req.noxridge.username },
  access: req.panelAccess
}));

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/admin-panel-web'
  });
  return res.json({ success: true, loggedOut: true });
});

export default router;
