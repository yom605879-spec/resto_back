import { Router } from 'express';
import { queryMedia } from '../db/init.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { successResponse, errorResponse, validateRequiredFields, ROLES } from '../utils/helpers.js';

const router = Router();

// GET /api/menu/public/:restaurant_id
router.get('/public/:restaurant_id', async (req, res) => {
  try {
    const { restaurant_id } = req.params;

    const categoriesResult = await queryMedia(
      `SELECT id, name, sort_order, is_active
       FROM menu_categories
       WHERE restaurant_id = $1 AND is_active = TRUE
       ORDER BY sort_order ASC, name ASC`,
      [restaurant_id]
    );

    const itemsResult = await queryMedia(
      `SELECT id, category_id, name, description, price, image_url, is_available as available, created_at
       FROM menu_items
       WHERE restaurant_id = $1 AND is_available = TRUE`,
      [restaurant_id]
    );

    const categories = categoriesResult.rows.map(cat => ({
      ...cat,
      items: itemsResult.rows.filter(item => item.category_id === cat.id)
    }));

    return successResponse(res, { categories });
  } catch (error) {
    console.error('Get public menu error:', error);
    return errorResponse(res, 'Failed to fetch public menu.', 500);
  }
});

// All menu routes require authentication
router.use(authenticate);

// ==================== CATEGORIES ====================

// GET /api/menu/categories
router.get('/categories', async (req, res) => {
  try {
    const categoriesResult = await queryMedia(
      `SELECT id, name, sort_order, is_active
       FROM menu_categories
       WHERE restaurant_id = $1
       ORDER BY sort_order ASC, name ASC`,
      [req.user.restaurant_id]
    );

    const itemsResult = await queryMedia(
      `SELECT id, category_id, name, description, price, image_url, is_available as available, created_at
       FROM menu_items
       WHERE restaurant_id = $1`,
      [req.user.restaurant_id]
    );

    const categories = categoriesResult.rows.map(cat => ({
      ...cat,
      items: itemsResult.rows.filter(item => item.category_id === cat.id)
    }));

    return successResponse(res, { categories });
  } catch (error) {
    console.error('Get categories error:', error);
    return errorResponse(res, 'Failed to fetch categories.', 500);
  }
});

// POST /api/menu/categories
router.post('/categories', authorize(ROLES.BOSS, ROLES.ADMIN), async (req, res) => {
  try {
    const { name, sort_order } = req.body;

    const validationError = validateRequiredFields(req.body, ['name']);
    if (validationError) {
      return errorResponse(res, validationError);
    }

    const result = await queryMedia(
      `INSERT INTO menu_categories (restaurant_id, name, sort_order)
       VALUES ($1, $2, $3)
       RETURNING id, name, sort_order, is_active`,
      [req.user.restaurant_id, name.trim(), sort_order || 0]
    );

    return successResponse(res, { category: result.rows[0] }, 201);
  } catch (error) {
    console.error('Create category error:', error);
    return errorResponse(res, 'Failed to create category.', 500);
  }
});

// PUT /api/menu/categories/:id
router.put('/categories/:id', authorize(ROLES.BOSS, ROLES.ADMIN), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, sort_order, is_active } = req.body;

    const existing = await queryMedia(
      'SELECT id FROM menu_categories WHERE id = $1 AND restaurant_id = $2',
      [id, req.user.restaurant_id]
    );

    if (existing.rows.length === 0) {
      return errorResponse(res, 'Category not found.', 404);
    }

    const result = await queryMedia(
      `UPDATE menu_categories
       SET name = COALESCE($1, name),
           sort_order = COALESCE($2, sort_order),
           is_active = COALESCE($3, is_active)
       WHERE id = $4 AND restaurant_id = $5
       RETURNING id, name, sort_order, is_active`,
      [name || null, sort_order !== undefined ? sort_order : null, is_active !== undefined ? is_active : null, id, req.user.restaurant_id]
    );

    return successResponse(res, { category: result.rows[0] });
  } catch (error) {
    console.error('Update category error:', error);
    return errorResponse(res, 'Failed to update category.', 500);
  }
});

// DELETE /api/menu/categories/:id
router.delete('/categories/:id', authorize(ROLES.BOSS, ROLES.ADMIN), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await queryMedia(
      'DELETE FROM menu_categories WHERE id = $1 AND restaurant_id = $2 RETURNING id',
      [id, req.user.restaurant_id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Category not found.', 404);
    }

    return successResponse(res, { message: 'Category deleted successfully.' });
  } catch (error) {
    console.error('Delete category error:', error);
    return errorResponse(res, 'Failed to delete category.', 500);
  }
});

// ==================== MENU ITEMS ====================

