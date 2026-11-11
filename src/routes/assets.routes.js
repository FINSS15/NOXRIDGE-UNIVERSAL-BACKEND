import { Router } from 'express';
import { env } from '../config/env.js';
import { z } from 'zod';
import { requireWhitelist, requireWhitelistFeature } from '../middleware/whitelistAuth.js';
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
import { createRobloxAsset, getRobloxAssetOperation, inspectRobloxOpenCloudKey } from '../services/roblox-assets.service.js';
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

// Explicit reveal is scoped to the authenticated WL player. The secret is never logged.
router.get('/open-cloud-key/reveal', requireWhitelist, async (req, res, next) => {
  try {
    const apiKey = await resolveWhitelistOpenCloudKey(req.noxridge.userId);
    return res.set('Cache-Control', 'no-store').json({
      success: true,
      data: { apiKey, revealed: true }
    });
  } catch (error) { return next(error); }
});

const inspectAssetScope = (scopes, operation, creatorType, creatorId) => {
  if (!Array.isArray(scopes)) return { allowed: null, reason: 'Scopes array tidak dikirim Roblox.' };
  const op = String(operation).toLowerCase();
  const candidates = scopes.filter(scope => {
    const name = String(scope?.name || '').toLowerCase();
    const ops = Array.isArray(scope?.operations) ? scope.operations.map(value => String(value).toLowerCase()) : [];
    return ((name === 'asset' || name === 'assets') && ops.includes(op)) || name === 'asset:' + op || name === 'assets:' + op;
  });
  if (!candidates.length) return { allowed: false, reason: 'Scope asset ' + op + ' tidak ditemukan.' };
  const field = creatorType === 'group' ? 'groupIds' : 'userIds';
  let targetUnknown = false;
  for (const scope of candidates) {
    const targets = scope?.[field];
    if (!Array.isArray(targets)) { targetUnknown = true; continue; }
    if (targets.some(value => String(value) === '*' || String(value) === String(creatorId))) {
      return { allowed: true, reason: 'Scope dan creator target cocok.' };
    }
  }
  if (targetUnknown) return { allowed: null, reason: 'Scope ada, tetapi detail target ' + field + ' tidak dikirim Roblox.' };
  return { allowed: false, reason: 'Scope ada, tetapi tidak mencakup creator ID ini.' };
};

router.post('/open-cloud-key/diagnose', requireWhitelist, async (req, res, next) => {
  try {
    const apiKey = await resolveWhitelistOpenCloudKey(req.noxridge.userId);
    const result = await inspectRobloxOpenCloudKey({ apiKey });
    const ownerMatches = result.authorizedUserId == null ? null : String(result.authorizedUserId) === String(req.noxridge.userId);
    const readScope = inspectAssetScope(result.scopes, 'read', 'user', req.noxridge.userId);
    const writeScope = inspectAssetScope(result.scopes, 'write', 'user', req.noxridge.userId);
    return res.set('Cache-Control', 'no-store').json({
      success: true,
      data: {
        ...result,
        ownerMatchesWhitelistUser: ownerMatches,
        assetReadScopeForWhitelistUser: readScope.allowed,
        assetWriteScopeForWhitelistUser: writeScope.allowed,
        assetReadScopeReason: readScope.reason,
        assetWriteScopeReason: writeScope.reason
      }
    });
  } catch (error) { return next(error); }
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
    const keyStatus = await getWhitelistOpenCloudKeyStatus(req.noxridge.userId);
    return res.set('Cache-Control', 'no-store').json({
      success: true,
      message: 'Roblox Open Cloud key encrypted and saved for this WL player. It is active immediately; no Render redeploy is required.',
      data: {
        saved: true,
        appliedImmediately: true,
        requiresRedeploy: false,
        maskedKey: keyStatus.maskedKey,
        updatedAt: keyStatus.updatedAt
      }
    });
  } catch (error) { return next(error); }
});

