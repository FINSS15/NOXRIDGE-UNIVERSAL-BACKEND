import { authenticateSession } from '../services/account.service.js';

export const requireAccount = async (req, res, next) => {
  try {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({
        success: false,
        error: { code: 'ACCOUNT_TOKEN_REQUIRED', message: 'Use Authorization: Bearer <account-token>.' }
      });
    }
    req.account = await authenticateSession(match[1]);
    return next();
  } catch (error) {
    return next(error);
  }
};
