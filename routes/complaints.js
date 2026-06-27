import { Router } from 'express';
import { queryLogs } from '../db/init.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { successResponse, errorResponse, validateRequiredFields, ROLES, parsePaginationParams } from '../utils/helpers.js';

const router = Router();

// PUBLIC: Submit a complaint
router.post('/public/:restaurant_id', async (req, res) => {
  try {
    const { restaurant_id } = req.params;
    const { customer_name, customer_phone, subject, message } = req.body;

    const validationError = validateRequiredFields(req.body, ['customer_name', 'subject', 'message']);
    if (validationError) {
      return errorResponse(res, validationError);
    }

    const restaurantCheck = await queryLogs(
      'SELECT id FROM restaurants WHERE id = $1 AND is_active = TRUE',
      [restaurant_id]
    );

    if (restaurantCheck.rows.length === 0) {
      return errorResponse(res, 'Restaurant not found.', 404);
    }

    const result = await queryLogs(
      `INSERT INTO complaints (restaurant_id, customer_name, customer_phone, subject, message, status)
       VALUES ($1, $2, $3, $4, $5, 'new')
       RETURNING id, customer_name, customer_phone, subject, message, status, created_at`,
      [restaurant_id, customer_name.trim(), customer_phone || null, subject.trim(), message.trim()]
    );

    return successResponse(res, { complaint: result.rows[0] }, 201);
  } catch (error) {
    console.error('Create public complaint error:', error);
    return errorResponse(res, 'Failed to submit complaint.', 500);
  }
});

// PROTECTED ROUTES FOR STAFF
router.use(authenticate);
router.use(authorize(ROLES.BOSS, ROLES.ADMIN));

// GET /api/complaints
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const { limit, offset, page } = parsePaginationParams(req.query);

    let sql = `SELECT id, customer_name, customer_phone, subject, message, status, created_at
               FROM complaints WHERE restaurant_id = $1`;
    const params = [req.user.restaurant_id];
    let paramIndex = 2;

    if (status) {
      sql += ` AND status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    const countResult = await queryLogs(
      sql.replace(/SELECT [\s\S]*? FROM/i, 'SELECT COUNT(*) as total FROM'),
      params
    );
    const total = parseInt(countResult.rows[0].total);

    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await queryLogs(sql, params);

    return successResponse(res, {
      complaints: result.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Get complaints error:', error);
    return errorResponse(res, 'Failed to fetch complaints.', 500);
  }
});

// PUT /api/complaints/:id/status
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['new', 'resolved', 'investigating'].includes(status)) {
      return errorResponse(res, 'Invalid status. Allowed: new, resolved, investigating');
    }

    const existing = await queryLogs(
      'SELECT id FROM complaints WHERE id = $1 AND restaurant_id = $2',
      [id, req.user.restaurant_id]
    );

    if (existing.rows.length === 0) {
      return errorResponse(res, 'Complaint not found.', 404);
    }

    const result = await queryLogs(
      `UPDATE complaints
       SET status = $1
       WHERE id = $2 AND restaurant_id = $3
       RETURNING id, customer_name, customer_phone, subject, message, status, created_at`,
      [status, id, req.user.restaurant_id]
    );

    return successResponse(res, { complaint: result.rows[0] });
  } catch (error) {
    console.error('Update complaint status error:', error);
    return errorResponse(res, 'Failed to update complaint.', 500);
  }
});

export default router;
