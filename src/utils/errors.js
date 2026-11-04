export class AppError extends Error {
  constructor(
    message,
    statusCode = 500,
    code = 'INTERNAL_SERVER_ERROR'
  ) {
    super(message);

    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace?.(this, this.constructor);
  }
}

export const createError = (
  message,
  statusCode = 500,
  code = 'INTERNAL_SERVER_ERROR'
) => {
  return new AppError(message, statusCode, code);
};

export const badRequest = (
  message = 'The request is invalid.'
) => {
  return new AppError(message, 400, 'BAD_REQUEST');
};

export const unauthorized = (
  message = 'Authentication is required.'
) => {
  return new AppError(message, 401, 'UNAUTHORIZED');
};

export const forbidden = (
  message = 'Access is forbidden.'
) => {
  return new AppError(message, 403, 'FORBIDDEN');
};

export const notFoundError = (
  message = 'The requested resource was not found.'
) => {
  return new AppError(message, 404, 'RESOURCE_NOT_FOUND');
};

export const payloadTooLarge = (
  message = 'The uploaded file is too large.'
) => {
  return new AppError(message, 413, 'PAYLOAD_TOO_LARGE');
};

export const serviceUnavailable = (
  message = 'The requested service is unavailable.'
) => {
  return new AppError(
    message,
    503,
    'SERVICE_UNAVAILABLE'
  );
};
