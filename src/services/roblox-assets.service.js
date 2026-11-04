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
    '.jpg': 'image/jpeg',
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

const parseUpstream = async (response) => {
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok) {
    const status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw new AppError(
      'Roblox rejected the asset request. Check the API key permissions, creator ID, asset format, and upload quota.',
      status,
      'ROBLOX_ASSET_REQUEST_FAILED'
    );
  }
  return data;
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

  const creator = creatorType === 'group'
    ? { groupId: String(creatorId) }
    : { userId: String(creatorId) };

  const form = new FormData();
  form.append('request', JSON.stringify({
    assetType,
    displayName: displayName.trim(),
    description: (description || '').trim(),
    creationContext: { creator }
  }));
  form.append(
    'fileContent',
    new Blob([file.buffer], { type: contentType }),
    file.originalname
  );

  let response;
  try {
    response = await fetch(`${ROBLOX_ASSETS_URL}/assets`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(60000)
    });
  } catch {
    throw new AppError('Could not reach Roblox Open Cloud. Try again later.', 502, 'ROBLOX_UNAVAILABLE');
  }
  return parseUpstream(response);
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
