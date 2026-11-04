import { Router } from 'express';
import { z } from 'zod';
import { requireMasterKey } from '../middleware/auth.js';
import { requireAccount } from '../middleware/accountAuth.js';
import {
  registerAccount,
  loginAccount,
  logoutSession,
  saveOpenCloudKey,
  getOpenCloudKeyStatus,
  deleteOpenCloudKey,
  promoteAccount
} from '../services/account.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();
const credentialsSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(10).max(128)
});
const keySchema = z.object({
  apiKey: z.string().trim().min(20).max(512)
});

router.post('/register', async (req, res, next) => {
  try {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Username or password format is invalid.', 400, 'VALIDATION_ERROR');
    const data = await registerAccount(parsed.data);
    return res.status(201).json({ success: true, message: 'Trial account created.', data });
  } catch (error) { return next(error); }
});

router.post('/login', async (req, res, next) => {
  try {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Username or password format is invalid.', 400, 'VALIDATION_ERROR');
    const data = await loginAccount(parsed.data);
    return res.status(200).json({ success: true, data });
  } catch (error) { return next(error); }
});

router.get('/me', requireAccount, (req, res) => {
  return res.json({ success: true, data: req.account });
});

router.post('/logout', requireAccount, async (req, res, next) => {
  try {
    const token = req.get('authorization').replace(/^Bearer\s+/i, '');
    await logoutSession(token);
    return res.json({ success: true, message: 'Session closed.' });
  } catch (error) { return next(error); }
});

router.get('/open-cloud-key/status', requireAccount, async (req, res, next) => {
  try {
    const status = await getOpenCloudKeyStatus(req.account.id);
    return res.json({ success: true, data: status });
  } catch (error) { return next(error); }
});

router.put('/open-cloud-key', requireAccount, async (req, res, next) => {
  try {
    const parsed = keySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Open Cloud API key format is invalid.', 400, 'VALIDATION_ERROR');
    await saveOpenCloudKey(req.account.id, parsed.data.apiKey);
    return res.json({ success: true, message: 'Open Cloud key encrypted and saved.' });
  } catch (error) { return next(error); }
});

router.delete('/open-cloud-key', requireAccount, async (req, res, next) => {
  try {
    await deleteOpenCloudKey(req.account.id);
    return res.json({ success: true, message: 'Saved Open Cloud key deleted.' });
  } catch (error) { return next(error); }
});

// Owner-only promotion. The master key must never be embedded in the public importer.
router.post('/admin/promote', requireMasterKey, async (req, res, next) => {
  try {
    const parsed = z.object({ username: z.string().trim().min(3).max(32) }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Username is required.', 400, 'VALIDATION_ERROR');
    const account = await promoteAccount(parsed.data.username);
    return res.json({ success: true, data: account });
  } catch (error) { return next(error); }
});

export default router;
