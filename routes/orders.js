import { Router } from 'express';
import { queryMain, getClientMain, queryLogs, queryMedia } from '../db/init.js';
import { authenticate, authorize } from '../middleware/auth.js';
import {
  successResponse,
  errorResponse,
  validateRequiredFields,
  ROLES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  ORDER_TYPES,
  parsePaginationParams,
} from '../utils/helpers.js';

const router = Router();

// ==================== PUBLIC CUSTOMER ROUTES ====================

// GET /api/orders/public/track/:order_id
router.get('/public/track/:order_id', async (req, res) => {
  try {
    const { order_id } = req.params;

    const orderResult = await queryMain(
      `SELECT o.id, o.restaurant_id, o.customer_name, o.customer_phone, o.table_number,
              o.order_type, o.status, o.total_amount, o.payment_method,
              o.payment_status, o.notes, o.created_at, o.updated_at, r.name as restaurant_name
       FROM orders o
       LEFT JOIN restaurants r ON o.restaurant_id = r.id
       WHERE o.id = $1`,
      [order_id]
    );

    if (orderResult.rows.length === 0) {
      return errorResponse(res, 'Order not found.', 404);
    }

    const itemsResult = await queryMain(
      `SELECT oi.id, oi.menu_item_id, oi.item_name, oi.quantity, oi.price, oi.total
       FROM order_items oi
       WHERE oi.order_id = $1
       ORDER BY oi.id ASC`,
      [order_id]
    );

    const reviewResult = await queryLogs(
      `SELECT rating, comment, created_at FROM order_reviews WHERE order_id = $1`,
      [order_id]
    );

    const order = orderResult.rows[0];
    order.items = itemsResult.rows;
    order.review = reviewResult.rows.length > 0 ? reviewResult.rows[0] : null;

    return successResponse(res, { order });
  } catch (error) {
    console.error('Public track order error:', error);
    return errorResponse(res, 'Failed to fetch order details.', 500);
  }
});

// POST /api/orders/public/track/:order_id/review
router.post('/public/track/:order_id/review', async (req, res) => {
  try {
    const { order_id } = req.params;
    const { rating, comment } = req.body;

    const validationError = validateRequiredFields(req.body, ['rating']);
    if (validationError) {
      return errorResponse(res, validationError);
    }

    const ratingInt = parseInt(rating);
    if (isNaN(ratingInt) || ratingInt < 1 || ratingInt > 5) {
      return errorResponse(res, 'Rating must be an integer between 1 and 5.');
    }

    const orderResult = await queryMain(
      'SELECT id, status FROM orders WHERE id = $1',
      [order_id]
    );

    if (orderResult.rows.length === 0) {
      return errorResponse(res, 'Order not found.', 404);
    }

    const order = orderResult.rows[0];
    if (!['served', 'completed'].includes(order.status)) {
      return errorResponse(res, 'Reviews can only be submitted for served or completed orders.');
    }

    const result = await queryLogs(
      `INSERT INTO order_reviews (order_id, rating, comment)
       VALUES ($1, $2, $3)
       ON CONFLICT (order_id)
       DO UPDATE SET rating = $2, comment = $3, created_at = NOW()
       RETURNING id, order_id, rating, comment, created_at`,
      [order_id, ratingInt, comment ? comment.trim() : null]
    );

    return successResponse(res, { review: result.rows[0] }, 201);
  } catch (error) {
    console.error('Submit review error:', error);
    return errorResponse(res, 'Failed to submit review.', 500);
  }
});

