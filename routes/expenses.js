import { Router } from 'express';
import { queryLogs } from '../db/init.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { successResponse, errorResponse, validateRequiredFields, ROLES, parsePaginationParams } from '../utils/helpers.js';

const router = Router();

router.use(authenticate);
router.use(authorize(ROLES.BOSS));

// GET /api/expenses
router.get('/', async (req, res) => {
  try {
    const { category, start_date, end_date } = req.query;
    const { limit, offset, page } = parsePaginationParams(req.query);

    let sql = `SELECT id, category, amount, description, date, created_at
               FROM expenses WHERE restaurant_id = $1`;
    const params = [req.user.restaurant_id];
    let paramIndex = 2;

    if (category) {
      sql += ` AND category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    if (start_date) {
      sql += ` AND date >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }

    if (end_date) {
      sql += ` AND date <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    const countResult = await queryLogs(
      sql.replace(/SELECT [\s\S]*? FROM/i, 'SELECT COUNT(*) as total FROM'),
      params
    );
    const total = parseInt(countResult.rows[0].total);

    sql += ` ORDER BY date DESC, created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await queryLogs(sql, params);

    const totalAmountResult = await queryLogs(
      `SELECT COALESCE(SUM(amount), 0) as total_amount FROM expenses
       WHERE restaurant_id = $1
       ${category ? 'AND category = $2' : ''}
       ${start_date ? `AND date >= $${category ? 3 : 2}` : ''}
       ${end_date ? `AND date <= $${category ? (start_date ? 4 : 3) : (start_date ? 3 : 2)}` : ''}`,
      params.slice(0, paramIndex - 1)
    );

    return successResponse(res, {
      expenses: result.rows,
      total_amount: parseFloat(totalAmountResult.rows[0].total_amount),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Get expenses error:', error);
    return errorResponse(res, 'Failed to fetch expenses.', 500);
  }
});

// GET /api/expenses/categories
router.get('/categories', async (req, res) => {
  try {
    const result = await queryLogs(
      `SELECT DISTINCT category FROM expenses
       WHERE restaurant_id = $1
       ORDER BY category ASC`,
      [req.user.restaurant_id]
    );

    return successResponse(res, { categories: result.rows.map((r) => r.category) });
  } catch (error) {
    console.error('Get expense categories error:', error);
    return errorResponse(res, 'Failed to fetch expense categories.', 500);
  }
});

// POST /api/expenses
router.post('/', async (req, res) => {
  try {
    const { category, amount, description, date } = req.body;

    const validationError = validateRequiredFields(req.body, ['category', 'amount']);
    if (validationError) {
      return errorResponse(res, validationError);
    }

    if (parseFloat(amount) <= 0) {
      return errorResponse(res, 'Amount must be a positive number.');
    }

    const result = await queryLogs(
      `INSERT INTO expenses (restaurant_id, category, amount, description, date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, category, amount, description, date, created_at`,
      [req.user.restaurant_id, category.trim(), amount, description || null, date || new Date().toISOString().split('T')[0]]
    );

    return successResponse(res, { expense: result.rows[0] }, 201);
  } catch (error) {
    console.error('Create expense error:', error);
    return errorResponse(res, 'Failed to create expense.', 500);
  }
});

// PUT /api/expenses/:id
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { category, amount, description, date } = req.body;

    const existing = await queryLogs(
      'SELECT id FROM expenses WHERE id = $1 AND restaurant_id = $2',
      [id, req.user.restaurant_id]
    );

    if (existing.rows.length === 0) {
      return errorResponse(res, 'Expense not found.', 404);
    }

    const result = await queryLogs(
      `UPDATE expenses
       SET category = COALESCE($1, category),
           amount = COALESCE($2, amount),
           description = COALESCE($3, description),
           date = COALESCE($4, date)
       WHERE id = $5 AND restaurant_id = $6
       RETURNING id, category, amount, description, date, created_at`,
      [category || null, amount !== undefined ? amount : null, description !== undefined ? description : null, date || null, id, req.user.restaurant_id]
    );

    return successResponse(res, { expense: result.rows[0] });
  } catch (error) {
    console.error('Update expense error:', error);
    return errorResponse(res, 'Failed to update expense.', 500);
  }
});

// DELETE /api/expenses/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await queryLogs(
      'DELETE FROM expenses WHERE id = $1 AND restaurant_id = $2 RETURNING id',
      [id, req.user.restaurant_id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Expense not found.', 404);
    }

    return successResponse(res, { message: 'Expense deleted successfully.' });
  } catch (error) {
    console.error('Delete expense error:', error);
    return errorResponse(res, 'Failed to delete expense.', 500);
  }
});

export default router;
