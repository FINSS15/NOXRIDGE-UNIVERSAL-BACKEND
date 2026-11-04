import {
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand
} from '@aws-sdk/client-s3';

import {
  b2Client,
  B2_BUCKET,
  isB2Ready
} from '../config/b2.js';

import { AppError } from '../utils/errors.js';

const ensureB2Ready = () => {
  if (!isB2Ready || !b2Client || !B2_BUCKET) {
    throw new AppError(
      'Backblaze B2 storage is not configured.',
      503,
      'B2_NOT_CONFIGURED'
    );
  }
};

// Upload an object to Backblaze B2
export const uploadObject = async ({
  key,
  body,
  contentType,
  metadata
}) => {
  ensureB2Ready();

  if (!key || typeof key !== 'string') {
    throw new AppError(
      'A valid storage object key is required.',
      400,
      'INVALID_OBJECT_KEY'
    );
  }

  if (!body) {
    throw new AppError(
      'A file body is required.',
      400,
      'EMPTY_FILE_BODY'
    );
  }

  try {
    const result = await b2Client.send(
      new PutObjectCommand({
        Bucket: B2_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType || 'application/octet-stream',
        Metadata: metadata
      })
    );

    return {
      bucket: B2_BUCKET,
      key,
      etag: result.ETag || null
    };
  } catch (error) {
    console.error('[NOXRIDGE B2 UPLOAD ERROR]', {
      key,
      name: error.name
    });

    throw new AppError(
      'Failed to upload file to Backblaze B2.',
      503,
      'B2_UPLOAD_FAILED'
    );
  }
};

// Delete an object from Backblaze B2
export const deleteObject = async (key) => {
  ensureB2Ready();

  if (!key || typeof key !== 'string') {
    throw new AppError(
      'A valid storage object key is required.',
      400,
      'INVALID_OBJECT_KEY'
    );
  }

  try {
    await b2Client.send(
      new DeleteObjectCommand({
        Bucket: B2_BUCKET,
        Key: key
      })
    );

    return {
      bucket: B2_BUCKET,
      key,
      deleted: true
    };
  } catch (error) {
    console.error('[NOXRIDGE B2 DELETE ERROR]', {
      key,
      name: error.name
    });

    throw new AppError(
      'Failed to delete file from Backblaze B2.',
      503,
      'B2_DELETE_FAILED'
    );
  }
};

// Check actual Backblaze B2 bucket connectivity
export const checkB2Connection = async () => {
  ensureB2Ready();

  try {
    await b2Client.send(
      new HeadBucketCommand({
        Bucket: B2_BUCKET
      })
    );

    return {
      connected: true,
      bucket: B2_BUCKET
    };
  } catch (error) {
    console.error('[NOXRIDGE B2 CONNECTION ERROR]', {
      name: error.name
    });

    throw new AppError(
      'Unable to connect to Backblaze B2 storage.',
      503,
      'B2_CONNECTION_FAILED'
    );
  }
};
