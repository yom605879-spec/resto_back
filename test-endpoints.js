
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';
const PORT = process.env.PORT || 5000;
const BASE_URL = `http://localhost:${PORT}`;

// Create a valid token for Boss (ID 2)
const token = jwt.sign(
  { id: 2, username: 'muhammadali', role: 'boss', restaurant_id: 1, user_type: 'user' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const headers = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json'
};

const endpoints = [
  '/api/auth/me',
  '/api/auth/all-users',
  '/api/auth/pending',
  '/api/auth/branches',
  '/api/stats/overview',
  '/api/menu/categories',
  '/api/menu/items',
  '/api/orders',
  '/api/orders/public/1',
  '/api/expenses',
  '/api/tables',
  '/api/couriers',
  '/api/messages',
  '/api/customers',
  '/api/complaints',
  '/api/refunds',
  '/api/discounts',
  '/api/inventory',
  '/api/finance/reports'
];

async function testEndpoints() {
  console.log(`Starting automated tests for ${endpoints.length} endpoints...`);
  let errors = 0;

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`${BASE_URL}${endpoint}`, { headers });
      const text = await res.text();
      
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = text.substring(0, 50) + '...';
      }

      if (res.ok) {
        console.log(`✅ [${res.status}] GET ${endpoint}`);
      } else {
        console.error(`❌ [${res.status}] GET ${endpoint} - Error:`, typeof data === 'object' ? data.error || data.message || data : data);
        errors++;
      }
    } catch (err) {
      console.error(`🚨 FAILED GET ${endpoint} - Exception: ${err.message}`);
      errors++;
    }
  }

  console.log(`\nTest complete. ${errors} errors found.`);
}

testEndpoints();
