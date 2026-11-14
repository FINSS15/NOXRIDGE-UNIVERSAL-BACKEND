import { Router } from 'express';
import { z } from 'zod';
import { requireWhitelist } from '../middleware/whitelistAuth.js';
import { AppError } from '../utils/errors.js';
import { requirePanelPermission } from '../services/admin-role.service.js';
import { enqueueBroadcast, enqueuePrivateMessage, listActiveImporterSessions } from '../services/presence-message.service.js';

const router = Router();
router.use(requireWhitelist);

const messageSchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1200)
});

router.get('/sessions', requirePanelPermission('view_sessions'), async (req, res, next) => {
  try {
    const sessions = await listActiveImporterSessions();
    return res.json({ success: true, data: { sessions, activeCount: sessions.length } });
  } catch (error) { return next(error); }
});

router.post('/messages/broadcast', requirePanelPermission('send_messages'), async (req, res, next) => {
  try {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Judul atau isi announcement tidak valid.', 400, 'INVALID_MESSAGE');
    const data = await enqueueBroadcast({
      senderId: req.noxridge.userId,
      senderUsername: req.noxridge.username,
      title: parsed.data.title,
      body: parsed.data.body
    });
    return res.status(201).json({ success: true, data });
  } catch (error) { return next(error); }
});

router.post('/messages/private', requirePanelPermission('send_messages'), async (req, res, next) => {
  try {
    const parsed = z.object({
      userId: z.string().regex(/^[0-9]{1,20}$/),
      title: messageSchema.shape.title,
      body: messageSchema.shape.body
    }).safeParse(req.body);
    if (!parsed.success) throw new AppError('Data private message tidak valid.', 400, 'INVALID_MESSAGE');
    const data = await enqueuePrivateMessage({
      senderId: req.noxridge.userId,
      senderUsername: req.noxridge.username,
      recipientId: parsed.data.userId,
      title: parsed.data.title,
      body: parsed.data.body
    });
    return res.status(201).json({ success: true, data });
  } catch (error) { return next(error); }
});

export default router;