// POST /api/orders/public/:restaurant_id
router.post('/public/:restaurant_id', async (req, res) => {
  const client = await getClientMain();
  const { restaurant_id } = req.params;

  try {
    const { customer_name, customer_phone, table_number, order_type, payment_method, notes, note, items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      client.release();
      return errorResponse(res, 'Order must contain at least one item.');
    }

    const oType = order_type || 'dine_in';
    if (!ORDER_TYPES.includes(oType)) {
      client.release();
      return errorResponse(res, `Invalid order type. Allowed: ${ORDER_TYPES.join(', ')}`);
    }

    const restaurantCheck = await client.query(
      'SELECT id, name FROM restaurants WHERE id = $1 AND is_active = TRUE',
      [restaurant_id]
    );

    if (restaurantCheck.rows.length === 0) {
      client.release();
      return errorResponse(res, 'Restaurant not found.', 404);
    }

    await client.query('BEGIN');

    let totalAmount = 0;
    const orderItems = [];

    for (const item of items) {
      const menuItemId = item.menu_item_id || item.menu_item;
      const qty = parseInt(item.quantity);

      if (!menuItemId || isNaN(qty) || qty < 1) {
        await client.query('ROLLBACK');
        client.release();
        return errorResponse(res, 'Each item must have menu_item_id/menu_item and valid quantity (>= 1).');
      }

      const menuItem = await queryMedia(
        'SELECT id, name, price FROM menu_items WHERE id = $1 AND restaurant_id = $2 AND is_available = TRUE',
        [menuItemId, restaurant_id]
      );

      if (menuItem.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return errorResponse(res, `Menu item with ID ${menuItemId} not found or unavailable.`);
      }

      const menuData = menuItem.rows[0];
      const itemTotal = parseFloat(menuData.price) * qty;
      totalAmount += itemTotal;

      orderItems.push({
        menu_item_id: menuData.id,
        item_name: menuData.name,
        quantity: qty,
        price: parseFloat(menuData.price),
        total: itemTotal,
      });
    }

    const orderNotes = notes || note || null;

    const orderResult = await client.query(
      `INSERT INTO orders (restaurant_id, customer_name, customer_phone, table_number,
                           order_type, total_amount, payment_method, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, customer_name, customer_phone, table_number, order_type, status,
                 total_amount, payment_method, payment_status, notes, created_at`,
      [
        restaurant_id,
        customer_name ? customer_name.trim() : 'Mehmon',
        customer_phone || null,
        table_number ? parseInt(table_number) : null,
        oType,
        totalAmount,
        payment_method || null,
        orderNotes,
      ]
    );

    const order = orderResult.rows[0];

    for (const orderItem of orderItems) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price, total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, orderItem.menu_item_id, orderItem.item_name, orderItem.quantity, orderItem.price, orderItem.total]
      );
    }

    await client.query('COMMIT');
    client.release();

    order.items = orderItems.map(item => ({ ...item, status: 'pending' }));

    if (req.io) {
      req.io.emit(`new_order_${restaurant_id}`, order);
    }

    // Send Telegram Notification
    try {
      const { sendNotificationToRestaurant } = await import('../bot/telegram.js');
      const formattedTotal = new Intl.NumberFormat('uz-UZ').format(totalAmount);
      const orderItemsText = orderItems.map(item => `- ${item.item_name} x ${item.quantity}`).join('\n');
      const tableText = order.table_number ? `Stol: ${order.table_number}` : (order.order_type === 'takeaway' ? 'Olib ketish' : 'Yetkazib berish');
      const noteText = order.notes ? `\n\n📝 Izoh: ${order.notes}` : '';
      const notificationMessage = `🔔 <b>YANGI BUYURTMA (Mehmon)!</b>\n\n<b>Buyurtma ID:</b> #${order.id}\n<b>Mijoz:</b> ${order.customer_name}\n<b>Telefon:</b> ${order.customer_phone || '-'}\n<b>Xizmat turi:</b> ${tableText}\n<b>Jami:</b> ${formattedTotal} UZS\n\n<b>Mahsulotlar:</b>\n${orderItemsText}${noteText}\n\n<i>Iltimos, qabul qilish uchun tizimga kiring.</i>`;
      
      sendNotificationToRestaurant(restaurant_id, notificationMessage).catch(console.error);
    } catch (err) {
      console.error('Failed to trigger order notification:', err.message);
    }

    return successResponse(res, { order }, 201);
  } catch (error) {
    await client.query('ROLLBACK');
    client.release();
    console.error('Public create order error:', error);
    return errorResponse(res, 'Failed to place order.', 500);
  }
});

// All routes below require authentication
router.use(authenticate);

