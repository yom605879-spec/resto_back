import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { queryMain } from '../db/init.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { successResponse, errorResponse, validateRequiredFields, ROLES } from '../utils/helpers.js';

const router = Router();

router.use(authenticate);
router.use(authorize(ROLES.BOSS, ROLES.ADMIN));

// GET /api/staff
router.get('/', async (req, res) => {
  try {
    const result = await queryMain(
      `SELECT id, telegram_id, username, first_name, last_name, role, salary_type, fixed_salary, percentage_rate, created_at, is_active
       FROM staff
       WHERE restaurant_id = $1
       ORDER BY created_at DESC`,
      [req.user.restaurant_id]
    );

    const staffList = result.rows.map((s) => ({
      ...s,
      telegram_id: s.telegram_id ? s.telegram_id.toString() : null,
      is_approved: true,
    }));

    return successResponse(res, { staff: staffList });
  } catch (error) {
    console.error('Get staff error:', error);
    return errorResponse(res, 'Failed to fetch staff.', 500);
  }
});

// GET /api/staff/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await queryMain(
      `SELECT id, telegram_id, username, first_name, last_name, role, salary_type, fixed_salary, percentage_rate, created_at, is_active
       FROM staff
       WHERE id = $1 AND restaurant_id = $2`,
      [id, req.user.restaurant_id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Staff member not found.', 404);
    }

    const member = result.rows[0];
    member.telegram_id = member.telegram_id ? member.telegram_id.toString() : null;

    return successResponse(res, { staff: member });
  } catch (error) {
    console.error('Get staff member error:', error);
    return errorResponse(res, 'Failed to fetch staff member.', 500);
  }
});

