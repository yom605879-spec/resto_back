import express from 'express';
import { queryLogs } from '../db/init.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const result = await queryLogs(`
      SELECT s.*, st.first_name, st.last_name, st.role 
      FROM schedule s 
      JOIN staff st ON s.staff_id = st.id
      WHERE s.restaurant_id = $1 
      ORDER BY s.shift_date DESC, s.start_time ASC
    `, [req.user.restaurant_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { staff_id, shift_date, start_time, end_time, role_shift } = req.body;
    const result = await queryLogs(
      'INSERT INTO schedule (restaurant_id, staff_id, shift_date, start_time, end_time, role_shift) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.user.restaurant_id, staff_id, shift_date, start_time, end_time, role_shift || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
