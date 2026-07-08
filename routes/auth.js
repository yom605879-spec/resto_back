import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { queryMain, seedDefaultMenu } from '../db/init.js';
import { successResponse, errorResponse, validateRequiredFields } from '../utils/helpers.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Roles config
const ROLE_LABELS = {
  boss: 'Boss (Egasi)',
  admin: 'Admin (Menejer)',
  kassir: 'Kassir',
  oshpaz: 'Oshpaz',
  ofitsiant: 'Ofitsiant',
  mijoz: 'Mijoz',
};

const STAFF_ROLES = ['admin', 'kassir', 'oshpaz', 'ofitsiant'];



// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const validationError = validateRequiredFields(req.body, ['username', 'password']);
    if (validationError) {
      return errorResponse(res, validationError);
    }

    const usernameLower = username.toLowerCase();

    const userResult = await queryMain(
      `SELECT id, username, password_hash, role, restaurant_id, is_approved
       FROM users WHERE username = $1 AND is_active = TRUE`,
      [usernameLower]
    );

    if (userResult.rows.length === 0) {
      return errorResponse(res, 'Username yoki parol noto\'g\'ri.', 401);
    }

    const user = userResult.rows[0];

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return errorResponse(res, 'Username yoki parol noto\'g\'ri.', 401);
    }

    // Tasdiqlash tekshiruvi
    if (!user.is_approved) {
      return errorResponse(res, 'Hisobingiz hali Boss tomonidan tasdiqlanmagan. Iltimos, kuting.', 403);
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        restaurant_id: user.restaurant_id,
        user_type: 'user',
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return successResponse(res, {
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        restaurant_id: user.restaurant_id,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return errorResponse(res, 'Server xatosi kirishda.', 500);
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await queryMain(
      `SELECT u.id, u.telegram_id, u.username, u.first_name, u.last_name, u.role,
              u.restaurant_id, u.created_at, u.is_approved, r.name as restaurant_name
       FROM users u
       LEFT JOIN restaurants r ON u.restaurant_id = r.id
       WHERE u.id = $1 AND u.is_active = TRUE`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Foydalanuvchi topilmadi.', 404);
    }

    const user = result.rows[0];
    user.telegram_id = user.telegram_id ? user.telegram_id.toString() : null;

    return successResponse(res, { user });
  } catch (error) {
    console.error('Get me error:', error);
    return errorResponse(res, 'Server xatosi.', 500);
  }
});

// GET /api/auth/all-users  (faqat boss ko'radi)
router.get('/all-users', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'boss' && req.user.role !== 'admin') {
      return errorResponse(res, 'Ruxsat yo\'q.', 403);
    }

    const result = await queryMain(
      `SELECT id, username, first_name, last_name, role, is_approved, is_active, created_at,
              telegram_id
       FROM users
       ORDER BY created_at DESC`
    );

    const users = result.rows.map(u => ({
      ...u,
      telegram_id: u.telegram_id ? u.telegram_id.toString() : null,
    }));

    return successResponse(res, { users });
  } catch (error) {
    console.error('All users error:', error);
    return errorResponse(res, 'Server xatosi.', 500);
  }
});

// GET /api/auth/pending  (boss uchun tasdiqlanmagan foydalanuvchilar)
router.get('/pending', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'boss' && req.user.role !== 'admin') {
      return errorResponse(res, 'Ruxsat yo\'q.', 403);
    }

    const result = await queryMain(
      `SELECT id, username, first_name, last_name, role, created_at, telegram_id
       FROM users
       WHERE is_approved = FALSE AND is_active = TRUE AND role != 'mijoz'
       ORDER BY created_at DESC`
    );

    const users = result.rows.map(u => ({
      ...u,
      telegram_id: u.telegram_id ? u.telegram_id.toString() : null,
    }));

    return successResponse(res, { users });
  } catch (error) {
    console.error('Pending users error:', error);
    return errorResponse(res, 'Server xatosi.', 500);
  }
});

