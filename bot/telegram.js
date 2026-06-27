import TelegramBot from 'node-telegram-bot-api';
import { queryMain } from '../db/init.js';
import { generateCode } from '../utils/helpers.js';

let bot = null;
let pollingErrorCount = 0;
const MAX_POLLING_ERRORS = 5;
const WEB_APP_URL = process.env.FRONTEND_URL || 'https://restaran2026.vercel.app'; // Placeholder for WebApp URL

export const initBot = () => {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.warn('BOT_TOKEN is not set. Telegram bot will not start.');
    return null;
  }

  try {
    bot = new TelegramBot(token, {
      polling: {
        interval: 3000,
        autoStart: true,
        params: { timeout: 10 },
      },
    });

    bot.on('polling_error', (error) => {
      pollingErrorCount++;
      if (pollingErrorCount <= MAX_POLLING_ERRORS) {
        console.error(`Telegram polling error (${pollingErrorCount}/${MAX_POLLING_ERRORS}):`, error.code || error.message);
      }
    });

    bot.on('message', () => { pollingErrorCount = 0; });

    // ================== COMMANDS ==================

    // /start command
    bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const telegramId = msg.from.id;
      const firstName = msg.from.first_name || '';
      const lastName = msg.from.last_name || '';

      try {
        const existingUser = await queryMain('SELECT username, role, is_approved FROM users WHERE telegram_id = $1 AND is_active = TRUE', [telegramId]);

        if (existingUser.rows.length > 0) {
          const u = existingUser.rows[0];
          const statusMsg = u.is_approved
            ? `✅ Hisobingiz faol!\nRol: ${u.role}\nMenyuni ochish yoki buyurtmalaringizni ko'rish uchun pastdagi tugmalardan foydalaning.`
            : `⏳ Hisobingiz tasdiqlanishini kutmoqda.`;
          
          const keyboard = {
            inline_keyboard: [
              [{ text: "🍔 Menyu (Web App)", web_app: { url: `${WEB_APP_URL}/dashboard/menu-view` } }],
            ]
          };
          if(u.role === 'kuryer') {
            keyboard.inline_keyboard.push([{ text: "🛵 Mening yetkazmalarim", callback_data: 'cmd_deliveries' }]);
          } else if(u.role === 'admin' || u.role === 'kassir') {
            keyboard.inline_keyboard.push([{ text: "📊 Bugungi Hisobot", callback_data: 'cmd_report' }]);
          }

          await bot.sendMessage(chatId, statusMsg, { reply_markup: u.is_approved ? keyboard : undefined });
          return;
        }

        const code = generateCode();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await queryMain(
          `INSERT INTO verification_codes (telegram_id, code, created_at, expires_at, used, first_name, last_name)
           VALUES ($1, $2, NOW(), $3, FALSE, $4, $5)
           ON CONFLICT (telegram_id) DO UPDATE SET code = $2, created_at = NOW(), expires_at = $3, used = FALSE, first_name = $4, last_name = $5`,
          [telegramId, code, expiresAt, firstName, lastName]
        );

        await bot.sendMessage(
          chatId,
          `👋 Xush kelibsiz, ${firstName}!\n\n🔐 Tasdiqlash kodingiz: <b>${code}</b>\n\n⏰ 10 daqiqa amal qiladi.`,
          { 
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[{ text: "🍔 Menyuni ko'rish (Web App)", web_app: { url: `${WEB_APP_URL}/dashboard/menu-view` } }]]
            }
          }
        );
      } catch (error) {
        console.error('Error in /start:', error.message);
      }
    });

    // /menu command
    bot.onText(/\/menu/, async (msg) => {
      await bot.sendMessage(msg.chat.id, "🍔 Restoran menyusi:", {
        reply_markup: {
          inline_keyboard: [[{ text: "Menyuni Ochish", web_app: { url: `${WEB_APP_URL}/dashboard/menu-view` } }]]
        }
      });
    });

    // /myorders command (Mijoz uchun)
    bot.onText(/\/myorders/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const userCheck = await queryMain('SELECT id FROM users WHERE telegram_id = $1 AND role = $2', [msg.from.id, 'mijoz']);
        if (userCheck.rows.length === 0) return bot.sendMessage(chatId, "Siz mijoz sifatida ro'yxatdan o'tmagansiz.");
        
        // Mijoz orders (simplified matching by phone or user_id. Here just by user_id linked through phone if available)
        const phoneCheck = await queryMain('SELECT phone FROM users WHERE id = $1', [userCheck.rows[0].id]);
        if(phoneCheck.rows.length > 0 && phoneCheck.rows[0].phone) {
          const orders = await queryMain('SELECT id, status, total_amount FROM orders WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 5', [phoneCheck.rows[0].phone]);
          if(orders.rows.length === 0) return bot.sendMessage(chatId, "Sizda aktiv buyurtmalar yo'q.");
          
          let text = "Sizning oxirgi buyurtmalaringiz:\n\n";
          orders.rows.forEach(o => { text += `Buyurtma #${o.id} - Holat: ${o.status}\nSumma: ${o.total_amount} UZS\n\n`; });
          await bot.sendMessage(chatId, text);
        } else {
          await bot.sendMessage(chatId, "Telefon raqamingiz tizimda yo'q.");
        }
      } catch (err) {}
    });

    // /deliveries command (Kuryer uchun)
    bot.onText(/\/deliveries/, handleDeliveriesCommand);

    // /report command (Admin uchun)
    bot.onText(/\/report/, handleReportCommand);

    // ================== CALLBACK QUERIES (TUGMALAR) ==================
    bot.on('callback_query', async (callbackQuery) => {
      const msg = callbackQuery.message;
      const data = callbackQuery.data;
      const telegramId = callbackQuery.from.id;

      try {
        if (data === 'cmd_deliveries') {
          await handleDeliveriesCommand({ chat: { id: msg.chat.id }, from: { id: telegramId } });
        } else if (data === 'cmd_report') {
          await handleReportCommand({ chat: { id: msg.chat.id }, from: { id: telegramId } });
        } else if (data.startsWith('accept_order_')) {
          const orderId = data.split('_')[2];
          await queryMain('UPDATE orders SET status = $1 WHERE id = $2', ['cooking', orderId]);
          await bot.answerCallbackQuery(callbackQuery.id, { text: "Buyurtma qabul qilindi!" });
          await bot.editMessageText(msg.text + "\n\n✅ <b>QABUL QILINDI VA OSHXONAGA YUBORILDI</b>", { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML' });
        } else if (data.startsWith('reject_order_')) {
          const orderId = data.split('_')[2];
          await queryMain('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', orderId]);
          await bot.answerCallbackQuery(callbackQuery.id, { text: "Buyurtma bekor qilindi!" });
          await bot.editMessageText(msg.text + "\n\n❌ <b>BEKOR QILINDI</b>", { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML' });
        } else if (data.startsWith('deliver_order_')) {
          const orderId = data.split('_')[2];
          await queryMain('UPDATE orders SET status = $1 WHERE id = $2', ['served', orderId]);
          await bot.answerCallbackQuery(callbackQuery.id, { text: "Topshirildi statusi saqlandi!" });
          await bot.editMessageText(msg.text + "\n\n🏁 <b>TOPSHIRILDI</b>", { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML' });
        }
      } catch (err) {
        console.error('Callback error:', err.message);
      }
    });

    console.log('✅ Telegram bot started successfully.');
    return bot;
  } catch (err) {
    console.error('Failed to initialize Telegram bot:', err.message);
    return null;
  }
};

async function handleDeliveriesCommand(msg) {
  const chatId = msg.chat.id;
  try {
    const user = await queryMain('SELECT id, role FROM users WHERE telegram_id = $1', [msg.from.id]);
    if (user.rows.length === 0 || user.rows[0].role !== 'kuryer') {
      return bot.sendMessage(chatId, "Siz kuryer emassiz.");
    }
    // topish staff_id
    const staffCheck = await queryMain('SELECT id FROM staff WHERE user_id = $1', [user.rows[0].id]);
    if(staffCheck.rows.length === 0) return bot.sendMessage(chatId, "Kuryer profili topilmadi.");
    
    const orders = await queryMain('SELECT id, customer_name, customer_phone, total_amount FROM orders WHERE courier_id = $1 AND status = $2', [staffCheck.rows[0].id, 'ready']);
    
    if (orders.rows.length === 0) return bot.sendMessage(chatId, "Sizda hozircha yetkaziladigan buyurtmalar yo'q.");

    for (const o of orders.rows) {
      await bot.sendMessage(chatId, `📦 <b>Buyurtma #${o.id}</b>\nMijoz: ${o.customer_name}\nTel: ${o.customer_phone}\nSumma: ${o.total_amount} UZS`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: "✅ Yetkazib berdim", callback_data: `deliver_order_${o.id}` }]] }
      });
    }
  } catch (err) {}
}