// GET /api/orders
router.get('/', async (req, res) => {
  try {
    const { status, order_type, date, payment_status } = req.query;
    const { limit, offset, page } = parsePaginationParams(req.query);

    let sql = `
      SELECT o.id, o.customer_name, o.customer_phone, o.table_number, o.courier_id,
             o.order_type, o.status, o.total_amount, o.payment_method,
             o.payment_status, o.notes, o.created_at, o.updated_at
      FROM orders o
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (req.user.role === 'mijoz') {
      const customerName = req.user.first_name || req.user.username || 'Mijoz';
      const userId = req.user.id || 0;
      const restId = req.user.restaurant_id || 1;
      if (req.user.phone) {
        sql += ` AND (o.user_id = $${paramIndex} OR o.customer_phone = $${paramIndex + 1} OR o.customer_name ILIKE $${paramIndex + 2} OR (o.customer_name = 'Mijoz' AND o.restaurant_id = $${paramIndex + 3}))`;
        params.push(userId, req.user.phone, customerName, restId);
        paramIndex += 4;
      } else {
        sql += ` AND (o.user_id = $${paramIndex} OR o.customer_name ILIKE $${paramIndex + 1} OR (o.customer_name = 'Mijoz' AND o.restaurant_id = $${paramIndex + 2}))`;
        params.push(userId, customerName, restId);
        paramIndex += 3;
      }
    } else {
      sql += ` AND o.restaurant_id = $${paramIndex}`;
      params.push(req.user.restaurant_id);
      paramIndex++;
    }

    if (status) {
      sql += ` AND o.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (order_type) {
      sql += ` AND o.order_type = $${paramIndex}`;
      params.push(order_type);
      paramIndex++;
    }

    if (payment_status) {
      sql += ` AND o.payment_status = $${paramIndex}`;
      params.push(payment_status);
      paramIndex++;
    }

    if (date) {
      sql += ` AND DATE(o.created_at) = $${paramIndex}`;
      params.push(date);
      paramIndex++;
    }

    const countResult = await queryMain(
      sql.replace(/SELECT [\s\S]*? FROM/i, 'SELECT COUNT(*) as total FROM'),
      params
    );
    const total = parseInt(countResult.rows[0].total);

    sql += ` ORDER BY o.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await queryMain(sql, params);
    const ordersList = result.rows;

    if (ordersList.length > 0) {
      const orderIds = ordersList.map((o) => o.id);
      const itemsResult = await queryMain(
        `SELECT order_id, menu_item_id, item_name, quantity, price, total
         FROM order_items
         WHERE order_id = ANY($1::int[])`,
        [orderIds]
      );
      const itemsByOrder = {};
      for (const item of itemsResult.rows) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }
      for (const o of ordersList) {
        o.items = itemsByOrder[o.id] || [];
      }
    }

    return successResponse(res, {
      orders: ordersList,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get orders error:', error);
    return errorResponse(res, 'Failed to fetch orders.', 500);
  }
});

// GET /api/orders/:id
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await queryMain(
      `SELECT o.id, o.customer_name, o.customer_phone, o.table_number,
              o.order_type, o.status, o.total_amount, o.payment_method,
              o.payment_status, o.notes, o.created_at, o.updated_at
       FROM orders o
       WHERE o.id = $1 AND o.restaurant_id = $2`,
      [id, req.user.restaurant_id]
    );

    if (orderResult.rows.length === 0) {
      return errorResponse(res, 'Order not found.', 404);
    }

    const itemsResult = await queryMain(
      `SELECT oi.id, oi.menu_item_id, oi.item_name, oi.quantity, oi.price, oi.total
       FROM order_items oi
       WHERE oi.order_id = $1
       ORDER BY oi.id ASC`,
      [id]
    );

    const reviewResult = await queryLogs(
      `SELECT rating, comment, created_at FROM order_reviews WHERE order_id = $1`,
      [id]
    );

    const order = orderResult.rows[0];
    order.items = itemsResult.rows;
    order.review = reviewResult.rows.length > 0 ? reviewResult.rows[0] : null;

    return successResponse(res, { order });
  } catch (error) {
    console.error('Get order error:', error);
    return errorResponse(res, 'Failed to fetch order.', 500);
  }
});

// POST /api/orders
router.post('/', async (req, res) => {
  const client = await getClientMain();

  try {
    const { customer_name, customer_phone, table_number, order_type, payment_method, notes, note, items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      client.release();
      return errorResponse(res, 'Order must contain at least one item.');
    }

    if (order_type && !ORDER_TYPES.includes(order_type)) {
      client.release();
      return errorResponse(res, `Invalid order type. Allowed: ${ORDER_TYPES.join(', ')}`);
    }

    let targetRestaurantId = req.user.restaurant_id;
    if (!targetRestaurantId) {
      const restRes = await client.query('SELECT id FROM restaurants ORDER BY id ASC LIMIT 1');
      targetRestaurantId = restRes.rows.length > 0 ? restRes.rows[0].id : 1;
    }

    await client.query('BEGIN');

    let totalAmount = 0;
    const orderItems = [];

    for (const item of items) {
      const menuItemId = item.menu_item_id || item.menu_item;
      const qty = parseInt(item.quantity);

      if (!menuItemId || isNaN(qty) || qty < 1) {
        await client.query('ROLLBACK');
        client.release();
        return errorResponse(res, 'Each item must have menu_item_id/menu_item and quantity (>= 1).');
      }

      const menuItem = await queryMedia(
        'SELECT id, name, price FROM menu_items WHERE id = $1 AND restaurant_id = $2 AND is_available = TRUE',
        [menuItemId, targetRestaurantId]
      );

      if (menuItem.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return errorResponse(res, `Menu item with ID ${menuItemId} not found or unavailable.`);
      }

      const menuData = menuItem.rows[0];
      const itemTotal = parseFloat(menuData.price) * qty;
      totalAmount += itemTotal;

      orderItems.push({
        menu_item_id: menuData.id,
        item_name: menuData.name,
        quantity: qty,
        price: parseFloat(menuData.price),
        total: itemTotal,
      });
    }

    const orderNotes = notes || note || null;

    const orderResult = await client.query(
      `INSERT INTO orders (restaurant_id, user_id, customer_name, customer_phone, table_number,
                           order_type, total_amount, payment_method, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, restaurant_id, user_id, customer_name, customer_phone, table_number, order_type, status,
                 total_amount, payment_method, payment_status, notes, created_at`,
      [
        targetRestaurantId,
        req.user?.id || null,
        customer_name || null,
        customer_phone || null,
        table_number || null,
        order_type || 'dine_in',
        totalAmount,
        payment_method || null,
        orderNotes,
      ]
    );

    const order = orderResult.rows[0];

    for (const orderItem of orderItems) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price, total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, orderItem.menu_item_id, orderItem.item_name, orderItem.quantity, orderItem.price, orderItem.total]
      );
    }

    await client.query('COMMIT');
    client.release();

    order.items = orderItems.map(item => ({ ...item, status: 'pending' }));

    if (req.io) {
      req.io.emit(`new_order_${req.user.restaurant_id}`, order);
    }

    // Send Telegram Notification
    try {
      const { sendNotificationToRestaurant } = await import('../bot/telegram.js');
      const formattedTotal = new Intl.NumberFormat('uz-UZ').format(totalAmount);
      const orderItemsText = orderItems.map(item => `- ${item.item_name} x ${item.quantity}`).join('\n');
      const tableText = order.table_number ? `Stol: ${order.table_number}` : (order.order_type === 'takeaway' ? 'Olib ketish' : 'Yetkazib berish');
      const noteText = order.notes ? `\n\n📝 Izoh: ${order.notes}` : '';
      const notificationMessage = `🔔 <b>YANGI BUYURTMA (Panel)!</b>\n\n<b>Buyurtma ID:</b> #${order.id}\n<b>Mijoz:</b> ${order.customer_name || 'Staff'}\n<b>Xizmat turi:</b> ${tableText}\n<b>Jami:</b> ${formattedTotal} UZS\n\n<b>Mahsulotlar:</b>\n${orderItemsText}${noteText}`;
      
      sendNotificationToRestaurant(req.user.restaurant_id, notificationMessage).catch(console.error);
    } catch (err) {
      console.error('Failed to trigger order notification:', err.message);
    }

    return successResponse(res, { order }, 201);
  } catch (error) {
    await client.query('ROLLBACK');
    client.release();
    console.error('Create order error:', error);
    return errorResponse(res, 'Failed to create order.', 500);
  }
});

