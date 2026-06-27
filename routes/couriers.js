import express from 'express';
import { queryMain } from '../db/init.js';

const router = express.Router();

// Get all couriers
router.get('/', async (req, res) => {
  try {
    const result = await queryMain(`
      SELECT id, first_name, last_name, username, role, is_active 
      FROM staff 
      WHERE role = 'kuryer' 
      ORDER BY first_name ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching couriers:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
