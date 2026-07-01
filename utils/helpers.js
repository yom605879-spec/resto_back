export const generateCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const successResponse = (res, data, statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    data,
  });
};

export const errorResponse = (res, message, statusCode = 400) => {
  return res.status(statusCode).json({
    success: false,
    error: message,
  });
};

export const validateRequiredFields = (body, fields) => {
  const missing = fields.filter((field) => {
    const value = body[field];
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  });
  if (missing.length > 0) {
    return `Missing required fields: ${missing.join(', ')}`;
  }
  return null;
};

export const ROLES = {
  BOSS: 'boss',
  ADMIN: 'admin',
  CASHIER: 'kassir',
  CHEF: 'oshpaz',
  WAITER: 'ofitsiant',
  CASHIER_EN: 'cashier',
  CHEF_EN: 'chef',
  WAITER_EN: 'waiter',
};

export const ORDER_STATUSES = ['new', 'preparing', 'ready', 'served', 'completed', 'cancelled'];

export const PAYMENT_STATUSES = ['pending', 'paid', 'refunded'];

export const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'];

export const parsePaginationParams = (queryParams) => {
  const page = Math.max(1, parseInt(queryParams.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(queryParams.limit) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};
