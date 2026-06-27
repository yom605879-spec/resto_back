import { Router } from 'express';
import { queryMain, queryLogs, queryMedia } from '../db/init.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { successResponse, errorResponse, ROLES } from '../utils/helpers.js';

const router = Router();

router.use(authenticate);
router.use(authorize(ROLES.BOSS, ROLES.ADMIN));

// GET /api/stats/overview
router.get('/overview', async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;

    const todayOrdersResult = await queryMain(
      `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
       FROM orders
       WHERE restaurant_id = $1 AND DATE(created_at) = CURRENT_DATE`,
      [restaurantId]
    );

    const monthOrdersResult = await queryMain(
      `SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
       FROM orders
       WHERE restaurant_id = $1
         AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW())
         AND EXTRACT(MONTH FROM created_at) = EXTRACT(MONTH FROM NOW())`,
      [restaurantId]
    );

    const todayExpensesResult = await queryLogs(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM expenses
       WHERE restaurant_id = $1 AND date = CURRENT_DATE`,
      [restaurantId]
    );

    const monthExpensesResult = await queryLogs(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM expenses
       WHERE restaurant_id = $1
         AND EXTRACT(YEAR FROM date) = EXTRACT(YEAR FROM NOW())
         AND EXTRACT(MONTH FROM date) = EXTRACT(MONTH FROM NOW())`,
      [restaurantId]
    );

    const menuItemsResult = await queryMedia(
      'SELECT COUNT(*) as count FROM menu_items WHERE restaurant_id = $1 AND is_available = TRUE',
      [restaurantId]
    );

    const staffResult = await queryMain(
      'SELECT COUNT(*) as count FROM staff WHERE restaurant_id = $1 AND is_active = TRUE',
      [restaurantId]
    );

    const activeOrdersResult = await queryMain(
      `SELECT COUNT(*) as count FROM orders
       WHERE restaurant_id = $1 AND status NOT IN ('completed', 'cancelled')`,
      [restaurantId]
    );

    const todayPaidResult = await queryMain(
      `SELECT COALESCE(SUM(total_amount), 0) as total
       FROM orders
       WHERE restaurant_id = $1 AND DATE(created_at) = CURRENT_DATE AND payment_status = 'paid'`,
      [restaurantId]
    );

    return successResponse(res, {
      overview: {
        today: {
          orders_count: parseInt(todayOrdersResult.rows[0].count),
          orders_total: parseFloat(todayOrdersResult.rows[0].total),
          expenses_total: parseFloat(todayExpensesResult.rows[0].total),
          paid_total: parseFloat(todayPaidResult.rows[0].total),
          net_income: parseFloat(todayPaidResult.rows[0].total) - parseFloat(todayExpensesResult.rows[0].total),
        },
        month: {
          orders_count: parseInt(monthOrdersResult.rows[0].count),
          orders_total: parseFloat(monthOrdersResult.rows[0].total),
          expenses_total: parseFloat(monthExpensesResult.rows[0].total),
          net_income: parseFloat(monthOrdersResult.rows[0].total) - parseFloat(monthExpensesResult.rows[0].total),
        },
        active_orders: parseInt(activeOrdersResult.rows[0].count),
        menu_items_count: parseInt(menuItemsResult.rows[0].count),
        staff_count: parseInt(staffResult.rows[0].count),
      },
    });
  } catch (error) {
    console.error('Stats overview error:', error);
    return errorResponse(res, 'Failed to fetch stats overview.', 500);
  }
});