// PUT /api/auth/approve/:id  (boss foydalanuvchini tasdiqlaydi)
router.put('/approve/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'boss' && req.user.role !== 'admin') {
      return errorResponse(res, 'Ruxsat yo\'q.', 403);
    }

    const { id } = req.params;
    const { restaurant_id } = req.body;

    // Bossman restoran_id ini ishlatamiz agar berilmagan bo'lsa
    const targetRestaurantId = restaurant_id || req.user.restaurant_id;

    const result = await queryMain(
      `UPDATE users SET is_approved = TRUE, restaurant_id = $1
       WHERE id = $2 AND is_approved = FALSE
       RETURNING id, telegram_id, username, first_name, last_name, password_hash, role, is_approved`,
      [targetRestaurantId, id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Foydalanuvchi topilmadi yoki allaqachon tasdiqlangan.', 404);
    }

    const approvedUser = result.rows[0];
    const staffRoles = ['admin', 'kassir', 'oshpaz', 'ofitsiant', 'cashier', 'chef', 'waiter'];

    if (staffRoles.includes(approvedUser.role)) {
      await queryMain(
        `INSERT INTO staff (telegram_id, username, first_name, last_name, password_hash, role, salary_type, fixed_salary, percentage_rate, restaurant_id, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, 'fixed', 0, 0, $7, TRUE)
         ON CONFLICT DO NOTHING`,
        [
          approvedUser.telegram_id || null,
          approvedUser.username,
          approvedUser.first_name || null,
          approvedUser.last_name || null,
          approvedUser.password_hash || null,
          approvedUser.role,
          targetRestaurantId
        ]
      ).catch(err => console.error('Error syncing approved user to staff table:', err));
    }

    return successResponse(res, { user: approvedUser });
  } catch (error) {
    console.error('Approve user error:', error);
    return errorResponse(res, 'Server xatosi.', 500);
  }
});

// DELETE /api/auth/reject/:id  (boss foydalanuvchini rad etadi)
router.delete('/reject/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'boss' && req.user.role !== 'admin') {
      return errorResponse(res, 'Ruxsat yo\'q.', 403);
    }

    const { id } = req.params;

    await queryMain(
      `UPDATE users SET is_active = FALSE WHERE id = $1 AND is_approved = FALSE`,
      [id]
    );

    return successResponse(res, { message: 'Foydalanuvchi rad etildi.' });
  } catch (error) {
    console.error('Reject user error:', error);
    return errorResponse(res, 'Server xatosi.', 500);
  }
});

// POST /api/auth/google  — Google orqali kirish / ro'yxatdan o'tish
router.post('/google', async (req, res) => {
  try {
    const { google_uid, email, display_name, photo_url } = req.body;

    if (!google_uid || !email) {
      return errorResponse(res, 'Google ma\'lumotlari to\'liq emas.', 400);
    }

    // Ism va familiyani ajratish
    const nameParts = (display_name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // Mavjud foydalanuvchini topish (google_uid yoki email orqali)
    const existingResult = await queryMain(
      `SELECT id, username, role, restaurant_id, is_approved, is_active
       FROM users WHERE google_uid = $1 OR email = $2 LIMIT 1`,
      [google_uid, email]
    );

    if (existingResult.rows.length > 0) {
      const user = existingResult.rows[0];

      if (!user.is_active) {
        return errorResponse(res, 'Hisobingiz o\'chirilgan.', 403);
      }

      // google_uid ni yangilash (agar email orqali topilgan bo'lsa)
      await queryMain(
        `UPDATE users SET google_uid = $1, email = $2 WHERE id = $3`,
        [google_uid, email, user.id]
      );

      if (!user.is_approved) {
        return errorResponse(res, 'Hisobingiz hali Boss tomonidan tasdiqlanmagan. Iltimos, kuting.', 403);
      }

      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, restaurant_id: user.restaurant_id, user_type: 'user' },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
      );

      return successResponse(res, {
        isNew: false,
        token,
        user: { id: user.id, username: user.username, role: user.role, restaurant_id: user.restaurant_id },
      });
    }

    // Yangi foydalanuvchi — rol tanlash uchun ma'lumotlarni qaytaramiz
    return successResponse(res, {
      isNew: true,
      google_uid,
      email,
      first_name: firstName,
      last_name: lastName,
      photo_url: photo_url || null,
    });
  } catch (error) {
    console.error('Google auth error:', error);
    return errorResponse(res, 'Server xatosi.', 500);
  }
});

