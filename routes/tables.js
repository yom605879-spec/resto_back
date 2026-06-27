import express from 'express';
import { queryMain } from '../db/init.js';

const router = express.Router();

// Get all tables
router.get('/', async (req, res) => {
  try {
    const result = await queryMain('SELECT * FROM tables ORDER BY table_number ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching tables:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update table status
router.put('/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;
    
    if (!['available', 'occupied', 'reserved'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const result = await queryMain(
      'UPDATE tables SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Table not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating table:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create new table
router.post('/', async (req, res) => {
  try {
    const { table_number, capacity } = req.body;
    const result = await queryMain(
      'INSERT INTO tables (table_number, capacity) VALUES ($1, $2) RETURNING *',
      [table_number, capacity || 4]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating table:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete table
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await queryMain('DELETE FROM tables WHERE id = $1', [id]);
    res.json({ message: 'Table deleted successfully' });
  } catch (err) {
    console.error('Error deleting table:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;
