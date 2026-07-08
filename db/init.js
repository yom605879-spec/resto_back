import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// 1. Core Operations DB
const poolMain = new Pool({
  connectionString: process.env.DB_MAIN_URL,
  ssl: { rejectUnauthorized: false },
  max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
});

// 2. Media & Menu DB
const poolMedia = new Pool({
  connectionString: process.env.DB_MEDIA_URL,
  ssl: { rejectUnauthorized: false },
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
});

// 3. Logs & Archives DB
const poolLogs = new Pool({
  connectionString: process.env.DB_LOGS_URL,
  ssl: { rejectUnauthorized: false },
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
});

const logQuery = (poolName, text, duration, rowCount) => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[${poolName}] Query executed`, { text: text.substring(0, 80), duration: `${duration}ms`, rows: rowCount });
  }
};

export const queryMain = async (text, params) => {
  const start = Date.now();
  try {
    const result = await poolMain.query(text, params);
    logQuery('MAIN', text, Date.now() - start, result.rowCount);
    return result;
  } catch (error) {
    console.error('[MAIN] DB error:', error.message);
    throw error;
  }
};

export const queryMedia = async (text, params) => {
  const start = Date.now();
  try {
    const result = await poolMedia.query(text, params);
    logQuery('MEDIA', text, Date.now() - start, result.rowCount);
    return result;
  } catch (error) {
    console.error('[MEDIA] DB error:', error.message);
    throw error;
  }
};

export const queryLogs = async (text, params) => {
  const start = Date.now();
  try {
    const result = await poolLogs.query(text, params);
    logQuery('LOGS', text, Date.now() - start, result.rowCount);
    return result;
  } catch (error) {
    console.error('[LOGS] DB error:', error.message);
    throw error;
  }
};

export const getClientMain = async () => await poolMain.connect();
export const getClientMedia = async () => await poolMedia.connect();
export const getClientLogs = async () => await poolLogs.connect();

export const initDatabase = async () => {
  console.log('Initializing sharded database tables across 3 servers...');

  // --- 1. MAIN DB (Core Operations) ---
  const sqlMain = `
    CREATE TABLE IF NOT EXISTS verification_codes (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      code VARCHAR(6) NOT NULL,
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      google_uid VARCHAR(255) UNIQUE,
      email VARCHAR(255),
      username VARCHAR(50) UNIQUE NOT NULL,
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      password_hash VARCHAR(255),
      role VARCHAR(20) DEFAULT 'boss',
      restaurant_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      is_active BOOLEAN DEFAULT TRUE,
      is_approved BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS restaurants (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      is_active BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      username VARCHAR(50) UNIQUE NOT NULL,
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL,
      salary_type VARCHAR(20) DEFAULT 'fixed',
      fixed_salary DECIMAL(12,2) DEFAULT 0,
      percentage_rate DECIMAL(5,2) DEFAULT 0,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      is_active BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      courier_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      customer_name VARCHAR(200),
      customer_phone VARCHAR(20),
      table_number INTEGER,
      order_type VARCHAR(20) DEFAULT 'dine_in',
      status VARCHAR(20) DEFAULT 'new',
      total_amount DECIMAL(10,2) DEFAULT 0,
      payment_method VARCHAR(20),
      payment_status VARCHAR(20) DEFAULT 'pending',
      notes TEXT,
      inventory_deducted BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      menu_item_id INTEGER, -- Sharded: Refers to Media DB
      item_name VARCHAR(200) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      price DECIMAL(10,2) NOT NULL,
      total DECIMAL(10,2) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS tables (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      table_number INTEGER NOT NULL,
      capacity INTEGER DEFAULT 4,
      status VARCHAR(20) DEFAULT 'available',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS discounts (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      code VARCHAR(50) UNIQUE NOT NULL,
      discount_type VARCHAR(20) DEFAULT 'percentage',
      value DECIMAL(10,2) NOT NULL,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      item_name VARCHAR(200) NOT NULL,
      quantity DECIMAL(10,2) NOT NULL,
      unit VARCHAR(20) NOT NULL,
      min_threshold DECIMAL(10,2) DEFAULT 0,
      last_updated TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      menu_item_id INTEGER NOT NULL, -- Refers to Media DB
      inventory_id INTEGER REFERENCES inventory(id) ON DELETE CASCADE,
      quantity_required DECIMAL(10,3) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;

  // --- 2. MEDIA DB (Menu, Content & Images) ---
  const sqlMedia = `
    CREATE TABLE IF NOT EXISTS menu_categories (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL, -- Sharded: Refers to Main DB
      name VARCHAR(200) NOT NULL,
      sort_order INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id SERIAL PRIMARY KEY,
      category_id INTEGER REFERENCES menu_categories(id) ON DELETE CASCADE,
      restaurant_id INTEGER NOT NULL, -- Sharded: Refers to Main DB
      name VARCHAR(200) NOT NULL,
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      image_url TEXT, -- Base64 yoki url
      is_available BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS media_files (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL,
      related_type VARCHAR(50), -- masalan 'menu_item'
      related_id INTEGER,
      image_data TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;

  // --- 3. LOGS DB (Archives, Expenses, Complaints) ---
  const sqlLogs = `
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL,
      category VARCHAR(100) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      description TEXT,
      date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_reviews (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL, -- Sharded: Refers to Main DB
      rating INTEGER CHECK (rating >= 1 AND rating <= 5) NOT NULL,
      comment TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL,
      customer_name VARCHAR(100) NOT NULL,
      customer_phone VARCHAR(20),
      subject VARCHAR(200) NOT NULL,
      message TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'new',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL,
      customer_id INTEGER,
      phone_number VARCHAR(20),
      message TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'sent',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      reason TEXT,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS salaries_paid (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      month VARCHAR(20) NOT NULL,
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT,
      assigned_to INTEGER, -- Sharded: Refers to Main DB (staff.id)
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS schedule (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER NOT NULL,
      staff_id INTEGER NOT NULL,
      shift_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      role_shift VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;

  const executeWithRetry = async (pool, sql, label, retries = 3) => {
    for (let i = 1; i <= retries; i++) {
      try {
        console.log(`[${label}] DB init (attempt ${i})...`);
        await pool.query(sql);
        return;
      } catch (err) {
        console.warn(`[${label}] Attempt ${i} failed: ${err.message}`);
        if (i === retries) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  };

  try {
    await executeWithRetry(poolMain, sqlMain, '1/3 Main');
    await executeWithRetry(poolMedia, sqlMedia, '2/3 Media');
    await executeWithRetry(poolLogs, sqlLogs, '3/3 Logs');
    console.log('All 3 databases initialized successfully.');

    try {
      const restaurants = await queryMain('SELECT id FROM restaurants');
      for (const rest of restaurants.rows) {
        await seedDefaultMenu(rest.id);
      }
    } catch (e) {
      console.error('Error auto-seeding existing restaurants:', e.message);
    }
  } catch (error) {
    console.error('Failed to initialize sharded databases:', error.message);
    throw error;
  }
};

export const seedDefaultMenu = async (restaurantId) => {
  if (!restaurantId) return;
  try {
    const catCheck = await queryMedia('SELECT id FROM menu_categories WHERE restaurant_id = $1 LIMIT 1', [restaurantId]);
    if (catCheck.rows && catCheck.rows.length > 0) {
      return; // Already has categories/menu
    }

    console.log(`[SEED] Seeding demo menu items for restaurant_id = ${restaurantId}...`);

    // 1. Asosiy Taomlar
    const cat1Res = await queryMedia(
      'INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id',
      [restaurantId, 'Asosiy Taomlar', 1]
    );
    const cat1Id = cat1Res.rows[0].id;

    await queryMedia(
      'INSERT INTO menu_items (category_id, restaurant_id, name, description, price, image_url, is_available) VALUES ($1, $2, $3, $4, $5, $6, TRUE)',
      [cat1Id, restaurantId, 'Truffle Ribeye Steak', "Olovda pishirilgan premium mol go'shti, trufel sousi bilan.", 245000, "https://images.unsplash.com/photo-1546833999-b9f581a1996d?auto=format&fit=crop&w=400&q=80"]
    );
    await queryMedia(
      'INSERT INTO menu_items (category_id, restaurant_id, name, description, price, image_url, is_available) VALUES ($1, $2, $3, $4, $5, $6, TRUE)',
      [cat1Id, restaurantId, 'Qirollik Qisqichbaqasi', "Sarimsoq va limon sousida qovurilgan ulkan qisqichbaqa oyoqlari.", 320000, "https://images.unsplash.com/photo-1559742811-822873691df8?auto=format&fit=crop&w=400&q=80"]
    );

    // 2. Pitsa va Sushi
    const cat2Res = await queryMedia(
      'INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id',
      [restaurantId, 'Pitsa va Sushi', 2]
    );
    const cat2Id = cat2Res.rows[0].id;

    await queryMedia(
      'INSERT INTO menu_items (category_id, restaurant_id, name, description, price, image_url, is_available) VALUES ($1, $2, $3, $4, $5, $6, TRUE)',
      [cat2Id, restaurantId, "Sushi Set 'Tokyo'", "Yangi losos, orkinos va qisqichbaqa go'shtidan iborat 24 talik set.", 180000, "https://images.unsplash.com/photo-1579871494447-9811cf80d66c?auto=format&fit=crop&w=400&q=80"]
    );
    await queryMedia(
      'INSERT INTO menu_items (category_id, restaurant_id, name, description, price, image_url, is_available) VALUES ($1, $2, $3, $4, $5, $6, TRUE)',
      [cat2Id, restaurantId, 'Margarita Pitsasi', "Haqiqiy italyancha resept. Motsarella pishlog'i va pomidor sousi.", 95000, "https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=400&q=80"]
    );

    // 3. Shirinliklar va Dezertlar
    const cat3Res = await queryMedia(
      'INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id',
      [restaurantId, 'Shirinliklar va Dezertlar', 3]
    );
    const cat3Id = cat3Res.rows[0].id;

    await queryMedia(
      'INSERT INTO menu_items (category_id, restaurant_id, name, description, price, image_url, is_available) VALUES ($1, $2, $3, $4, $5, $6, TRUE)',
      [cat3Id, restaurantId, 'Pista va Malina Dezerti', "Fransuzcha makaron, yangi malina va maxsus pista kremi.", 65000, "https://images.unsplash.com/photo-1563729784474-d77dbb933a9e?auto=format&fit=crop&w=400&q=80"]
    );
    await queryMedia(
      'INSERT INTO menu_items (category_id, restaurant_id, name, description, price, image_url, is_available) VALUES ($1, $2, $3, $4, $5, $6, TRUE)',
      [cat3Id, restaurantId, 'Tiramisu Klasik', "Mascarpone pishlog'i va kofe ekstrakti bilan tayyorlangan shirinlik.", 55000, "https://images.unsplash.com/photo-1571115177098-24ec42ed204d?auto=format&fit=crop&w=400&q=80"]
    );

    console.log(`[SEED] Seeding demo menu completed for restaurant_id = ${restaurantId}`);
  } catch (error) {
    console.error(`[SEED] Error seeding menu for restaurant_id = ${restaurantId}:`, error.message);
  }
};