// POST /api/auth/google-register  — Google foydalanuvchini rol bilan ro'yxatga olish
router.post('/google-register', async (req, res) => {
  try {
    const { google_uid, email, username, first_name, last_name, role, password } = req.body;

    if (!google_uid || !email || !username || !role) {
      return errorResponse(res, 'Majburiy maydonlar to\'ldirilmagan.', 400);
    }

    if (username.length < 3 || username.length > 50) {
      return errorResponse(res, 'Username 3-50 belgi oralig\'ida bo\'lishi kerak.');
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return errorResponse(res, 'Username faqat harf, raqam va _ dan iborat bo\'lishi kerak.');
    }

    const allowedRoles = ['boss', 'admin', 'kassir', 'oshpaz', 'ofitsiant', 'mijoz'];
    if (!allowedRoles.includes(role)) {
      return errorResponse(res, 'Noto\'g\'ri rol.', 400);
    }

    // Username va google_uid mavjudligini tekshirish
    const existing = await queryMain(
      'SELECT id FROM users WHERE google_uid = $1 OR username = $2 OR email = $3',
      [google_uid, username.toLowerCase(), email]
    );
    if (existing.rows.length > 0) {
      return errorResponse(res, 'Bu Google akkaunt yoki username allaqachon ro\'yxatdan o\'tgan.');
    }

    const isApproved = role === 'boss' || role === 'mijoz';

    // Parolni hash qilish (ixtiyoriy — Google foydalanuvchilar uchun)
    let passwordHash = null;
    if (password && password.length >= 4) {
      const salt = await bcrypt.genSalt(10);
      passwordHash = await bcrypt.hash(password, salt);
    }

    const userResult = await queryMain(
      `INSERT INTO users (google_uid, email, username, first_name, last_name, password_hash, role, is_approved)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, username, role, is_approved`,
      [google_uid, email, username.toLowerCase(), first_name || '', last_name || '', passwordHash, role, isApproved]
    );

    const user = userResult.rows[0];
    let restaurantId = null;

    if (role === 'boss') {
      const restaurantResult = await queryMain(
        `INSERT INTO restaurants (name, owner_id) VALUES ($1, $2) RETURNING id`,
        [`${first_name || username}'ning Restoran`, user.id]
      );
      restaurantId = restaurantResult.rows[0].id;
      await queryMain('UPDATE users SET restaurant_id = $1 WHERE id = $2', [restaurantId, user.id]);
      await seedDefaultMenu(restaurantId);
    }

    if (!isApproved) {
      return successResponse(res, {
        pending: true,
        message: 'Hisobingiz yaratildi. Boss tasdig\'ini kuting.',
        user: { username: user.username, role: user.role },
      }, 201);
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, restaurant_id: restaurantId, user_type: 'user' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return successResponse(res, {
      pending: false,
      token,
      user: { id: user.id, username: user.username, role: user.role, restaurant_id: restaurantId },
    }, 201);
  } catch (error) {
    console.error('Google register error:', error);
    if (error.code === '23505') {
      return errorResponse(res, 'Username yoki Email allaqachon mavjud.');
    }
    return errorResponse(res, 'Server xatosi.', 500);
  }
});

// GET /api/auth/branches - Boss uchun unga tegishli restoranlar
router.get('/branches', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'boss' && req.user.role !== 'admin') {
      return errorResponse(res, 'Ruxsat yo\'q.', 403);
    }
    const result = await queryMain(
      `SELECT id, name, created_at, is_active FROM restaurants WHERE owner_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    return successResponse(res, { branches: result.rows });
  } catch (error) {
    console.error('Get branches error:', error);
    return errorResponse(res, 'Server xatosi.', 500);
  }
});

// POST /api/auth/branches - Yangi filial qo'shish
router.post('/branches', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'boss' && req.user.role !== 'admin') {
      return errorResponse(res, 'Ruxsat yo\'q.', 403);
    }
    const { name } = req.body;
    if (!name) return errorResponse(res, 'Restoran nomi kerak.');

    const result = await queryMain(
      `INSERT INTO restaurants (name, owner_id) VALUES ($1, $2) RETURNING id, name, created_at, is_active`,
      [name, req.user.id]
    );
    await seedDefaultMenu(result.rows[0].id);
    return successResponse(res, { branch: result.rows[0] });
  } catch (error) {
    console.error('Add branch error:', error);
    return errorResponse(res, 'Server xatosi.', 500);
  }
});

// PUT /api/auth/settings - Profilni yangilash
router.put('/settings', authenticate, async (req, res) => {
  try {
    const { username, first_name, last_name, email } = req.body;
    const result = await queryMain(
      `UPDATE users 
       SET username = COALESCE($1, username),
           first_name = COALESCE($2, first_name),
           last_name = COALESCE($3, last_name),
           email = COALESCE($4, email)
       WHERE id = $5 RETURNING id, username, first_name, last_name, email`,
      [username, first_name, last_name, email, req.user.id]
    );
    return successResponse(res, { user: result.rows[0] });
  } catch (error) {
    console.error('Update settings error:', error);
    if (error.code === '23505') {
      return errorResponse(res, 'Username yoki Email allaqachon mavjud.');
    }
    return errorResponse(res, 'Server xatosi.', 500);
  }
});

export default router;
