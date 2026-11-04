import { Router } from 'express';

import { requireApiKey } from '../middleware/auth.js';
import { uploadSingleFile } from '../middleware/upload.js';
import { processUpload } from '../services/upload.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();

router.post('/', requireApiKey, uploadSingleFile, async (req, res, next) => {
  try {
    if (!req.file) {
      throw new AppError('No file was provided.', 400, 'FILE_REQUIRED');
    }

    const result = await processUpload(req.file, req.body.category);

    return res.status(201).json({
      success: true,
      message: 'File uploaded successfully.',
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
