import express from 'express';
import { queryMain, getClientMain } from '../db/init.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const result = await queryMain('SELECT * FROM inventory WHERE restaurant_id = $1 ORDER BY item_name ASC', [req.user.restaurant_id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { item_name, quantity, unit, min_threshold } = req.body;
    const result = await queryMain(
      'INSERT INTO inventory (restaurant_id, item_name, quantity, unit, min_threshold) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.restaurant_id, item_name, quantity, unit, min_threshold || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});
// Recipes (Menu Item Ingredients)
router.get('/recipes/:menu_item_id', async (req, res) => {
  try {
    const { menu_item_id } = req.params;
    const result = await queryMain(
      `SELECT r.id, r.inventory_id, r.quantity_required, i.item_name, i.unit
       FROM recipe_ingredients r
       JOIN inventory i ON r.inventory_id = i.id
       WHERE r.menu_item_id = $1 AND r.restaurant_id = $2`,
      [menu_item_id, req.user.restaurant_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/recipes/:menu_item_id', async (req, res) => {
  try {
    const { menu_item_id } = req.params;
    const { ingredients } = req.body; // array of { inventory_id, quantity_required }

    const client = await getClientMain();
    try {
      await client.query('BEGIN');
      
      await client.query(
        'DELETE FROM recipe_ingredients WHERE menu_item_id = $1 AND restaurant_id = $2',
        [menu_item_id, req.user.restaurant_id]
      );

      if (ingredients && ingredients.length > 0) {
        const values = [];
        const params = [];
        let paramIndex = 1;
        
        for (const item of ingredients) {
          values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
          params.push(req.user.restaurant_id, menu_item_id, item.inventory_id, item.quantity_required);
        }
        
        await client.query(
          `INSERT INTO recipe_ingredients (restaurant_id, menu_item_id, inventory_id, quantity_required)
           VALUES ${values.join(', ')}`,
          params
        );
      }
      
      await client.query('COMMIT');
      res.json({ success: true, message: 'Recipe saved successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Recipe save error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});
export default router;
