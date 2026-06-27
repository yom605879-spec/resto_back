import express from 'express';
import { queryMain } from '../db/init.js';

const router = express.Router();

// Get all customers (users with role 'mijoz')
router.get('/', async (req, res) => {
  try {
    const result = await queryMain(`
      SELECT id, first_name, last_name, username, email, is_active, created_at 
      FROM users 
      WHERE role = 'mijoz' 
      ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching customers:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update customer status (block/unblock)
router.put('/:id', async (req, res) => {
  try {
    const { is_active } = req.body;
    const { id } = req.params;

    const result = await queryMain(
      'UPDATE users SET is_active = $1 WHERE id = $2 AND role = $3 RETURNING id, first_name, is_active',
      [is_active, id, 'mijoz']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating customer:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
