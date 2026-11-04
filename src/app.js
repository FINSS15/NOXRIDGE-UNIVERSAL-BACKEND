import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { env } from './config/env.js';

import healthRoutes from './routes/health.routes.js';
import systemRoutes from './routes/system.routes.js';
import authRoutes from './routes/auth.routes.js';
import aiRoutes from './routes/ai.routes.js';
import uploadRoutes from './routes/upload.routes.js';

import { apiRateLimiter } from './middleware/rateLimit.js';
import { aiRateLimiter } from './middleware/rateLimit.js';
import { uploadRateLimiter } from './middleware/rateLimit.js';

import notFound from './middleware/notFound.js';
import errorHandler from './middleware/errorHandler.js';

const app = express();

app.disable('x-powered-by');

app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// CORS
const allowedOrigins = env.CORS_ORIGIN
  ? env.CORS_ORIGIN
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  : false;

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-api-key',
    'x-master-key'
  ]
}));

// Request body limits
app.use(express.json({
  limit: '1mb'
}));

app.use(express.urlencoded({
  extended: true,
  limit: '1mb'
}));

// Root endpoint
app.get('/', (req, res) => {
  return res.status(200).json({
    success: true,
    name: 'NOXRIDGE UNIVERSAL BACKEND',
    organization: 'NOXRIDGE COMMUNITY',
    message: 'Backend API is running.',
    version: '1.0.0'
  });
});

// Health check
app.use('/', healthRoutes);

// General API rate limit
app.use('/system', apiRateLimiter);
app.use('/auth', apiRateLimiter);

// System status
app.use('/system', systemRoutes);

// Authentication
app.use('/auth', authRoutes);

// AI Chat
app.use('/ai', aiRateLimiter, aiRoutes);

// File upload
app.use('/', uploadRateLimiter, uploadRoutes);

// 404 handler
app.use(notFound);

// Centralized error handler
app.use(errorHandler);

export default app;
