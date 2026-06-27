import express from 'express';
import { queryLogs } from '../db/init.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const result = await queryLogs(`
      SELECT t.*, s.first_name, s.last_name 
      FROM tasks t 
      LEFT JOIN staff s ON t.assigned_to = s.id
      WHERE t.restaurant_id = $1 
      ORDER BY t.created_at DESC
    `, [req.user.restaurant_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { title, description, assigned_to } = req.body;
    const result = await queryLogs(
      'INSERT INTO tasks (restaurant_id, title, description, assigned_to) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.restaurant_id, title, description, assigned_to || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const result = await queryLogs('UPDATE tasks SET status = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING *', [status, req.params.id, req.user.restaurant_id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
