import { Router } from 'express';

import { requireWhitelist, requireWhitelistFeature } from '../middleware/whitelistAuth.js';
import { aiChatSchema } from '../utils/validators.js';
import { sendAIMessage } from '../services/ai.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();

// AI uses the existing per-player NOXRIDGE WL identity; no shared client-side API key is required.
router.post('/chat', requireWhitelist, requireWhitelistFeature('ai_chat'), async (req, res, next) => {
  try {
    const validation = aiChatSchema.safeParse(req.body);

    if (!validation.success) {
      throw new AppError('Invalid AI chat request.', 400, 'VALIDATION_ERROR');
    }

    const { message, conversation } = validation.data;
    const result = await sendAIMessage({
      message,
      conversation,
      userId: req.noxridge.userId
    });

    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
});

export default router;
