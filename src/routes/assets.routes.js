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
import { transformAudio } from '../services/audio-transform.service.js';
import { processUpload } from '../services/upload.service.js';
import { recordStorageObject } from '../services/account.service.js';
import { deleteObject } from '../services/b2.service.js';

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

    const operationId = result?.path?.split('/').pop() || result?.operationId;
    if (operationId) await saveAssetOperation({ accountId: req.account.id, operationId });

    return res.status(202).json({
      success: true,
      message: 'Asset upload accepted by Roblox. Check the operation status for the asset ID.',
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) { return next(error); }
});


const bypassMusicSchema = z.object({
  displayName: z.string().trim().min(1).max(50),
  description: z.string().max(1000).optional().default(''),
  creatorType: z.enum(['user', 'group']),
  creatorId: z.string().regex(/^[0-9]+$/),
  mode: z.enum(['speed', 'slow']),
  speed: z.coerce.number().min(0.5).max(2),
  pitch: z.coerce.number().int().min(-12).max(12),
  volume: z.coerce.number().min(0).max(1)
}).refine((value) => value.mode === 'speed'
  ? value.speed >= 1 && value.speed <= 2
  : value.speed >= 0.5 && value.speed <= 1,
{ message: 'Speed value does not match selected mode.', path: ['speed'] });

// Music processing accepts a source audio FILE owned/authorized by the caller.
// It does not download or alter another Roblox user's audio by ID.
router.post('/bypass-music', requireAccount, uploadSingleFile, async (req, res, next) => {
  let storedKey;
  try {
    if (!req.file) throw new AppError('Choose an audio source file you own or are authorized to use.', 400, 'AUDIO_FILE_REQUIRED');
    const parsed = bypassMusicSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Music processing settings are invalid.', 400, 'VALIDATION_ERROR');

    const apiKey = await resolveAccountOpenCloudKey(
      req.account.id,
      req.get('x-roblox-open-cloud-key')
    );

    const processedBuffer = await transformAudio({
      buffer: req.file.buffer,
      speed: parsed.data.speed,
      pitch: parsed.data.pitch,
      volume: parsed.data.volume
    });

    const safeBaseName = parsed.data.displayName
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .trim()
      .slice(0, 40) || 'NOXRIDGE_MUSIC';
    const privateCopy = await processUpload({
      buffer: processedBuffer,
      originalname: `${safeBaseName}.mp3`,
      mimetype: 'audio/mpeg'
    }, 'music', req.account.id);
    storedKey = privateCopy.key;

    const privateRecord = await recordStorageObject({
      accountId: req.account.id,
      key: privateCopy.key,
      filename: privateCopy.filename,
      category: 'music',
      contentType: privateCopy.contentType,
      size: privateCopy.size
    });

    const robloxResult = await createRobloxAsset({
      apiKey,
      file: {
        buffer: processedBuffer,
        originalname: `${safeBaseName}.mp3`
      },
      assetType: 'Audio',
      displayName: safeBaseName,
      description: parsed.data.description,
      creatorType: parsed.data.creatorType,
      creatorId: parsed.data.creatorId
    });

    const operationId = robloxResult?.path?.split('/').pop() || robloxResult?.operationId;
    if (!operationId) {
      throw new AppError('Roblox did not return an operation ID for the processed audio.', 502, 'ROBLOX_OPERATION_MISSING');
    }
    await saveAssetOperation({ accountId: req.account.id, operationId });

    return res.status(202).json({
      success: true,
      message: 'Audio processed, saved to this account private storage, and submitted to Roblox.',
      data: {
        operationId,
        roblox: robloxResult,
        privateStorage: privateRecord,
        processing: {
          mode: parsed.data.mode,
          speed: parsed.data.speed,
          pitch: parsed.data.pitch,
          volume: parsed.data.volume,
          format: 'mp3'
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    // Keep a successfully saved private copy if Roblox rejects publication; it remains account-owned.
    return next(error);
  }
});

router.get('/operations/:operationId', requireAccount, async (req, res, next) => {
  try {
    await assertAssetOperationOwner(req.account.id, req.params.operationId);
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
