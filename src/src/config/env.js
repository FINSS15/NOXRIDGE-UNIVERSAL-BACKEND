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

  // Backblaze B2
  B2_ENDPOINT: z.string().url().optional(),

  B2_REGION: z.string().min(1).optional(),

  B2_BUCKET: z.string().min(1).optional(),

  B2_KEY_ID: z.string().min(1).optional(),

  B2_APPLICATION_KEY: z.string().min(1).optional(),

  // AI Provider
  AI_API_KEY: z.string().min(1).optional(),

  AI_BASE_URL: z.string().url().optional(),

  AI_MODEL: z.string().min(1).optional()
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

// Validate Backblaze B2 configuration
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

// Validate AI provider configuration
const aiVariables = [
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_MODEL'
];

const configuredAiVariables = aiVariables.filter(
  (key) => parsedEnv[key] !== undefined
);

if (
  configuredAiVariables.length > 0 &&
  configuredAiVariables.length !== aiVariables.length
) {
  const missingVariables = aiVariables.filter(
    (key) => parsedEnv[key] === undefined
  );

  throw new Error(
    `Incomplete AI configuration. Missing: ${missingVariables.join(', ')}`
  );
}

export const env = Object.freeze(parsedEnv);
