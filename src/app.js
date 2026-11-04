import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';

const app = express();

app.disable('x-powered-by');

app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// CORS configuration
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
  res.status(200).json({
    success: true,
    name: 'NOXRIDGE UNIVERSAL BACKEND',
    organization: 'NOXRIDGE COMMUNITY',
    message: 'Backend API is running.',
    version: '1.0.0'
  });
});

export default app;
