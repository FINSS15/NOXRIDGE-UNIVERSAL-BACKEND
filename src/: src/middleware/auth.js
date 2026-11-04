import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const safeCompare = (provided, expected) => {
  if (
    typeof provided !== 'string' ||
    typeof expected !== 'string' ||
    provided.length === 0 ||
    expected.length === 0
  ) {
    return false;
  }

  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

// API Key Authentication
export const requireApiKey = (req, res, next) => {
  if (!env.API_KEY) {
    return res.status(503).json({
      success: false,
      error: {
        code: 'API_KEY_NOT_CONFIGURED',
        message: 'API key authentication is not configured.'
      }
    });
  }

  const providedKey = req.get('x-api-key');

  if (!safeCompare(providedKey, env.API_KEY)) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_API_KEY',
        message: 'A valid API key is required.'
      }
    });
  }

  return next();
};

// Master Key Authentication
export const requireMasterKey = (req, res, next) => {
  if (!env.MASTER_KEY) {
    return res.status(503).json({
      success: false,
      error: {
        code: 'MASTER_KEY_NOT_CONFIGURED',
        message: 'Master key authentication is not configured.'
      }
    });
  }

  const providedKey = req.get('x-master-key');

  if (!safeCompare(providedKey, env.MASTER_KEY)) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_MASTER_KEY',
        message: 'A valid master key is required.'
      }
    });
  }

  return next();
};
