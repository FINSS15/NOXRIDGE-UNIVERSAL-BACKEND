import { Router } from 'express';
import { z } from 'zod';
import { requireWhitelist } from '../middleware/whitelistAuth.js';
import { uploadSingleFile } from '../middleware/upload.js';
import {
  saveWhitelistOpenCloudKey,
  getWhitelistOpenCloudKeyStatus,
  deleteWhitelistOpenCloudKey,
  resolveWhitelistOpenCloudKey,
  saveWhitelistAssetOperation,
  assertWhitelistAssetOperationOwner,
  recordWhitelistStorageObject
} from '../services/whitelist.service.js';
import { createRobloxAsset, getRobloxAssetOperation } from '../services/roblox-assets.service.js';
import { AppError } from '../utils/errors.js';
import { transformAudio } from '../services/audio-transform.service.js';
import { processUpload } from '../services/upload.service.js';

const router = Router();
const keySchema = z.object({ apiKey: z.string().trim().min(20).max(512) });
const createSchema = z.object({
  assetType: z.enum(['Model', 'Decal', 'Image', 'Audio', 'Animation']),
  displayName: z.string().trim().min(1).max(50),
  description: z.string().max(1000).optional().default(''),
  creatorType: z.enum(['user', 'group']),
  creatorId: z.string().regex(/^[0-9]+$/)
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
}).refine(value => value.mode === 'speed'
  ? value.speed >= 1 && value.speed <= 2
  : value.speed >= 0.5 && value.speed <= 1,
{ message: 'Speed value does not match selected mode.', path: ['speed'] });

// The existing importer WL key is the identity proof; no separate NOXRIDGE account token.
router.get('/open-cloud-key/status', requireWhitelist, async (req, res, next) => {
  try { return res.json({ success: true, data: await getWhitelistOpenCloudKeyStatus(req.noxridge.userId) }); }
  catch (error) { return next(error); }
});

router.put('/open-cloud-key', requireWhitelist, async (req, res, next) => {
  try {
    const parsed = keySchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Open Cloud API key format is invalid.', 400, 'VALIDATION_ERROR');
    await saveWhitelistOpenCloudKey(req.noxridge.userId, parsed.data.apiKey);
    return res.json({ success: true, message: 'Roblox Open Cloud key encrypted and saved for this WL player.' });
  } catch (error) { return next(error); }
});

router.delete('/open-cloud-key', requireWhitelist, async (req, res, next) => {
  try {
    await deleteWhitelistOpenCloudKey(req.noxridge.userId);
    return res.json({ success: true, message: 'Saved Roblox Open Cloud key deleted.' });
  } catch (error) { return next(error); }
});

router.post('/upload', requireWhitelist, uploadSingleFile, async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No file was provided.', 400, 'FILE_REQUIRED');
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Asset metadata is invalid.', 400, 'VALIDATION_ERROR');
    const apiKey = await resolveWhitelistOpenCloudKey(req.noxridge.userId);
    let privateStorage = null;
    if (parsed.data.assetType === 'Image' || parsed.data.assetType === 'Audio') {
      const category = parsed.data.assetType === 'Image' ? 'image' : 'music';
      const privateCopy = await processUpload(req.file, category, req.noxridge.userId);
      privateStorage = await recordWhitelistStorageObject({
        userId: req.noxridge.userId, key: privateCopy.key, filename: privateCopy.filename,
        category, contentType: privateCopy.contentType, size: privateCopy.size
      });
    }
    const result = await createRobloxAsset({ apiKey, file: req.file, ...parsed.data });
    const operationId = result?.path?.split('/').pop() || result?.operationId;
    if (operationId) await saveWhitelistAssetOperation(req.noxridge.userId, operationId);
    return res.status(202).json({
      success: true,
      message: 'Asset submitted to Roblox and private copy stored for this WL player when applicable.',
      data: { ...result, privateStorage },
      timestamp: new Date().toISOString()
    });
  } catch (error) { return next(error); }
});

router.post('/bypass-music', requireWhitelist, uploadSingleFile, async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Choose an audio source file you own or are authorized to use.', 400, 'AUDIO_FILE_REQUIRED');
    const parsed = bypassMusicSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Music processing settings are invalid.', 400, 'VALIDATION_ERROR');
    const apiKey = await resolveWhitelistOpenCloudKey(req.noxridge.userId);
    const processedBuffer = await transformAudio({
      buffer: req.file.buffer,
      speed: parsed.data.speed,
      pitch: parsed.data.pitch,
      volume: parsed.data.volume
    });
    const safeBaseName = parsed.data.displayName.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 40) || 'NOXRIDGE_MUSIC';
    const privateCopy = await processUpload({
      buffer: processedBuffer,
      originalname: `${safeBaseName}.mp3`,
      mimetype: 'audio/mpeg'
    }, 'music', req.noxridge.userId);
    const privateRecord = await recordWhitelistStorageObject({
      userId: req.noxridge.userId,
      key: privateCopy.key,
      filename: privateCopy.filename,
      category: 'music',
      contentType: privateCopy.contentType,
      size: privateCopy.size
    });
    const robloxResult = await createRobloxAsset({
      apiKey,
      file: { buffer: processedBuffer, originalname: `${safeBaseName}.mp3` },
      assetType: 'Audio',
      displayName: safeBaseName,
      description: parsed.data.description,
      creatorType: parsed.data.creatorType,
      creatorId: parsed.data.creatorId
    });
    const operationId = robloxResult?.path?.split('/').pop() || robloxResult?.operationId;
    if (!operationId) throw new AppError('Roblox did not return an operation ID for the processed audio.', 502, 'ROBLOX_OPERATION_MISSING');
    await saveWhitelistAssetOperation(req.noxridge.userId, operationId);
    return res.status(202).json({
      success: true,
      message: 'Audio processed, saved to this WL player private storage, and submitted to Roblox.',
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
  } catch (error) { return next(error); }
});

router.get('/operations/:operationId', requireWhitelist, async (req, res, next) => {
  try {
    await assertWhitelistAssetOperationOwner(req.noxridge.userId, req.params.operationId);
    const apiKey = await resolveWhitelistOpenCloudKey(req.noxridge.userId);
    const result = await getRobloxAssetOperation({ apiKey, operationId: req.params.operationId });
    return res.json({ success: true, data: result });
  } catch (error) { return next(error); }
});

export default router;