// GET /api/menu/items
router.get('/items', async (req, res) => {
  try {
    const { category_id } = req.query;
    let sql = `
      SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price,
             mi.is_available, mi.created_at, mc.name as category_name
      FROM menu_items mi
      LEFT JOIN menu_categories mc ON mi.category_id = mc.id
      WHERE mi.restaurant_id = $1
    `;
    const params = [req.user.restaurant_id];

    if (category_id) {
      sql += ' AND mi.category_id = $2';
      params.push(category_id);
    }

    sql += ' ORDER BY mc.sort_order ASC, mi.name ASC';

    const result = await queryMedia(sql, params);

    return successResponse(res, { items: result.rows });
  } catch (error) {
    console.error('Get items error:', error);
    return errorResponse(res, 'Failed to fetch menu items.', 500);
  }
});

// POST /api/menu/items
router.post('/items', authorize(ROLES.BOSS, ROLES.ADMIN), async (req, res) => {
  try {
    const { category_id, name, description, price, image_base64 } = req.body;

    const validationError = validateRequiredFields(req.body, ['category_id', 'name', 'price']);
    if (validationError) {
      return errorResponse(res, validationError);
    }

    if (parseFloat(price) < 0) {
      return errorResponse(res, 'Price must be a positive number.');
    }

    const categoryCheck = await queryMedia(
      'SELECT id FROM menu_categories WHERE id = $1 AND restaurant_id = $2',
      [category_id, req.user.restaurant_id]
    );

    if (categoryCheck.rows.length === 0) {
      return errorResponse(res, 'Category not found.', 404);
    }

    let imageUrl = null;
    if (image_base64) {
      const mediaResult = await queryMedia(
        `INSERT INTO media_files (restaurant_id, related_type, image_data) VALUES ($1, $2, $3) RETURNING id`,
        [req.user.restaurant_id, 'menu_item', image_base64]
      );
      imageUrl = `/api/menu/media/${mediaResult.rows[0].id}`;
    }

    const result = await queryMedia(
      `INSERT INTO menu_items (category_id, restaurant_id, name, description, price, image_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, category_id, name, description, price, image_url, is_available, created_at`,
      [category_id, req.user.restaurant_id, name.trim(), description || null, price, imageUrl]
    );

    return successResponse(res, { item: result.rows[0] }, 201);
  } catch (error) {
    console.error('Create item error:', error);
    return errorResponse(res, 'Failed to create menu item.', 500);
  }
});

// PUT /api/menu/items/:id
router.put('/items/:id', authorize(ROLES.BOSS, ROLES.ADMIN), async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id, name, description, price, is_available } = req.body;

    const existing = await queryMedia(
      'SELECT id FROM menu_items WHERE id = $1 AND restaurant_id = $2',
      [id, req.user.restaurant_id]
    );

    if (existing.rows.length === 0) {
      return errorResponse(res, 'Menu item not found.', 404);
    }

    if (category_id) {
      const categoryCheck = await queryMedia(
        'SELECT id FROM menu_categories WHERE id = $1 AND restaurant_id = $2',
        [category_id, req.user.restaurant_id]
      );
      if (categoryCheck.rows.length === 0) {
        return errorResponse(res, 'Category not found.', 404);
      }
    }

    const result = await queryMedia(
      `UPDATE menu_items
       SET category_id = COALESCE($1, category_id),
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           price = COALESCE($4, price),
           is_available = COALESCE($5, is_available)
       WHERE id = $6 AND restaurant_id = $7
       RETURNING id, category_id, name, description, price, is_available, created_at`,
      [
        category_id || null,
        name || null,
        description !== undefined ? description : null,
        price !== undefined ? price : null,
        is_available !== undefined ? is_available : null,
        id,
        req.user.restaurant_id,
      ]
    );

    return successResponse(res, { item: result.rows[0] });
  } catch (error) {
    console.error('Update item error:', error);
    return errorResponse(res, 'Failed to update menu item.', 500);
  }
});

// DELETE /api/menu/items/:id
router.delete('/items/:id', authorize(ROLES.BOSS, ROLES.ADMIN), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await queryMedia(
      'DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2 RETURNING id',
      [id, req.user.restaurant_id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Menu item not found.', 404);
    }

    return successResponse(res, { message: 'Menu item deleted.' });
  } catch (error) {
    console.error('Delete item error:', error);
    return errorResponse(res, 'Failed to delete menu item.', 500);
  }
});

// GET /api/menu/media/:id
router.get('/media/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const mediaResult = await queryMedia(
      `SELECT image_data FROM media_files WHERE id = $1`,
      [id]
    );

    if (mediaResult.rows.length === 0) {
      return res.status(404).send('Image not found');
    }

    const base64Data = mediaResult.rows[0].image_data;
    
    // Extracted from Data URL, e.g. "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
    const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).send('Invalid image data');
    }

    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');

    res.set('Content-Type', mimeType);
    return res.send(buffer);
  } catch (error) {
    console.error('Get media error:', error);
    return res.status(500).send('Failed to fetch media.');
  }
});

export default router;