// POST /api/staff
router.post('/', async (req, res) => {
  try {
    const { username, password, first_name, last_name, role, telegram_id, salary_type = 'fixed', fixed_salary = 0, percentage_rate = 0 } = req.body;

    const validationError = validateRequiredFields(req.body, ['username', 'password', 'role']);
    if (validationError) {
      return errorResponse(res, validationError);
    }

    const allowedRoles = [ROLES.ADMIN, ROLES.CASHIER, ROLES.CHEF, ROLES.WAITER, 'admin', 'kassir', 'oshpaz', 'ofitsiant', 'cashier', 'chef', 'waiter'];
    if (!allowedRoles.includes(role)) {
      return errorResponse(res, `Invalid role. Allowed: ${allowedRoles.join(', ')}`);
    }

    if (password.length < 4) {
      return errorResponse(res, 'Password must be at least 4 characters long.');
    }

    const usernameLower = username.toLowerCase();

    if (!/^[a-zA-Z0-9_]+$/.test(usernameLower)) {
      return errorResponse(res, 'Username can only contain letters, numbers, and underscores.');
    }

    const existingInUsers = await queryMain('SELECT id FROM users WHERE username = $1', [usernameLower]);
    if (existingInUsers.rows.length > 0) {
      return errorResponse(res, 'Username already taken.');
    }

    const existingInStaff = await queryMain('SELECT id FROM staff WHERE username = $1', [usernameLower]);
    if (existingInStaff.rows.length > 0) {
      return errorResponse(res, 'Username already taken.');
    }

    if (telegram_id) {
      const existingTelegram = await queryMain(
        'SELECT id FROM staff WHERE telegram_id = $1',
        [telegram_id.toString()]
      );
      if (existingTelegram.rows.length > 0) {
        return errorResponse(res, 'This Telegram account is already linked to a staff member.');
      }

      const existingUserTelegram = await queryMain(
        'SELECT id FROM users WHERE telegram_id = $1',
        [telegram_id.toString()]
      );
      if (existingUserTelegram.rows.length > 0) {
        return errorResponse(res, 'This Telegram account is already linked to a user.');
      }
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await queryMain(
      `INSERT INTO staff (telegram_id, username, first_name, last_name, password_hash, role, salary_type, fixed_salary, percentage_rate, restaurant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, telegram_id, username, first_name, last_name, role, salary_type, fixed_salary, percentage_rate, created_at, is_active`,
      [
        telegram_id ? telegram_id.toString() : null,
        usernameLower,
        first_name || null,
        last_name || null,
        passwordHash,
        role,
        salary_type,
        fixed_salary,
        percentage_rate,
        req.user.restaurant_id,
      ]
    );

    const member = result.rows[0];
    member.telegram_id = member.telegram_id ? member.telegram_id.toString() : null;
    member.is_approved = true;

    // Sync with users table so the staff member can also log in
    await queryMain(
      `INSERT INTO users (telegram_id, username, first_name, last_name, password_hash, role, is_approved, is_active, restaurant_id)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE, $7)
       ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, is_approved = TRUE, is_active = TRUE, restaurant_id = EXCLUDED.restaurant_id`,
      [
        telegram_id ? telegram_id.toString() : null,
        usernameLower,
        first_name || null,
        last_name || null,
        passwordHash,
        role,
        req.user.restaurant_id,
      ]
    ).catch(e => console.error('Sync to users error:', e));

    return successResponse(res, { staff: member }, 201);
  } catch (error) {
    console.error('Create staff error:', error);
    if (error.code === '23505') {
      return errorResponse(res, 'Username or Telegram ID already exists.');
    }
    return errorResponse(res, 'Failed to create staff member.', 500);
  }
});

// PUT /api/staff/:id
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, role, password, is_active, salary_type, fixed_salary, percentage_rate } = req.body;

    const existing = await queryMain(
      'SELECT id FROM staff WHERE id = $1 AND restaurant_id = $2',
      [id, req.user.restaurant_id]
    );

    if (existing.rows.length === 0) {
      return errorResponse(res, 'Staff member not found.', 404);
    }

    if (role) {
      const allowedRoles = [ROLES.ADMIN, ROLES.CASHIER, ROLES.CHEF, ROLES.WAITER, 'admin', 'kassir', 'oshpaz', 'ofitsiant', 'cashier', 'chef', 'waiter'];
      if (!allowedRoles.includes(role)) {
        return errorResponse(res, `Invalid role. Allowed: ${allowedRoles.join(', ')}`);
      }
    }

    let passwordHash = null;
    if (password) {
      if (password.length < 4) {
        return errorResponse(res, 'Password must be at least 4 characters long.');
      }
      const salt = await bcrypt.genSalt(10);
      passwordHash = await bcrypt.hash(password, salt);
    }

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (first_name !== undefined) {
      updates.push(`first_name = $${paramIndex++}`);
      params.push(first_name);
    }
    if (last_name !== undefined) {
      updates.push(`last_name = $${paramIndex++}`);
      params.push(last_name);
    }
    if (role) {
      updates.push(`role = $${paramIndex++}`);
      params.push(role);
    }
    if (passwordHash) {
      updates.push(`password_hash = $${paramIndex++}`);
      params.push(passwordHash);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      params.push(is_active);
    }
    if (salary_type !== undefined) {
      updates.push(`salary_type = $${paramIndex++}`);
      params.push(salary_type);
    }
    if (fixed_salary !== undefined) {
      updates.push(`fixed_salary = $${paramIndex++}`);
      params.push(fixed_salary);
    }
    if (percentage_rate !== undefined) {
      updates.push(`percentage_rate = $${paramIndex++}`);
      params.push(percentage_rate);
    }

    if (updates.length === 0) {
      return errorResponse(res, 'No changes provided.');
    }

    params.push(id, req.user.restaurant_id);
    const sql = `UPDATE staff SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND restaurant_id = $${paramIndex++} RETURNING id, telegram_id, username, first_name, last_name, role, salary_type, fixed_salary, percentage_rate, created_at, is_active`;

    const result = await queryMain(sql, params);

    const member = result.rows[0];
    member.telegram_id = member.telegram_id ? member.telegram_id.toString() : null;
    member.is_approved = true;

    if (member && member.username) {
      const uUpdates = [];
      const uParams = [];
      let uIdx = 1;
      if (first_name !== undefined) { uUpdates.push(`first_name = $${uIdx++}`); uParams.push(first_name); }
      if (last_name !== undefined) { uUpdates.push(`last_name = $${uIdx++}`); uParams.push(last_name); }
      if (role) { uUpdates.push(`role = $${uIdx++}`); uParams.push(role); }
      if (passwordHash) { uUpdates.push(`password_hash = $${uIdx++}`); uParams.push(passwordHash); }
      if (is_active !== undefined) { uUpdates.push(`is_active = $${uIdx++}`); uParams.push(is_active); }
      if (uUpdates.length > 0) {
        uParams.push(member.username);
        await queryMain(`UPDATE users SET ${uUpdates.join(', ')} WHERE username = $${uIdx++}`, uParams).catch(e => console.error('Update user sync error:', e));
      }
    }

    return successResponse(res, { staff: member });
  } catch (error) {
    console.error('Update staff error:', error);
    return errorResponse(res, 'Failed to update staff member.', 500);
  }
});

// DELETE /api/staff/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const staffRes = await queryMain('SELECT username FROM staff WHERE id = $1 AND restaurant_id = $2', [id, req.user.restaurant_id]);
    if (staffRes.rows.length === 0) {
      return errorResponse(res, 'Staff member not found.', 404);
    }
    const { username } = staffRes.rows[0];

    await queryMain('DELETE FROM staff WHERE id = $1 AND restaurant_id = $2', [id, req.user.restaurant_id]);
    await queryMain('UPDATE users SET is_active = FALSE WHERE username = $1', [username]).catch(e => console.error('Delete user sync error:', e));

    return successResponse(res, { message: 'Staff member deleted successfully.' });
  } catch (error) {
    console.error('Delete staff error:', error);
    return errorResponse(res, 'Failed to delete staff member.', 500);
  }
});

export default router;
