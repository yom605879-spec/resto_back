import express from 'express';
import { queryMain } from '../db/init.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// ── Helpers ────────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10); // "2026-07-11"

// ── GET /api/attendance ─────────────────────────────────────────────────────
// Filters: ?date=YYYY-MM-DD  ?month=YYYY-MM  ?staff_id=N
router.get('/', authenticate, async (req, res) => {
  try {
    const restId = req.user.restaurant_id;
    const { date, month, staff_id } = req.query;

    let conditions = ['a.restaurant_id = $1'];
    let params = [restId];
    let pi = 2;

    if (date) {
      conditions.push(`a.work_date = $${pi++}`);
      params.push(date);
    } else if (month) {
      conditions.push(`TO_CHAR(a.work_date, 'YYYY-MM') = $${pi++}`);
      params.push(month);
    } else {
      // default: today
      conditions.push(`a.work_date = $${pi++}`);
      params.push(todayStr());
    }

    if (staff_id) {
      conditions.push(`a.staff_id = $${pi++}`);
      params.push(staff_id);
    }

    const sql = `
      SELECT 
        a.*,
        s.first_name, s.last_name, s.role,
        s.username
      FROM attendance a
      JOIN staff s ON s.id = a.staff_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.work_date DESC, s.first_name
    `;

    const result = await queryMain(sql, params);
    res.json({ success: true, attendance: result.rows });
  } catch (err) {
    console.error('GET /api/attendance error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/attendance ─────────────────────────────────────────────────────
// Body: { staff_id, status, work_date?, check_in?, check_out?, notes? }
router.post('/', authenticate, authorize('boss', 'admin'), async (req, res) => {
  try {
    const restId = req.user.restaurant_id;
    const { staff_id, status = 'present', work_date, check_in, check_out, notes } = req.body;

    if (!staff_id) return res.status(400).json({ success: false, error: 'staff_id majburiy' });

    const date = work_date || todayStr();

    // Upsert — replace if already exists for that staff on that date
    const result = await queryMain(
      `INSERT INTO attendance (restaurant_id, staff_id, status, work_date, check_in, check_out, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (restaurant_id, staff_id, work_date)
       DO UPDATE SET
         status     = EXCLUDED.status,
         check_in   = EXCLUDED.check_in,
         check_out  = EXCLUDED.check_out,
         notes      = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [restId, staff_id, status, date, check_in || null, check_out || null, notes || '']
    );

    res.status(201).json({ success: true, record: result.rows[0] });
  } catch (err) {
    console.error('POST /api/attendance error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/attendance/:id ─────────────────────────────────────────────────
router.put('/:id', authenticate, authorize('boss', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, check_in, check_out, notes } = req.body;

    const result = await queryMain(
      `UPDATE attendance
       SET status = COALESCE($1, status),
           check_in = COALESCE($2, check_in),
           check_out = COALESCE($3, check_out),
           notes = COALESCE($4, notes),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [status, check_in || null, check_out || null, notes, id]
    );

    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Yozuv topilmadi' });
    res.json({ success: true, record: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/attendance error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/attendance/summary ─────────────────────────────────────────────
// ?month=YYYY-MM  — per-staff monthly summary
router.get('/summary', authenticate, authorize('boss', 'admin'), async (req, res) => {
  try {
    const restId = req.user.restaurant_id;
    const month = req.query.month || new Date().toISOString().slice(0, 7);

    const result = await queryMain(
      `SELECT
         s.id          AS staff_id,
         s.first_name, s.last_name, s.role,
         COUNT(*)      FILTER (WHERE a.status = 'present')  AS present_days,
         COUNT(*)      FILTER (WHERE a.status = 'absent')   AS absent_days,
         COUNT(*)      FILTER (WHERE a.status = 'late')     AS late_days,
         COUNT(*)      FILTER (WHERE a.status = 'leave')    AS leave_days,
         COUNT(a.id)                                         AS total_marked
       FROM staff s
       LEFT JOIN attendance a
              ON a.staff_id = s.id
             AND a.restaurant_id = $1
             AND TO_CHAR(a.work_date, 'YYYY-MM') = $2
       WHERE s.restaurant_id = $1 AND s.is_active = TRUE
       GROUP BY s.id, s.first_name, s.last_name, s.role
       ORDER BY s.first_name`,
      [restId, month]
    );

    res.json({ success: true, summary: result.rows, month });
  } catch (err) {
    console.error('GET /api/attendance/summary error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