// GET /api/stats/income
router.get('/income', async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const { period, start_date, end_date } = req.query;

    let groupBy;
    let dateFilter = '';
    const params = [restaurantId];
    let paramIndex = 2;

    if (start_date && end_date) {
      dateFilter = ` AND DATE(o.created_at) BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      params.push(start_date, end_date);
      paramIndex += 2;
    }

    switch (period) {
      case 'daily':
        groupBy = 'DATE(o.created_at)';
        if (!start_date) {
          dateFilter = ` AND o.created_at >= NOW() - INTERVAL '30 days'`;
        }
        break;
      case 'weekly':
        groupBy = `DATE_TRUNC('week', o.created_at)`;
        if (!start_date) {
          dateFilter = ` AND o.created_at >= NOW() - INTERVAL '12 weeks'`;
        }
        break;
      case 'monthly':
        groupBy = `DATE_TRUNC('month', o.created_at)`;
        if (!start_date) {
          dateFilter = ` AND o.created_at >= NOW() - INTERVAL '12 months'`;
        }
        break;
      default:
        groupBy = 'DATE(o.created_at)';
        if (!start_date) {
          dateFilter = ` AND o.created_at >= NOW() - INTERVAL '30 days'`;
        }
    }

    const incomeResult = await queryMain(
      `SELECT ${groupBy} as date,
              COUNT(*) as orders_count,
              COALESCE(SUM(o.total_amount), 0) as income
       FROM orders o
       WHERE o.restaurant_id = $1${dateFilter}
       GROUP BY ${groupBy}
       ORDER BY ${groupBy} ASC`,
      params
    );

    const expenseParams = [restaurantId];
    let expenseFilter = '';
    let expParamIndex = 2;

    if (start_date && end_date) {
      expenseFilter = ` AND e.date BETWEEN $${expParamIndex} AND $${expParamIndex + 1}`;
      expenseParams.push(start_date, end_date);
    }

    let expGroupBy;
    switch (period) {
      case 'daily':
        expGroupBy = 'e.date';
        if (!start_date) expenseFilter = ` AND e.date >= CURRENT_DATE - INTERVAL '30 days'`;
        break;
      case 'weekly':
        expGroupBy = `DATE_TRUNC('week', e.date)`;
        if (!start_date) expenseFilter = ` AND e.date >= CURRENT_DATE - INTERVAL '12 weeks'`;
        break;
      case 'monthly':
        expGroupBy = `DATE_TRUNC('month', e.date)`;
        if (!start_date) expenseFilter = ` AND e.date >= CURRENT_DATE - INTERVAL '12 months'`;
        break;
      default:
        expGroupBy = 'e.date';
        if (!start_date) expenseFilter = ` AND e.date >= CURRENT_DATE - INTERVAL '30 days'`;
    }

    const expensesResult = await queryLogs(
      `SELECT ${expGroupBy} as date,
              COALESCE(SUM(e.amount), 0) as expenses
       FROM expenses e
       WHERE e.restaurant_id = $1 ${expenseFilter}
       GROUP BY date
       ORDER BY date ASC`,
      [restaurantId]
    );

    const merged = {};
    incomeResult.rows.forEach(r => {
      merged[r.date] = { date: r.date, orders_count: parseInt(r.orders_count), income: parseFloat(r.income), expenses: 0 };
    });
    expensesResult.rows.forEach(r => {
      if (!merged[r.date]) {
        merged[r.date] = { date: r.date, orders_count: 0, income: 0, expenses: parseFloat(r.expenses) };
      } else {
        merged[r.date].expenses = parseFloat(r.expenses);
      }
    });

    return successResponse(res, { daily: Object.values(merged).sort((a,b) => a.date > b.date ? 1 : -1) });
  } catch (error) {
    console.error('Stats income error:', error);
    return errorResponse(res, 'Failed to fetch income stats.', 500);
  }
});

// GET /api/stats/top-items
router.get('/top-items', async (req, res) => {
  try {
    const restaurantId = req.user.restaurant_id;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));

    const result = await queryMain(
      `SELECT oi.item_name,
              SUM(oi.quantity) as total_quantity,
              SUM(oi.total) as total_revenue
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.restaurant_id = $1
       GROUP BY oi.item_name
       ORDER BY total_quantity DESC
       LIMIT $2`,
      [restaurantId, limit]
    );

    return successResponse(res, { top_items: result.rows });
  } catch (error) {
    console.error('Top items error:', error);
    return errorResponse(res, 'Failed to fetch top items.', 500);
  }
});

export default router;
