const errorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  let statusCode = Number(err.status || err.statusCode) || 500;
  let errorCode = 'INTERNAL_SERVER_ERROR';
  let message = 'An unexpected server error occurred.';

  // Zod validation errors
  if (err.name === 'ZodError') {
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = 'Request validation failed.';
  }

  // Invalid JSON
  else if (err.type === 'entity.parse.failed') {
    statusCode = 400;
    errorCode = 'INVALID_JSON';
    message = 'Request body contains invalid JSON.';
  }

  // Request body too large
  else if (err.type === 'entity.too.large') {
    statusCode = 413;
    errorCode = 'PAYLOAD_TOO_LARGE';
    message = 'Request body exceeds the allowed size.';
  }

  // Multer upload errors
  else if (err.name === 'MulterError') {
    statusCode = 400;
    errorCode = 'UPLOAD_ERROR';
    message = 'File upload validation failed.';

    if (err.code === 'LIMIT_FILE_SIZE') {
      statusCode = 413;
      errorCode = 'FILE_TOO_LARGE';
      message = 'Uploaded file exceeds the allowed size.';
    }

    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      errorCode = 'UNEXPECTED_FILE_FIELD';
      message = 'Unexpected file field.';
    }
  }

  // Known application errors
  else if (err.name === 'AppError') {
    statusCode = err.statusCode;
    errorCode = err.code;
    message = err.message;
  }

  // Other client errors
  else if (statusCode >= 400 && statusCode < 500) {
    errorCode = 'REQUEST_ERROR';
    message = err.message || 'The request could not be processed.';
  }

  // Protect against invalid HTTP status codes
  if (
    !Number.isInteger(statusCode) ||
    statusCode < 400 ||
    statusCode > 599
  ) {
    statusCode = 500;
    errorCode = 'INTERNAL_SERVER_ERROR';
    message = 'An unexpected server error occurred.';
  }

  // Never expose internal server error details
  if (statusCode >= 500) {
    console.error('[NOXRIDGE SERVER ERROR]', {
      method: req.method,
      path: req.originalUrl,
      message: err.message,
      stack: err.stack
    });

    errorCode = 'INTERNAL_SERVER_ERROR';
    message = 'An unexpected server error occurred.';
  }

  return res.status(statusCode).json({
    success: false,
    error: {
      code: errorCode,
      message
    }
  });
};

export default errorHandler;
