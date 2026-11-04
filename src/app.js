import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { env } from './config/env.js';

import healthRoutes from './routes/health.routes.js';
import systemRoutes from './routes/system.routes.js';
import authRoutes from './routes/auth.routes.js';
import aiRoutes from './routes/ai.routes.js';
import uploadRoutes from './routes/upload.routes.js';

import {
  apiRateLimiter,
  aiRateLimiter,
  uploadRateLimiter
} from './middleware/rateLimit.js';

import notFound from './middleware/notFound.js';
import errorHandler from './middleware/errorHandler.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet());

const allowedOrigins = env.CORS_ORIGIN
  ? env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : false;

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-master-key']
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/', (req, res) => res.status(200).json({
  success: true,
  name: 'NOXRIDGE UNIVERSAL BACKEND',
  organization: 'NOXRIDGE COMMUNITY',
  message: 'Backend API is running.',
  version: '1.0.0'
}));

app.use('/', healthRoutes);
app.use('/system', apiRateLimiter, systemRoutes);
app.use('/auth', apiRateLimiter, authRoutes);
app.use('/ai', aiRateLimiter, aiRoutes);
app.use('/upload', uploadRateLimiter, uploadRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