async function handleReportCommand(msg) {
  const chatId = msg.chat.id;
  try {
    const user = await queryMain('SELECT restaurant_id, role FROM users WHERE telegram_id = $1 AND role IN ($2, $3)', [msg.from.id, 'admin', 'kassir']);
    if (user.rows.length === 0) return bot.sendMessage(chatId, "Sizda bu huquq yo'q.");
    
    const today = new Date().toISOString().split('T')[0];
    const income = await queryMain("SELECT SUM(total_amount) as total FROM orders WHERE restaurant_id = $1 AND payment_status = 'paid' AND created_at::text LIKE $2", [user.rows[0].restaurant_id, today+'%']);
    const total = income.rows[0].total || 0;
    
    await bot.sendMessage(chatId, `📊 <b>Bugungi tushum (${today})</b>\n\nJami: <b>${new Intl.NumberFormat('uz-UZ').format(total)} UZS</b>`, { parse_mode: 'HTML' });
  } catch(err) {}
}

export const sendNotificationToRestaurant = async (restaurantId, message) => {
  if (!bot) return;

  try {
    const ownerResult = await queryMain(
      `SELECT telegram_id FROM users WHERE restaurant_id = $1 AND is_active = TRUE AND is_approved = TRUE AND role IN ('admin', 'boss') AND telegram_id IS NOT NULL`,
      [restaurantId]
    );

    // Extract Order ID to attach buttons if it's a new order notification
    let orderIdMatch = message.match(/Buyurtma ID:<\/b> #(\d+)/);
    let reply_markup = undefined;
    if (orderIdMatch && orderIdMatch[1] && message.includes('YANGI BUYURTMA')) {
      reply_markup = {
        inline_keyboard: [
          [
            { text: "✅ Qabul qilish (Oshxonaga)", callback_data: `accept_order_${orderIdMatch[1]}` },
            { text: "❌ Bekor qilish", callback_data: `reject_order_${orderIdMatch[1]}` }
          ]
        ]
      };
    }

    const chatIds = new Set(ownerResult.rows.map(r => r.telegram_id.toString()));

    for (const chatId of chatIds) {
      try {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup });
      } catch (err) {
        console.error(`Failed to send telegram notification to ${chatId}:`, err.message);
      }
    }
  } catch (error) {
    console.error('Error sending Telegram notification:', error.message);
  }
};

