import { Router } from 'express';

import { requireApiKey } from '../middleware/auth.js';
import { uploadSingleFile } from '../middleware/upload.js';
import { processUpload } from '../services/upload.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();

router.post('/', requireApiKey, uploadSingleFile, async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No file was provided.', 400, 'FILE_REQUIRED');
    const category = req.body.category;
    if (!['file', 'rbxm', 'rbxl'].includes(category)) {
      throw new AppError(
        'Image and music must use the authenticated personal /storage/upload endpoint. General upload accepts file, rbxm, or rbxl.',
        400,
        'USE_PERSONAL_STORAGE'
      );
    }
    const result = await processUpload(req.file, category);
    return res.status(201).json({
      success: true,
      message: 'General file uploaded successfully.',
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) { return next(error); }
});

export default router;
