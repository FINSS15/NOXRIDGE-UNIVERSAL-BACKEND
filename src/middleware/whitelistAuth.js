import { authenticateWhitelist } from '../services/whitelist.service.js';

export const requireWhitelist = async (req, res, next) => {
  try {
    req.noxridge = await authenticateWhitelist(req.get('x-noxridge-user-id'), req.get('x-noxridge-wl-key'));
    return next();
  } catch (error) { return next(error); }
};