// PUT /api/orders/:id/status
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !ORDER_STATUSES.includes(status)) {
      return errorResponse(res, `Invalid status. Allowed: ${ORDER_STATUSES.join(', ')}`);
    }

    const client = await getClientMain();
    try {
      await client.query('BEGIN');
      
      const orderRes = await client.query('SELECT status, inventory_deducted FROM orders WHERE id = $1 AND restaurant_id = $2 FOR UPDATE', [id, req.user.restaurant_id]);
      if (orderRes.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return errorResponse(res, 'Order not found.', 404);
      }
      const order = orderRes.rows[0];

      let newDeductedStatus = order.inventory_deducted;

      // Deduct inventory
      if (!order.inventory_deducted && (status === 'ready' || status === 'completed')) {
        const items = await client.query('SELECT menu_item_id, quantity FROM order_items WHERE order_id = $1', [id]);
        for (const item of items.rows) {
          if (!item.menu_item_id) continue;
          const recipes = await client.query('SELECT inventory_id, quantity_required FROM recipe_ingredients WHERE menu_item_id = $1 AND restaurant_id = $2', [item.menu_item_id, req.user.restaurant_id]);
          for (const recipe of recipes.rows) {
            await client.query('UPDATE inventory SET quantity = quantity - $1 WHERE id = $2', [recipe.quantity_required * item.quantity, recipe.inventory_id]);
          }
        }
        newDeductedStatus = true;
      }
      // Refund inventory
      else if (order.inventory_deducted && status === 'cancelled') {
        const items = await client.query('SELECT menu_item_id, quantity FROM order_items WHERE order_id = $1', [id]);
        for (const item of items.rows) {
          if (!item.menu_item_id) continue;
          const recipes = await client.query('SELECT inventory_id, quantity_required FROM recipe_ingredients WHERE menu_item_id = $1 AND restaurant_id = $2', [item.menu_item_id, req.user.restaurant_id]);
          for (const recipe of recipes.rows) {
            await client.query('UPDATE inventory SET quantity = quantity + $1 WHERE id = $2', [recipe.quantity_required * item.quantity, recipe.inventory_id]);
          }
        }
        newDeductedStatus = false;
      }

      const result = await client.query(
        `UPDATE orders SET status = $1, inventory_deducted = $2, updated_at = NOW()
         WHERE id = $3
         RETURNING id, status, updated_at`,
        [status, newDeductedStatus, id]
      );

      await client.query('COMMIT');
      client.release();
      
      if (status === 'ready') {
        try {
          const { sendNotificationToRoles } = await import('../bot/telegram.js');
          sendNotificationToRoles(req.user.restaurant_id, ['waiter', 'courier', 'admin'], `✅ <b>Buyurtma tayyor!</b>\nBuyurtma ID: #${id}\nMijozga yetkazish yoki tortish mumkin.`);
        } catch (e) {
          console.error('Notification error:', e);
        }
      }

      return successResponse(res, { order: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }
  } catch (error) {
    console.error('Update order status error:', error);
    return errorResponse(res, 'Failed to update order status.', 500);
  }
});