router.delete('/open-cloud-key', requireWhitelist, async (req, res, next) => {
  try {
    await deleteWhitelistOpenCloudKey(req.noxridge.userId);
    return res.json({ success: true, message: 'Saved Roblox Open Cloud key deleted.' });
  } catch (error) { return next(error); }
});

// One-click image background removal. The remove.bg secret never reaches the importer.
router.post('/remove-background', uploadRateLimiter, requireWhitelist, uploadSingleFile, async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('Choose an image file first.', 400, 'FILE_REQUIRED');
    if (!env.REMOVE_BG_API_KEY) {
      throw new AppError('Background removal is not configured on the backend. Add REMOVE_BG_API_KEY in Render Environment.', 503, 'REMOVE_BG_NOT_CONFIGURED');
    }
    const allowedMime = new Set(['image/png', 'image/jpeg']);
    const extension = String(req.file.originalname || '').toLowerCase().split('.').pop();
    if (!allowedMime.has(String(req.file.mimetype || '').toLowerCase()) || !['png', 'jpg', 'jpeg'].includes(extension)) {
      throw new AppError('Only PNG and JPG/JPEG images can use background removal.', 415, 'IMAGE_FORMAT_UNSUPPORTED');
    }
    if (req.file.size > 20 * 1024 * 1024) {
      throw new AppError('Image exceeds the 20 MB background-removal limit.', 413, 'IMAGE_TOO_LARGE');
    }

    const form = new FormData();
    form.append('size', 'auto');
    form.append('format', 'png');
    form.append('image_file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || 'image.png');

    const upstream = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': env.REMOVE_BG_API_KEY },
      body: form,
      signal: AbortSignal.timeout(90000)
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      const safeDetail = detail.replace(/[\r\n]+/g, ' ').slice(0, 240);
      const status = upstream.status === 429 ? 429 : upstream.status === 402 ? 402 : upstream.status === 401 || upstream.status === 403 ? 502 : 502;
      const code = upstream.status === 429 ? 'REMOVE_BG_RATE_LIMIT' : upstream.status === 402 ? 'REMOVE_BG_CREDITS_EXHAUSTED' : 'REMOVE_BG_UPSTREAM_ERROR';
      throw new AppError(
        upstream.status === 429
          ? 'remove.bg rate limit reached. Please wait and try again.'
          : upstream.status === 402
            ? 'remove.bg credits are exhausted. Check the remove.bg account plan.'
            : upstream.status === 401 || upstream.status === 403
              ? 'remove.bg rejected the configured API key. Check REMOVE_BG_API_KEY in Render.'
              : 'remove.bg could not process this image. ' + safeDetail,
        status,
        code
      );
    }

    const output = Buffer.from(await upstream.arrayBuffer());
    if (!output.length || output.length > 40 * 1024 * 1024) {
      throw new AppError('remove.bg returned an invalid or oversized image.', 502, 'REMOVE_BG_INVALID_OUTPUT');
    }
    return res
      .status(200)
      .set({
        'Content-Type': 'image/png',
        'Content-Length': String(output.length),
        'Content-Disposition': 'attachment; filename="noxridge-no-background.png"',
        'Cache-Control': 'no-store'
      })
      .send(output);
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return next(new AppError('remove.bg processing timed out. Please try again.', 504, 'REMOVE_BG_TIMEOUT'));
    }
    return next(error);
  }
});

