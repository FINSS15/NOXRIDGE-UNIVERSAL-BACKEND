import { Router } from 'express';
import { requireAccount } from '../middleware/accountAuth.js';
import { uploadSingleFile } from '../middleware/upload.js';
import { processUpload } from '../services/upload.service.js';
import { uploadObject, createObjectDownloadUrl, deleteObject } from '../services/b2.service.js';
import { recordStorageObject, listStorageObjects, getStorageObjectForAccount } from '../services/account.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();

router.post('/upload', requireAccount, uploadSingleFile, async (req, res, next) => {
  let storedKey;
  try {
    if (!req.file) throw new AppError('No file was provided.', 400, 'FILE_REQUIRED');
    const category = req.body.category;
    if (!['image', 'music'].includes(category)) {
      throw new AppError('Storage category must be image or music.', 400, 'INVALID_UPLOAD_CATEGORY');
    }
    const processed = await processUpload(req.file, category, req.account.id);
    storedKey = processed.key;
    const record = await recordStorageObject({
      accountId: req.account.id,
      key: processed.key,
      filename: processed.filename,
      category,
      contentType: processed.contentType,
      size: processed.size
    });
    return res.status(201).json({
      success: true,
      message: 'File saved in this account private NOXRIDGE storage.',
      data: { ...record, storage: 'backblaze-b2' },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (storedKey) {
      try { await deleteObject(storedKey); } catch {}
    }
    return next(error);
  }
});

router.get('/', requireAccount, async (req, res, next) => {
  try {
    const files = await listStorageObjects(req.account.id);
    return res.json({ success: true, data: files });
  } catch (error) { return next(error); }
});

router.get('/:id/download', requireAccount, async (req, res, next) => {
  try {
    if (!/^\\d+$/.test(req.params.id)) throw new AppError('Invalid storage file ID.', 400, 'INVALID_STORAGE_ID');
    const record = await getStorageObjectForAccount(req.account.id, req.params.id);
    const url = await createObjectDownloadUrl(record.object_key, 900);
    return res.json({ success: true, data: { url, expiresIn: 900 } });
  } catch (error) { return next(error); }
});

export default router;
