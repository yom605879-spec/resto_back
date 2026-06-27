import { Router } from 'express';
import { queryMain, queryLogs } from '../db/init.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { successResponse, errorResponse, ROLES } from '../utils/helpers.js';

const router = Router();

router.use(authenticate);
router.use(authorize(ROLES.BOSS, ROLES.ADMIN));

// GET /api/payroll?month=YYYY-MM
router.get('/', async (req, res) => {
  try {
    const { month } = req.query; // YYYY-MM
    if (!month) {
      return errorResponse(res, 'Month parameter is required (YYYY-MM).');
    }

    const restaurantId = req.user.restaurant_id;

    // Fetch all staff
    const staffRes = await queryMain(
      `SELECT id, first_name, last_name, role, salary_type, fixed_salary, percentage_rate
       FROM staff
       WHERE restaurant_id = $1 AND is_active = TRUE`,
      [restaurantId]
    );
    const staffMembers = staffRes.rows;

    // Fetch paid salaries for this month
    const paidRes = await queryLogs(
      `SELECT staff_id, SUM(amount) as total_paid
       FROM salaries_paid
       WHERE restaurant_id = $1 AND month = $2
       GROUP BY staff_id`,
      [restaurantId, month]
    );
    const paidMap = {};
    paidRes.rows.forEach(r => paidMap[r.staff_id] = parseFloat(r.total_paid));

    // Calculate percentage earned
    // Currently, we'll associate orders with courier_id (for couriers) or assume cashiers/waiters handled orders where they are the created_by/updated_by?
    // Wait, we don't have a created_by in `orders` table. The orders table has `courier_id`. 
    // If it's a waiter, we don't track which waiter served which order explicitly yet, except maybe in `staff` vs `orders` we don't have a direct link.
    // For now, if role is courier, we check orders where courier_id = staff_id.
    // For other roles, percentage might not be trackable per-order yet unless we add staff_id to orders.
    // Let's check what fields we have in orders: `courier_id`. We can use courier_id for Couriers. 
    // What if the boss gives percentage to the whole team based on total restaurant revenue?
    // Let's compute total restaurant revenue for the month first.
    
    const revenueRes = await queryMain(
      `SELECT SUM(total_amount) as total_revenue
       FROM orders
       WHERE restaurant_id = $1 AND status = 'completed' AND TO_CHAR(created_at, 'YYYY-MM') = $2`,
      [restaurantId, month]
    );
    const totalRevenue = parseFloat(revenueRes.rows[0].total_revenue) || 0;

    const payroll = [];

    for (const staff of staffMembers) {
      let fixed = 0;
      let percentageEarned = 0;

      if (['fixed', 'both'].includes(staff.salary_type)) {
        fixed = parseFloat(staff.fixed_salary) || 0;
      }

      if (['percentage', 'both'].includes(staff.salary_type)) {
        const rate = parseFloat(staff.percentage_rate) || 0;
        if (staff.role === ROLES.COURIER) {
          // Calculate only from orders they delivered
          const courierOrders = await queryMain(
            `SELECT SUM(total_amount) as courier_revenue
             FROM orders
             WHERE restaurant_id = $1 AND courier_id = $2 AND status = 'completed' AND TO_CHAR(created_at, 'YYYY-MM') = $3`,
            [restaurantId, staff.id, month]
          );
          const courierRevenue = parseFloat(courierOrders.rows[0].courier_revenue) || 0;
          percentageEarned = (courierRevenue * rate) / 100;
        } else {
          // For chefs, admins, waiters, cashiers - we'll calculate percentage from total restaurant revenue
          percentageEarned = (totalRevenue * rate) / 100;
        }
      }

      const totalEarned = fixed + percentageEarned;
      const paid = paidMap[staff.id] || 0;
      const remaining = totalEarned - paid;

      payroll.push({
        staff_id: staff.id,
        first_name: staff.first_name,
        last_name: staff.last_name,
        role: staff.role,
        salary_type: staff.salary_type,
        fixed_salary: fixed,
        percentage_rate: parseFloat(staff.percentage_rate),
        percentage_earned: percentageEarned,
        total_earned: totalEarned,
        paid: paid,
        remaining: remaining
      });
    }

    return successResponse(res, { month, total_revenue: totalRevenue, payroll });

  } catch (error) {
    console.error('Get payroll error:', error);
    return errorResponse(res, 'Failed to fetch payroll data.', 500);
  }
});

// POST /api/payroll/pay
router.post('/pay', async (req, res) => {
  try {
    const { staff_id, amount, month, details } = req.body;
    
    if (!staff_id || !amount || !month) {
      return errorResponse(res, 'staff_id, amount, and month are required.');
    }

    const result = await queryLogs(
      `INSERT INTO salaries_paid (restaurant_id, staff_id, amount, month, details)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.restaurant_id, staff_id, amount, month, details || '']
    );

    return successResponse(res, { payment: result.rows[0] });

  } catch (error) {
    console.error('Pay salary error:', error);
    return errorResponse(res, 'Failed to record salary payment.', 500);
  }
});

export default router;
