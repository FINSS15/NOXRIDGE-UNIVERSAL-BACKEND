import { Router } from 'express';

import { requireApiKey } from '../middleware/auth.js';
import { aiChatSchema } from '../utils/validators.js';
import { sendAIMessage } from '../services/ai.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();

// AI Chat API
router.post('/chat', requireApiKey, async (req, res, next) => {
  try {
    const validation = aiChatSchema.safeParse(req.body);

    if (!validation.success) {
      throw new AppError(
        'Invalid AI chat request.',
        400,
        'VALIDATION_ERROR'
      );
    }

    const { message, conversation = [] } = req.body;

    const result = await sendAIMessage({
      message,
      conversation
    });

    return res.status(200).json(result);
  } catch (error) {
    return next(error);
  }
});

export default router;
