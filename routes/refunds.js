import express from 'express';
import { queryLogs } from '../db/init.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const result = await queryLogs('SELECT * FROM refunds WHERE restaurant_id = $1 ORDER BY created_at DESC', [req.user.restaurant_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { order_id, amount, reason } = req.body;
    const result = await queryLogs(
      'INSERT INTO refunds (restaurant_id, order_id, amount, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.restaurant_id, order_id, amount, reason, req.user.id]
    );
    // Also update order status to refunded
    await queryLogs('UPDATE orders SET payment_status = $1 WHERE id = $2', ['refunded', order_id]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
