import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.string().optional(),

  // Shared backend authentication
  API_KEY: z.string().min(32).optional(),
  MASTER_KEY: z.string().min(32).optional(),

  // Account database and encrypted user-key vault
  DATABASE_URL: z.string().url().optional(),
  KEY_ENCRYPTION_SECRET: z.string().min(32).optional(),
  TRIAL_DURATION_HOURS: z.coerce.number().int().min(1).max(8760).default(24),

  // Backblaze B2
  B2_ENDPOINT: z.string().url().optional(),
  B2_REGION: z.string().min(1).optional(),
  B2_BUCKET: z.string().min(1).optional(),
  B2_KEY_ID: z.string().min(1).optional(),
  B2_APPLICATION_KEY: z.string().min(1).optional(),

  // AI Provider
  AI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_MODEL: z.string().min(1).optional(),

  // remove.bg background-removal service (secret stays on backend)
  REMOVE_BG_API_KEY: z.string().min(1).optional()
});

const result = envSchema.safeParse(process.env);
if (!result.success) {
  const errors = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${errors}`);
}

const parsedEnv = result.data;

const validateCompleteGroup = (keys, label) => {
  const configured = keys.filter((key) => parsedEnv[key] !== undefined);
  if (configured.length > 0 && configured.length !== keys.length) {
    const missing = keys.filter((key) => parsedEnv[key] === undefined);
    throw new Error(`Incomplete ${label} configuration. Missing: ${missing.join(', ')}`);
  }
};

validateCompleteGroup(
  ['B2_ENDPOINT', 'B2_REGION', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APPLICATION_KEY'],
  'Backblaze B2'
);
validateCompleteGroup(['AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL'], 'AI provider');

export const env = Object.freeze(parsedEnv);
