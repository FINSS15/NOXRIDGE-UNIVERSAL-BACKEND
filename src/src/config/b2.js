import { S3Client } from '@aws-sdk/client-s3';
import { env } from './env.js';

const isB2Configured = Boolean(
  env.B2_ENDPOINT &&
  env.B2_REGION &&
  env.B2_BUCKET &&
  env.B2_KEY_ID &&
  env.B2_APPLICATION_KEY
);

export const b2Client = isB2Configured
  ? new S3Client({
      endpoint: env.B2_ENDPOINT,

      region: env.B2_REGION,

      credentials: {
        accessKeyId: env.B2_KEY_ID,
        secretAccessKey: env.B2_APPLICATION_KEY
      },

      forcePathStyle: true,

      maxAttempts: 3
    })
  : null;

export const B2_BUCKET = env.B2_BUCKET || null;

export const isB2Ready = isB2Configured;
