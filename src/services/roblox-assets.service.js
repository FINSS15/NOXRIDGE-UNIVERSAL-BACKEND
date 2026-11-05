import { AppError } from '../utils/errors.js';

const ROBLOX_ASSETS_URL = 'https://apis.roblox.com/assets/v1';
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

const assetFormats = {
  Model: {
    '.fbx': 'model/fbx',
    '.gltf': 'model/gltf+json',
    '.glb': 'model/gltf-binary',
    '.rbxm': 'model/x-rbxm',
    '.rbxmx': 'model/x-rbxm'
  },
  Decal: {
    '.png': 'image/png',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.bmp': 'image/bmp',
    '.tga': 'image/tga'
  },
  Image: {
    '.png': 'image/png',
    '.jpeg': 'image/jpeg',
    '.bmp': 'image/bmp',
    '.tga': 'image/tga'
  },
  Audio: {
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac'
  },
  Animation: {
    '.rbxm': 'model/x-rbxm',
    '.rbxmx': 'model/x-rbxm'
  }
};

const getExtension = (filename) => {
  const index = filename.lastIndexOf('.');
  return index >= 0 ? filename.slice(index).toLowerCase() : '';
};

const safeKeyMeta = (apiKey) => {
  const normalized = String(apiKey ?? '').trim();
  return { keyLength: normalized.length, keyLast4: normalized.slice(-4) || '(empty)' };
};

const parseUpstream = async (response, context = {}) => {
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok) {
    console.error('[NOXRIDGE ROBLOX ASSET API ERROR]', {
      upstreamStatus: response.status,
      upstreamBody: raw.slice(0, 1200),
      ...context
    });
    const status = response.status >= 400 && response.status < 500 ? 400 : 502;
    const upstreamMessage = String(
      data?.message || data?.error?.message || data?.detail || data?.error || ''
    ).replace(/[\\r\\n\\t]+/g, ' ').slice(0, 260);
    const upstreamCode = String(data?.code || data?.error?.code || '').slice(0, 80);
    const detail = [upstreamCode, upstreamMessage].filter(Boolean).join(': ');
    throw new AppError(
      detail
        ? `Roblox API (${response.status}): ${detail}`
        : `Roblox API rejected the asset request (HTTP ${response.status}). Check API key scopes, creator access, asset format, and upload quota.`,
      status,
      'ROBLOX_ASSET_REQUEST_FAILED'
    );
  }
  return data;
};

// Verify the current WL player's saved key without exposing the secret.
export const inspectRobloxOpenCloudKey = async ({ apiKey }) => {
  const normalizedApiKey = String(apiKey ?? '').trim();
  if (!normalizedApiKey) throw new AppError('Saved Roblox Open Cloud key is empty.', 400, 'ROBLOX_KEY_EMPTY');
  let response;
  try {
    response = await fetch('https://apis.roblox.com/api-keys/v1/introspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: normalizedApiKey }),
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new AppError('Could not reach Roblox API Key introspection endpoint.', 502, 'ROBLOX_INTROSPECT_UNAVAILABLE');
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok) {
    return {
      valid: false,
      httpStatus: response.status,
      message: String(data?.message || data?.error?.message || data?.detail || 'Roblox rejected the saved API Key.').slice(0, 240)
    };
  }
  return {
    valid: true,
    name: typeof data.name === 'string' ? data.name : null,
    authorizedUserId: data.authorizedUserId == null ? null : String(data.authorizedUserId),
    enabled: data.enabled === true,
    expired: data.expired === true,
    expirationTimeUtc: data.expirationTimeUtc || null,
    scopes: Array.isArray(data.scopes) ? data.scopes.map(scope => ({
      name: String(scope?.name || ''),
      operations: Array.isArray(scope?.operations) ? scope.operations.map(String) : [],
      userIds: Array.isArray(scope?.userIds) ? scope.userIds.map(String) : [],
      groupIds: Array.isArray(scope?.groupIds) ? scope.groupIds.map(String) : []
    })) : []
  };
};

export const createRobloxAsset = async ({
  apiKey,
  file,
  assetType,
  displayName,
  description,
  creatorType,
  creatorId
}) => {
  if (!file?.buffer) throw new AppError('Upload file is required.', 400, 'FILE_REQUIRED');
  if (file.buffer.length > MAX_ASSET_BYTES) {
    throw new AppError('Roblox Open Cloud asset uploads are limited to 20 MB per file.', 413, 'ASSET_TOO_LARGE');
  }
  const formats = assetFormats[assetType];
  if (!formats) throw new AppError('Unsupported Roblox asset type.', 400, 'ASSET_TYPE_UNSUPPORTED');
  const extension = getExtension(file.originalname);
  const contentType = formats[extension];
  if (!contentType) {
    throw new AppError(`File extension ${extension || '(none)'} is not supported for ${assetType}.`, 400, 'ASSET_FORMAT_UNSUPPORTED');
  }

  const normalizedApiKey = String(apiKey ?? '').trim();
  if (!normalizedApiKey) throw new AppError('Saved Roblox Open Cloud key is empty after trimming.', 400, 'ROBLOX_KEY_EMPTY');
  const creator = creatorType === 'group'
    ? { groupId: String(creatorId) }
    : { userId: String(creatorId) };
  const keyMeta = safeKeyMeta(normalizedApiKey);

  const form = new FormData();
  // Roblox expects the request part as application/json, not a plain text form field.
  form.append('request', new Blob([JSON.stringify({
    assetType,
    displayName: displayName.trim(),
    description: (description || '').trim(),
    creationContext: { creator }
  })], { type: 'application/json' }));
  form.append(
    'fileContent',
    new Blob([file.buffer], { type: contentType }),
    file.originalname
  );

  let response;
  try {
    response = await fetch(`${ROBLOX_ASSETS_URL}/assets`, {
      method: 'POST',
      headers: { 'x-api-key': normalizedApiKey },
      body: form,
      signal: AbortSignal.timeout(60000)
    });
  } catch {
    throw new AppError('Could not reach Roblox Open Cloud. Try again later.', 502, 'ROBLOX_UNAVAILABLE');
  }
  return parseUpstream(response, {
    ...keyMeta,
    assetType,
    creatorType,
    creatorId: String(creatorId),
    creatorPayload: creator
  });
};

export const getRobloxAssetOperation = async ({ apiKey, operationId }) => {
  let response;
  try {
    response = await fetch(
      `${ROBLOX_ASSETS_URL}/operations/${encodeURIComponent(operationId)}`,
      {
        method: 'GET',
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(20000)
      }
    );
  } catch {
    throw new AppError('Could not reach Roblox Open Cloud. Try again later.', 502, 'ROBLOX_UNAVAILABLE');
  }
  return parseUpstream(response);
};
