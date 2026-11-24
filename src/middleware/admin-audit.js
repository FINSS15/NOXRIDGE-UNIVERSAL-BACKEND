import { recordAdminActivity } from '../services/admin-audit.service.js';

export const auditAdminActivity = (req, res, next) => {
  const method = String(req.method || '').toUpperCase();
  if (!['POST','PUT','PATCH','DELETE'].includes(method)) return next();
  const originalJson = res.json.bind(res);
  let recorded = false;
  res.json = (body) => {
    if (!recorded && res.statusCode < 400 && req.noxridge?.userId) {
      recorded = true;
      const segments = String(req.baseUrl || '').concat(String(req.path || '')).split('/').filter(Boolean);
      const targetIndex = segments.findIndex(part => /^\\d{1,20}$/.test(part));
      const targetUserId = targetIndex >= 0 ? segments[targetIndex] : null;
      void recordAdminActivity({
        actorUserId: req.noxridge.userId,
        actorUsername: req.noxridge.username,
        action: method,
        resource: segments.filter(part => !/^\\d{1,20}$/.test(part)).join('/'),
        targetUserId,
        httpStatus: res.statusCode
      });
    }
    return originalJson(body);
  };
  next();
};
