import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

import { initDatabase } from './db/init.js';
import { initBot } from './bot/telegram.js';
import authRoutes from './routes/auth.js';
import menuRoutes from './routes/menu.js';
import ordersRoutes from './routes/orders.js';
import staffRoutes from './routes/staff.js';
import statsRoutes from './routes/stats.js';
import expensesRoutes from './routes/expenses.js';
import complaintsRoutes from './routes/complaints.js';
import reviewsRoutes from './routes/reviews.js';
import attendanceRoutes from './routes/attendance.js';

// Admin panel routes
import tablesRoutes from './routes/tables.js';
import couriersRoutes from './routes/couriers.js';
import messagesRoutes from './routes/messages.js';
import customersRoutes from './routes/customers.js';

// Kassir and Oshpaz routes
import refundsRoutes from './routes/refunds.js';
import discountsRoutes from './routes/discounts.js';
import inventoryRoutes from './routes/inventory.js';
import tasksRoutes from './routes/tasks.js';
import scheduleRoutes from './routes/schedule.js';
import payrollRoutes from './routes/payroll.js';

import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

// Attach io to req so routes can use it
app.use((req, res, next) => {
  req.io = io;
  next();
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      message: 'Restaran2026 API is running',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    data: { status: 'healthy', uptime: process.uptime() },
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/complaints', complaintsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/attendance', attendanceRoutes);

// Admin API Routes
app.use('/api/tables', tablesRoutes);
app.use('/api/couriers', couriersRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/customers', customersRoutes);

// Kassir and Oshpaz API Routes
app.use('/api/refunds', refundsRoutes);
app.use('/api/discounts', discountsRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/payroll', payrollRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found.`,
  });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.',
  });
});

// Start server
const start = async () => {
  try {
    // Initialize database tables
    await initDatabase();
    console.log('Database initialized.');

    // Start Telegram bot
    initBot();

    // Start Express + Socket server
    httpServer.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

start();
