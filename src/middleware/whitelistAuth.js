import { authenticateWhitelist } from '../services/whitelist.service.js';
import { AppError } from '../utils/errors.js';

export const requireWhitelist = async (req, res, next) => {
  try {
    req.noxridge = await authenticateWhitelist(req.get('x-noxridge-user-id'), req.get('x-noxridge-wl-key'));
    return next();
  } catch (error) { return next(error); }
};


export const requireWhitelistFeature = (feature) => (req, res, next) => {
  const permissions = req.noxridge?.permissions || { mode: 'all', features: {} };
  const allowed = permissions.mode === 'all' || permissions.features?.[feature] === true;
  if (!allowed) {
    return next(new AppError('Fitur ini tidak diizinkan untuk akun whitelist kamu.', 403, 'WL_FEATURE_DISABLED', { feature }));
  }
  return next();
};
