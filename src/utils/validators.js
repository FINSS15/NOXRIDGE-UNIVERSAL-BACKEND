import { z } from 'zod';

export const apiKeySchema = z.object({
  apiKey: z.string().min(32).max(512)
});

export const masterKeySchema = z.object({
  masterKey: z.string().min(32).max(512)
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export const uploadMetadataSchema = z.object({
  category: z.enum(['image', 'music', 'file', 'rbxm', 'rbxl']),
  filename: z.string()
    .min(1)
    .max(255)
    .refine((value) => !/[\\/]/.test(value), 'Filename must not contain path separators.')
});

const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(10000)
});

export const aiChatSchema = z.object({
  message: z.string().trim().min(1).max(10000),
  conversation: z.array(conversationMessageSchema).max(50).default([])
});

export const validate = (schema, data) => schema.safeParse(data);
