import { rateLimit } from 'express-rate-limit';

const createRateLimiter = ({
  limit,
  message
}) => {
  return rateLimit({
    windowMs: 15 * 60 * 1000,

    limit,

    standardHeaders: true,

    legacyHeaders: false,

    handler: (req, res) => {
      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message
        },
        retryAfter: res.getHeader('Retry-After') || null
      });
    }
  });
};

// General API: 100 requests per 15 minutes
export const apiRateLimiter = createRateLimiter({
  limit: 100,
  message: 'Too many API requests. Please try again later.'
});

// AI API: 20 requests per 15 minutes
export const aiRateLimiter = createRateLimiter({
  limit: 20,
  message: 'Too many AI requests. Please try again later.'
});

// Upload API: 10 requests per 15 minutes
export const uploadRateLimiter = createRateLimiter({
  limit: 10,
  message: 'Too many upload requests. Please try again later.'
});
