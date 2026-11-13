import { Router } from 'express';
import { z } from 'zod';
import { requireWhitelist } from '../middleware/whitelistAuth.js';
import { AppError } from '../utils/errors.js';
import { heartbeatImporter, readImporterInbox, closeImporterSession } from '../services/presence-message.service.js';

const router = Router();
router.use(requireWhitelist);
const sessionSchema = z.string().min(8).max(80).regex(/^[A-Za-z0-9-]+$/);

router.post('/heartbeat', async (req, res, next) => {
  try {
    const parsed = z.object({ sessionId: sessionSchema }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Importer session ID is invalid.', 400, 'INVALID_SESSION_ID');
    const data = await heartbeatImporter({
      userId: req.noxridge.userId,
      username: req.noxridge.username,
      sessionId: parsed.data.sessionId
    });
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
});

router.get('/inbox', async (req, res, next) => {
  try {
    const parsed = sessionSchema.safeParse(String(req.query.sessionId || ''));
    if (!parsed.success) throw new AppError('Importer session ID is invalid.', 400, 'INVALID_SESSION_ID');
    const messages = await readImporterInbox({ userId: req.noxridge.userId, sessionId: parsed.data });
    return res.json({ success: true, data: { messages } });
  } catch (error) { return next(error); }
});

router.delete('/session', async (req, res, next) => {
  try {
    const parsed = sessionSchema.safeParse(String(req.query.sessionId || ''));
    if (!parsed.success) throw new AppError('Importer session ID is invalid.', 400, 'INVALID_SESSION_ID');
    await closeImporterSession({ userId: req.noxridge.userId, sessionId: parsed.data });
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

export default router;
