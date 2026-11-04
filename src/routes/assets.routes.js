import { Router } from 'express';
import { z } from 'zod';
import { requireAccount } from '../middleware/accountAuth.js';
import { uploadSingleFile } from '../middleware/upload.js';
import { resolveAccountOpenCloudKey, saveAssetOperation, assertAssetOperationOwner } from '../services/account.service.js';
import {
  createRobloxAsset,
  getRobloxAssetOperation
} from '../services/roblox-assets.service.js';
import { AppError } from '../utils/errors.js';

const router = Router();

const createSchema = z.object({
  assetType: z.enum(['Model', 'Decal', 'Image', 'Audio', 'Animation']),
  displayName: z.string().trim().min(1).max(50),
  description: z.string().max(1000).optional().default(''),
  creatorType: z.enum(['user', 'group']),
  creatorId: z.string().regex(/^[0-9]+$/)
});

router.post('/upload', requireAccount, uploadSingleFile, async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No file was provided.', 400, 'FILE_REQUIRED');
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Asset metadata is invalid.', 400, 'VALIDATION_ERROR');

    const apiKey = await resolveAccountOpenCloudKey(
      req.account.id,
      req.get('x-roblox-open-cloud-key')
    );

    const result = await createRobloxAsset({
      apiKey,
      file: req.file,
      ...parsed.data
    });

    const operationId = result?.path?.split('/').pop() || result?.operationId;\n    if (operationId) await saveAssetOperation({ accountId: req.account.id, operationId });\n\n    return res.status(202).json({
      success: true,
      message: 'Asset upload accepted by Roblox. Check the operation status for the asset ID.',
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) { return next(error); }
});

router.get('/operations/:operationId', requireAccount, async (req, res, next) => {
  try {
    const apiKey = await resolveAccountOpenCloudKey(
      req.account.id,
      req.get('x-roblox-open-cloud-key')
    );
    const result = await getRobloxAssetOperation({
      apiKey,
      operationId: req.params.operationId
    });
    return res.json({ success: true, data: result });
  } catch (error) { return next(error); }
});

export default router;
