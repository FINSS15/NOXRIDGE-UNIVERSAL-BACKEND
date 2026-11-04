import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // Application
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(3000),

  CORS_ORIGIN: z.string().optional(),

  // Authentication
  API_KEY: z.string().min(32).optional(),

  MASTER_KEY: z.string().min(32).optional(),

  // Backblaze B2 - S3 Compatible
  B2_ENDPOINT: z.string().url().optional(),

  B2_REGION: z.string().min(1).optional(),

  B2_BUCKET: z.string().min(1).optional(),

  B2_KEY_ID: z.string().min(1).optional(),

  B2_APPLICATION_KEY: z.string().min(1).optional()
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const errors = result.error.issues
    .map((issue) => {
      return `${issue.path.join('.')}: ${issue.message}`;
    })
    .join('\n');

  throw new Error(
    `Invalid environment configuration:\n${errors}`
  );
}

const parsedEnv = result.data;

// Validate complete Backblaze B2 configuration
const b2Variables = [
  'B2_ENDPOINT',
  'B2_REGION',
  'B2_BUCKET',
  'B2_KEY_ID',
  'B2_APPLICATION_KEY'
];

const configuredB2Variables = b2Variables.filter(
  (key) => parsedEnv[key] !== undefined
);

if (
  configuredB2Variables.length > 0 &&
  configuredB2Variables.length !== b2Variables.length
) {
  const missingVariables = b2Variables.filter(
    (key) => parsedEnv[key] === undefined
  );

  throw new Error(
    `Incomplete Backblaze B2 configuration. Missing: ${missingVariables.join(', ')}`
  );
}

export const env = Object.freeze(parsedEnv);
