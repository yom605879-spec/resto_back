import express from 'express';
import jwt from 'jsonwebtoken';
import { queryLogs } from '../db/init.js';

const router = express.Router();

// Helper: Optional user extraction from JWT token
const getOptionalUser = (req) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      return jwt.verify(token, process.env.JWT_SECRET);
    }
  } catch (e) {
    // Ignore invalid/expired tokens for optional user identification
  }
  return null;
};

// GET /api/reviews - Get public reviews for a restaurant
router.get('/', async (req, res) => {
  try {
    const restId = parseInt(req.query.restaurant_id) || 1;
    const result = await queryLogs(
      `SELECT id, order_id, restaurant_id, customer_name, rating, comment, created_at 
       FROM order_reviews 
       WHERE restaurant_id = $1 OR restaurant_id IS NULL
       ORDER BY id DESC LIMIT 50`,
      [restId]
    );

    const reviews = result.rows;
    let avgRating = 5.0;
    if (reviews.length > 0) {
      const sum = reviews.reduce((acc, r) => acc + Number(r.rating || 5), 0);
      avgRating = Number((sum / reviews.length).toFixed(1));
    }

    res.json({
      success: true,
      reviews,
      stats: {
        total: reviews.length,
        average: avgRating
      }
    });
  } catch (err) {
    console.error('Error fetching reviews:', err);
    res.status(500).json({ success: false, error: 'Sharhlarni yuklashda xatolik yuz berdi' });
  }
});

// POST /api/reviews - Create a review
router.post('/', async (req, res) => {
  try {
    const user = getOptionalUser(req);
    const { order_id, rating, comment, customer_name } = req.body;
    const restId = user?.restaurant_id || 1;
    const name = customer_name || user?.first_name || user?.username || 'Mijoz';
    const rateVal = Math.min(5, Math.max(1, parseInt(rating) || 5));

    const result = await queryLogs(
      `INSERT INTO order_reviews (order_id, restaurant_id, customer_name, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [order_id || 0, restId, name, rateVal, comment || '']
    );

    res.status(201).json({
      success: true,
      review: result.rows[0]
    });
  } catch (err) {
    console.error('Error creating review:', err);
    res.status(500).json({ success: false, error: 'Sharh saqlashda xatolik yuz berdi' });
  }
});

export default router;
