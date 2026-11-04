import { z } from 'zod';

// API key validation
export const apiKeySchema = z.object({
  apiKey: z.string().min(32).max(512)
});

// Master key validation
export const masterKeySchema = z.object({
  masterKey: z.string().min(32).max(512)
});

// Pagination validation
export const paginationSchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .default(1),

  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
});

// File upload metadata validation
export const uploadMetadataSchema = z.object({
  category: z.enum([
    'image',
    'music',
    'file',
    'rbxm',
    'rbxl'
  ]),

  filename: z.string()
    .min(1)
    .max(255)
    .refine(
      (value) => !/[\\/]/.test(value),
      'Filename must not contain path separators.'
    )
});

// AI chat validation
export const aiChatSchema = z.object({
  message: z.string()
    .trim()
    .min(1)
    .max(10000),

  conversationId: z.string()
    .max(128)
    .optional()
});

// Generic validation helper
export const validate = (schema, data) => {
  return schema.safeParse(data);
};
