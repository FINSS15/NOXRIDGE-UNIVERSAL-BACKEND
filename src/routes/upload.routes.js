import { Router } from 'express';
import { requireAccount } from '../middleware/accountAuth.js';
import { uploadSingleFile } from '../middleware/upload.js';
import { processUpload } from '../services/upload.service.js';
import { recordStorageObject } from '../services/account.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();

router.post('/', requireAccount, uploadSingleFile, async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No file was provided.', 400, 'FILE_REQUIRED');
    const category = req.body.category;
    if (!['image', 'music'].includes(category)) {
      throw new AppError('This personal endpoint accepts image or music only.', 400, 'INVALID_UPLOAD_CATEGORY');
    }
    const result = await processUpload(req.file, category, req.account.id);
    const record = await recordStorageObject({
      accountId: req.account.id,
      key: result.key,
      filename: result.filename,
      category,
      contentType: result.contentType,
      size: result.size
    });
    return res.status(201).json({
      success: true,
      message: 'File uploaded to your private NOXRIDGE storage.',
      data: { ...record, storage: 'backblaze-b2' },
      timestamp: new Date().toISOString()
    });
  } catch (error) { return next(error); }
});

export default router;