export const sendNotificationToRoles = async (restaurantId, roles, message) => {
  if (!bot || !roles || roles.length === 0) return;

  try {
    const rolesList = roles.map(r => `'${r}'`).join(', ');
    
    // Get users with matching roles
    const userResult = await queryMain(
      `SELECT telegram_id FROM users WHERE restaurant_id = $1 AND role IN (${rolesList}) AND is_active = TRUE AND telegram_id IS NOT NULL`,
      [restaurantId]
    );

    // Get staff with matching roles
    const staffResult = await queryMain(
      `SELECT telegram_id FROM staff WHERE restaurant_id = $1 AND role IN (${rolesList}) AND is_active = TRUE AND telegram_id IS NOT NULL`,
      [restaurantId]
    );

    const chatIds = new Set();
    userResult.rows.forEach(r => chatIds.add(r.telegram_id.toString()));
    staffResult.rows.forEach(r => chatIds.add(r.telegram_id.toString()));

    for (const chatId of chatIds) {
      try {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      } catch (err) {
        console.error(`Failed to send telegram notification to role ${chatId}:`, err.message);
      }
    }
  } catch (error) {
    console.error('Error sending role notification:', error.message);
  }
};

export const sendMessageToUser = async (telegramId, message) => {
  if (!bot || !telegramId) return;
  try {
    await bot.sendMessage(telegramId.toString(), message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Failed to send message to user:', err.message);
  }
};

export default bot;
