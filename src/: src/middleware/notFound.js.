const notFound = (req, res) => {
  return res.status(404).json({
    success: false,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: 'The requested endpoint does not exist.',
      path: req.originalUrl,
      method: req.method
    }
  });
};

export default notFound;
