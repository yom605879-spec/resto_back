import express from 'express';
import { queryLogs } from '../db/init.js';

const router = express.Router();

// Get all messages
router.get('/', async (req, res) => {
  try {
    const result = await queryLogs('SELECT * FROM messages ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create new message (simulation)
router.post('/', async (req, res) => {
  try {
    const { phone_number, message, customer_id } = req.body;
    
    // Simulate SMS sending delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Always succeed in simulation
    const result = await queryLogs(
      'INSERT INTO messages (phone_number, message, customer_id, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [phone_number, message, customer_id || null, 'sent']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating message:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
