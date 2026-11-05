import { Router } from 'express';
import { z } from 'zod';
import { requireWhitelist } from '../middleware/whitelistAuth.js';
import { uploadSingleFile } from '../middleware/upload.js';
import { uploadRateLimiter } from '../middleware/rateLimit.js';
import {
  saveWhitelistOpenCloudKey,
  getWhitelistOpenCloudKeyStatus,
  listWhitelistOpenCloudKeyHistory,
  restoreWhitelistOpenCloudKeyHistory,
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
const keySchema = z.object({ apiKey: z.string().trim().min(20) });
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

router.get('/open-cloud-key/history', requireWhitelist, async (req, res, next) => {
  try {
    return res.json({ success: true, data: await listWhitelistOpenCloudKeyHistory(req.noxridge.userId) });
  } catch (error) { return next(error); }
});

router.post('/open-cloud-key/history/:historyId/restore', requireWhitelist, async (req, res, next) => {
  try {
    if (!/^\\d{1,20}$/.test(String(req.params.historyId || ''))) {
      throw new AppError('History ID is invalid.', 400, 'INVALID_HISTORY_ID');
    }
    const data = await restoreWhitelistOpenCloudKeyHistory(req.noxridge.userId, req.params.historyId);
    return res.json({ success: true, data, message: 'Previous Roblox Open Cloud key restored for this WL player.' });
  } catch (error) { return next(error); }
});

router.put('/open-cloud-key', requireWhitelist, async (req, res, next) => {
  try {
    const parsed = keySchema.safeParse(req.body);
    if (!parsed.success) {
      // Safe diagnostics only: never include or log the actual Roblox API key.
      const bodyType = req.body === null ? 'null' : Array.isArray(req.body) ? 'array' : typeof req.body;
      const bodyKeys = req.body && typeof req.body === 'object' ? Object.keys(req.body).join(',').slice(0, 120) : '(none)';
      const rawKey = req.body && typeof req.body === 'object' ? req.body.apiKey : undefined;
      const keyType = typeof rawKey;
      const keyLength = typeof rawKey === 'string' ? rawKey.trim().length : -1;
      throw new AppError(
        `Invalid Open Cloud key payload: bodyType=${bodyType}; keys=${bodyKeys}; apiKeyType=${keyType}; apiKeyLength=${keyLength}. Expected JSON {apiKey:string} with at least 20 characters; no maximum length is enforced.`,
        400,
        'VALIDATION_ERROR'
      );
    }
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

router.post('/upload', uploadRateLimiter, requireWhitelist, uploadSingleFile, async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No file was provided.', 400, 'FILE_REQUIRED');
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError('Asset metadata is invalid.', 400, 'VALIDATION_ERROR');
    if (parsed.data.creatorType === 'user' && String(parsed.data.creatorId) !== String(req.noxridge.userId)) {
      throw new AppError('Creator UserId must match the authenticated WL account that owns this API Key.', 400, 'CREATOR_ID_MISMATCH');
    }
    const apiKey = await resolveWhitelistOpenCloudKey(req.noxridge.userId);
    // Submit to Roblox first. A private B2 archive failure must not cancel a valid
    // Roblox asset submission or make the importer report a false upload failure.
    const result = await createRobloxAsset({ apiKey, file: req.file, ...parsed.data });
    const operationId = result?.path?.split('/').pop() || result?.operationId;
    if (operationId) await saveWhitelistAssetOperation(req.noxridge.userId, operationId);

    let privateStorage = null;
    let privateStorageWarning = null;
    if (parsed.data.assetType === 'Image' || parsed.data.assetType === 'Audio') {
      const category = parsed.data.assetType === 'Image' ? 'image' : 'music';
      try {
        const privateCopy = await processUpload(req.file, category, req.noxridge.userId);
        privateStorage = await recordWhitelistStorageObject({
          userId: req.noxridge.userId, key: privateCopy.key, filename: privateCopy.filename,
          category, contentType: privateCopy.contentType, size: privateCopy.size
        });
      } catch (storageError) {
        // Do not log file contents, API keys, or WL credentials.
        console.error('[NOXRIDGE PRIVATE ASSET ARCHIVE ERROR]', {
          userId: String(req.noxridge.userId),
          category,
          code: storageError?.code || 'PRIVATE_STORAGE_FAILED',
          message: String(storageError?.message || 'Unknown storage error').slice(0, 180)
        });
        privateStorageWarning = 'Roblox upload submitted, but private archive storage failed. Contact NOXRIDGE owner if this persists.';
      }
    }
    return res.status(202).json({
      success: true,
      message: privateStorageWarning
        ? 'Asset submitted to Roblox. Private archive storage is temporarily unavailable.'
        : 'Asset submitted to Roblox and private copy stored for this WL player when applicable.',
      data: { ...result, privateStorage, privateStorageWarning },
      timestamp: new Date().toISOString()
    });
  } catch (error) { return next(error); }
});

router.post('/bypass-music', uploadRateLimiter, requireWhitelist, uploadSingleFile, async (req, res, next) => {
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
