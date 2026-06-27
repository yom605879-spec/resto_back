import express from 'express';
import { queryMain } from '../db/init.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const result = await queryMain('SELECT * FROM discounts WHERE restaurant_id = $1 ORDER BY created_at DESC', [req.user.restaurant_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { code, discount_type, value } = req.body;
    const result = await queryMain(
      'INSERT INTO discounts (restaurant_id, code, discount_type, value) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.restaurant_id, code, discount_type, value]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
