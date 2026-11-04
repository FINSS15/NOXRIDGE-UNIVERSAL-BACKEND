import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileTypeFromBuffer } from 'file-type';

import { uploadObject } from './b2.service.js';
import { AppError } from '../utils/errors.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const ALLOWED_TYPES = {
  image: {
    '.jpg': ['image/jpeg'],
    '.jpeg': ['image/jpeg'],
    '.png': ['image/png'],
    '.webp': ['image/webp'],
    '.gif': ['image/gif']
  },

  music: {
    '.mp3': ['audio/mpeg'],
    '.wav': ['audio/wav', 'audio/x-wav'],
    '.ogg': ['audio/ogg'],
    '.flac': ['audio/flac'],
    '.m4a': ['audio/mp4', 'audio/x-m4a'],
    '.aac': ['audio/aac']
  },

  file: {
    '.pdf': ['application/pdf'],
    '.zip': ['application/zip'],
    '.txt': ['text/plain']
  }
};

const getExtension = (filename) => {
  return extname(filename).toLowerCase();
};

const validateRobloxFile = (buffer, extension) => {
  const isBinary = buffer
    .subarray(0, 8)
    .toString('ascii') === '<roblox!';

  const xmlContent = buffer
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();

  const isXml = /<roblox(?:\s|>)/i.test(xmlContent);

  if (['.rbxm', '.rbxl'].includes(extension) && !isBinary) {
    throw new AppError(
      'Invalid Roblox binary file signature.',
      400,
      'INVALID_ROBLOX_FILE'
    );
  }

  if (['.rbxmx', '.rbxlx'].includes(extension) && !isXml) {
    throw new AppError(
      'Invalid Roblox XML file signature.',
      400,
      'INVALID_ROBLOX_FILE'
    );
  }

  return isBinary
    ? 'application/octet-stream'
    : 'application/xml';
};

const validateTextFile = (buffer) => {
  try {
    new TextDecoder('utf-8', {
      fatal: true
    }).decode(buffer);

    if (buffer.includes(0)) {
      throw new Error('Binary content detected.');
    }

    return 'text/plain';
  } catch {
    throw new AppError(
      'Invalid UTF-8 text file.',
      400,
      'INVALID_TEXT_FILE'
    );
  }
};

const detectFileType = async (buffer, category, extension) => {
  // Roblox model and place files
  if (category === 'rbxm' || category === 'rbxl') {
    const validExtensions = category === 'rbxm'
      ? ['.rbxm', '.rbxmx']
      : ['.rbxl', '.rbxlx'];

    if (!validExtensions.includes(extension)) {
      throw new AppError(
        'File extension does not match the selected category.',
        400,
        'INVALID_FILE_EXTENSION'
      );
    }

    return validateRobloxFile(buffer, extension);
  }

  const allowedExtensions = ALLOWED_TYPES[category];

  if (!allowedExtensions || !allowedExtensions[extension]) {
    throw new AppError(
      'File extension is not allowed for this category.',
      400,
      'UNSUPPORTED_FILE_TYPE'
    );
  }

  // Plain text requires UTF-8 validation
  if (extension === '.txt') {
    return validateTextFile(buffer);
  }

  const detected = await fileTypeFromBuffer(buffer);

  if (
    !detected ||
    !allowedExtensions[extension].includes(detected.mime)
  ) {
    throw new AppError(
      'File content does not match its extension.',
      400,
      'FILE_SIGNATURE_MISMATCH'
    );
  }

  return detected.mime;
};

// Main upload service
export const processUpload = async (file, category, ownerId = null) => {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new AppError(
      'A valid uploaded file is required.',
      400,
      'INVALID_UPLOAD'
    );
  }

  if (
    file.buffer.length === 0 ||
    file.buffer.length > MAX_FILE_SIZE
  ) {
    throw new AppError(
      'File is empty or exceeds the 50 MB limit.',
      413,
      'INVALID_FILE_SIZE'
    );
  }

  const validCategories = [
    'image',
    'music',
    'file',
    'rbxm',
    'rbxl'
  ];

  if (!validCategories.includes(category)) {
    throw new AppError(
      'Unsupported upload category.',
      400,
      'INVALID_UPLOAD_CATEGORY'
    );
  }

  const originalName = file.originalname || '';
  const extension = getExtension(originalName);

  if (!extension || originalName.length > 255) {
    throw new AppError(
      'Invalid filename.',
      400,
      'INVALID_FILENAME'
    );
  }

  const contentType = await detectFileType(
    file.buffer,
    category,
    extension
  );

  const objectKey = ownerId\n    ? `users/${ownerId}/${category}/${randomUUID()}${extension}`\n    : `${category}/${randomUUID()}${extension}`;

  const storedFile = await uploadObject({
    key: objectKey,
    body: file.buffer,
    contentType
  });

  return {
    success: true,
    filename: originalName,
    category,
    contentType,
    size: file.buffer.length,
    storage: 'backblaze-b2',
    key: storedFile.key,
    etag: storedFile.etag
  };
};