router.post('/upload', uploadRateLimiter, requireWhitelist, uploadSingleFile, (req, res, next) => {
  const type = String(req.body?.assetType || '');
  const feature = type === 'Image' || type === 'Decal' ? 'image_upload' : type === 'Audio' ? 'music_upload' : 'model_upload';
  return requireWhitelistFeature(feature)(req, res, next);
}, async (req, res, next) => {
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
    // Roblox Create Asset returns an Operation resource path: operations/{operationId}.
    // Normalize it for clients that expect an explicit operationId field.
    const operationPath = typeof result?.path === 'string' ? result.path : '';
    const operationId = result?.operationId
      || operationPath.split('?')[0].split('/').filter(Boolean).pop()
      || null;
    if (!operationId) {
      console.error('[NOXRIDGE ROBLOX OPERATION ID MISSING]', {
        userId: String(req.noxridge.userId),
        responseKeys: Object.keys(result || {}),
        responsePath: operationPath.slice(0, 180)
      });
      throw new AppError(
        'Roblox accepted the upload request but did not return a readable operation ID. Check backend logs before retrying to avoid duplicate assets.',
        502,
        'ROBLOX_OPERATION_MISSING'
      );
    }
    await saveWhitelistAssetOperation(req.noxridge.userId, operationId);

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
      data: { ...result, operationId, privateStorage, privateStorageWarning },
      timestamp: new Date().toISOString()
    });
  } catch (error) { return next(error); }
});

router.post('/bypass-music', uploadRateLimiter, requireWhitelist, requireWhitelistFeature('music_bypass'), uploadSingleFile, async (req, res, next) => {
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
    // Publish the transformed audio first. Private B2 archiving is secondary:
    // a temporary archive failure must never cancel a valid Roblox submission.
    const robloxResult = await createRobloxAsset({
      apiKey,
      file: { buffer: processedBuffer, originalname: `${safeBaseName}.mp3` },
      assetType: 'Audio',
      displayName: safeBaseName,
      description: parsed.data.description,
      creatorType: parsed.data.creatorType,
      creatorId: parsed.data.creatorId
    });
    const operationPath = typeof robloxResult?.path === 'string' ? robloxResult.path : '';
    const operationId = robloxResult?.operationId
      || operationPath.split('?')[0].split('/').filter(Boolean).pop()
      || null;
    if (!operationId) {
      throw new AppError('Roblox accepted the processed audio request but did not return a readable operation ID. Check backend logs before retrying to avoid duplicate assets.', 502, 'ROBLOX_OPERATION_MISSING');
    }
    await saveWhitelistAssetOperation(req.noxridge.userId, operationId);

    let privateRecord = null;
    let privateStorageWarning = null;
    try {
      const privateCopy = await processUpload({
        buffer: processedBuffer,
        originalname: `${safeBaseName}.mp3`,
        mimetype: 'audio/mpeg'
      }, 'music', req.noxridge.userId);
      privateRecord = await recordWhitelistStorageObject({
        userId: req.noxridge.userId,
        key: privateCopy.key,
        filename: privateCopy.filename,
        category: 'music',
        contentType: privateCopy.contentType,
        size: privateCopy.size
      });
    } catch (storageError) {
      console.error('[NOXRIDGE BYPASS MUSIC ARCHIVE ERROR]', {
        userId: String(req.noxridge.userId),
        code: storageError?.code || 'PRIVATE_STORAGE_FAILED',
        message: String(storageError?.message || 'Unknown storage error').slice(0, 180)
      });
      privateStorageWarning = 'Roblox upload was submitted, but private Backblaze B2 archiving failed.';
    }

    return res.status(202).json({
      success: true,
      message: privateStorageWarning
        ? 'Processed audio submitted to Roblox. Private archive storage is temporarily unavailable.'
        : 'Processed audio submitted to Roblox and archived for this WL player.',
      data: {
        operationId,
        roblox: robloxResult,
        privateStorage: privateRecord,
        privateStorageWarning,
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
    const operationResponse = result?.response && typeof result.response === 'object'
      ? result.response
      : null;
    const responsePath = typeof operationResponse?.path === 'string' ? operationResponse.path : '';
    const assetId = operationResponse?.assetId != null
      ? String(operationResponse.assetId)
      : (responsePath.split('?')[0].split('/').filter(Boolean).pop() || null);
    return res.set('Cache-Control', 'no-store').json({
      success: true,
      data: {
        ...result,
        operationId: req.params.operationId,
        done: typeof result?.done === 'boolean' ? result.done : null,
        assetId,
        operationError: result?.error || null
      }
    });
  } catch (error) { return next(error); }
});

export default router;
