/**
 * General helper functions for the application.
 */

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const getPagination = (page = 1, limit = 20) => {
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (Math.max(1, parseInt(page, 10) || 1) - 1) * limitNum;
  return { skip, limit: limitNum };
};

module.exports = { asyncHandler, getPagination };