// PUT /api/orders/:id/assign
router.put('/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { courier_id, table_number } = req.body;

    const result = await queryMain(
      `UPDATE orders
       SET courier_id = COALESCE($1, courier_id),
           table_number = COALESCE($2, table_number),
           updated_at = NOW()
       WHERE id = $3 AND restaurant_id = $4
       RETURNING id, courier_id, table_number, updated_at`,
      [courier_id || null, table_number || null, id, req.user.restaurant_id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Order not found.', 404);
    }

    return successResponse(res, { order: result.rows[0] });
  } catch (error) {
    console.error('Assign order error:', error);
    return errorResponse(res, 'Failed to assign order.', 500);
  }
});

// PUT /api/orders/:id/payment
router.put('/:id/payment', authorize(ROLES.BOSS, ROLES.ADMIN, ROLES.CASHIER), async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_status, payment_method } = req.body;

    if (payment_status && !PAYMENT_STATUSES.includes(payment_status)) {
      return errorResponse(res, `Invalid payment status. Allowed: ${PAYMENT_STATUSES.join(', ')}`);
    }

    const result = await queryMain(
      `UPDATE orders
       SET payment_status = COALESCE($1, payment_status),
           payment_method = COALESCE($2, payment_method),
           updated_at = NOW()
       WHERE id = $3 AND restaurant_id = $4
       RETURNING id, payment_status, payment_method, updated_at`,
      [payment_status || null, payment_method || null, id, req.user.restaurant_id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Order not found.', 404);
    }

    return successResponse(res, { order: result.rows[0] });
  } catch (error) {
    console.error('Update order payment error:', error);
    return errorResponse(res, 'Failed to update payment info.', 500);
  }
});

// DELETE /api/orders/:id
router.delete('/:id', authorize(ROLES.BOSS, ROLES.ADMIN), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await queryMain(
      'DELETE FROM orders WHERE id = $1 AND restaurant_id = $2 RETURNING id',
      [id, req.user.restaurant_id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Order not found.', 404);
    }

    return successResponse(res, { message: 'Order deleted successfully.' });
  } catch (error) {
    console.error('Delete order error:', error);
    return errorResponse(res, 'Failed to delete order.', 500);
  }
});

// PUT /api/orders/items/:item_id/status
router.put('/items/:item_id/status', async (req, res) => {
  try {
    const { item_id } = req.params;
    const { status } = req.body;

    if (!['pending', 'cooking', 'ready'].includes(status)) {
      return errorResponse(res, "Invalid status. Allowed: pending, cooking, ready");
    }

    const result = await queryMain(
      `UPDATE order_items 
       SET status = $1 
       WHERE id = $2 
       RETURNING id, order_id, menu_item_id, item_name, quantity, status`,
      [status, item_id]
    );

    if (result.rows.length === 0) {
      return errorResponse(res, 'Order item not found.', 404);
    }

    const item = result.rows[0];

    // Emit event
    if (req.io) {
      req.io.emit(`order_item_updated_${req.user.restaurant_id}`, item);
    }

    return successResponse(res, { item });
  } catch (error) {
    console.error('Update item status error:', error);
    return errorResponse(res, 'Failed to update item status.', 500);
  }
});

export default router;
