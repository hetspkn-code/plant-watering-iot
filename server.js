// // server.js
// require('dotenv').config();
// const express = require('express');
// const mongoose = require('mongoose');
// const cors = require('cors');
// const http = require('http');
// const { Server } = require('socket.io');
// const TelegramBot = require('node-telegram-bot-api');

// const GasReading = require('./models/GasReading');

// const app = express();
// const server = http.createServer(app);
// const io = new Server(server);

// app.use(cors());
// app.use(express.json());
// app.use(express.static('public'));

// const PORT = process.env.PORT || 3000;
// const MONGO_URL = process.env.MONGO_URL;
// const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// const ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD || 400);

// // Telegram bot (optional)
// let bot = null;
// if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
//   // We don't need polling because we only send messages from the server.
//   bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
//   console.log('Telegram bot configured.');
// } else {
//   console.log('Telegram not configured — will skip alerts.');
// }

// // Connect to MongoDB
// mongoose.connect(MONGO_URL, {
//   useNewUrlParser: true,
//   useUnifiedTopology: true
// }).then(() => console.log('MongoDB connected')).catch(err => console.error('MongoDB error', err));

// // API: receive reading from ESP8266 (POST JSON { value })
// app.post('/api/gas', async (req, res) => {
//   try {
//     const { value } = req.body;
//     if (typeof value !== 'number') return res.status(400).json({ error: 'value required (number)' });

//     const reading = await GasReading.create({ value });

//     // emit to dashboard clients via socket.io
//     io.emit('new-reading', { value: reading.value, timestamp: reading.timestamp });

//     // check threshold and send telegram alert
//     if (value >= ALERT_THRESHOLD && bot) {
//       const text = `⚠️ *Gas Alert*\nValue: ${value}\nTime: ${new Date(reading.timestamp).toLocaleString()}`;
//       bot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'Markdown' }).catch(err => console.error('Telegram send error', err));
//     }

//     res.json({ ok: true });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: 'server error' });
//   }
// });

// // API: get recent readings
// app.get('/api/gas', async (req, res) => {
//   const limit = Number(req.query.limit || 50);
//   const readings = await GasReading.find().sort({ timestamp: -1 }).limit(limit);
//   res.json(readings);
// });

// // Socket connection logging
// io.on('connection', socket => {
//   console.log('Dashboard client connected', socket.id);
//   socket.on('disconnect', () => console.log('Dashboard client disconnected', socket.id));
// });

// server.listen(PORT, () => console.log(`Server running on port ${PORT}`));


// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');

const Device = require('./models/Device');
const GasReading = require('./models/GasReading');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GLOBAL_ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD || 400);

// Connect to MongoDB
mongoose.connect(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=> console.log('MongoDB connected'))
  .catch(err => { console.error('MongoDB connect error', err); process.exit(1); });

// Telegram bot (polling) - required to let users /link <deviceId>
let bot = null;
if (TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('Telegram bot active (polling).');
  // Bot command: /link <deviceId>  -> store chatId to device
  bot.onText(/\/link (.+)/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    const deviceId = match[1].trim();
    try {
      const device = await Device.findOne({ deviceId });
      if (!device) {
        bot.sendMessage(chatId, `❌ Device ${deviceId} not found.`);
        return;
      }
      device.telegramChatId = chatId;
      await device.save();
      bot.sendMessage(chatId, `✅ Device ${deviceId} linked. You will receive alerts for this device.`);
    } catch (err) {
      console.error('Telegram /link error', err);
    }
  });
} else {
  console.log('No TELEGRAM_BOT_TOKEN configured - Telegram features disabled.');
}

// Socket.IO: clients can join rooms for deviceId to receive live updates
io.on('connection', socket => {
  console.log('Socket connected', socket.id);
  socket.on('join-device', (deviceId) => {
    socket.join(deviceId);
    console.log(`Socket ${socket.id} joined room ${deviceId}`);
  });
  socket.on('leave-device', (deviceId) => {
    socket.leave(deviceId);
  });
  socket.on('disconnect', () => {
    // console.log('Socket disconnected', socket.id);
  });
});

/**
 * POST /api/register
 * Body: { deviceName: string }
 * Returns: { deviceId, apiKey, dashboardUrl }
 *
 * This is called by the ESP after first Wi-Fi connection.
 */
app.post('/api/register', async (req, res) => {
  try {
    const { deviceName } = req.body;
    // create unique deviceId and apiKey
    const deviceId = (Date.now().toString(36) + Math.random().toString(36).slice(2,8));
    const apiKey = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

    const device = new Device({ deviceId, apiKey, deviceName });
    await device.save();

    const dashboardUrl = `${req.protocol}://${req.get('host')}/dashboard/${deviceId}`;
    res.json({ deviceId, apiKey, dashboardUrl });
  } catch (err) {
    console.error('Register error', err);
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * POST /api/gas
 * Receives readings from devices. Requires deviceId and apiKey in body OR x-api-key header + deviceId in body.
 * Body: { deviceId, value, apiKey? }
 */
// app.post('/api/gas', async (req, res) => {
//   try {
//     const { deviceId, value } = req.body;
//     let apiKey = req.body.apiKey || req.headers['x-api-key'];

//     if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
//     if (typeof value === 'undefined') return res.status(400).json({ error: 'value required' });

//     const device = await Device.findOne({ deviceId });
//     if (!device) return res.status(401).json({ error: 'Invalid device' });

//     if (!apiKey || apiKey !== device.apiKey) {
//       return res.status(401).json({ error: 'Unauthorized: invalid apiKey' });
//     }

//     const reading = new GasReading({ deviceId, value });
//     await reading.save();

//     // emit to Socket.IO room for this device
//     io.to(deviceId).emit('new-reading', { deviceId, value: reading.value, timestamp: reading.timestamp });

//     // decide threshold: device-specific if set, otherwise global
//     const threshold = (device.alertThreshold != null) ? device.alertThreshold : GLOBAL_ALERT_THRESHOLD;
//     if (value >= threshold) {
//       // send Telegram alert to linked chat (if present)
//       if (bot && device.telegramChatId) {
//         const text = `⚠️ *Gas Alert*\nDevice: ${device.deviceName || device.deviceId}\nValue: ${value}\nTime: ${new Date(reading.timestamp).toLocaleString()}`;
//         bot.sendMessage(device.telegramChatId, text, { parse_mode: 'Markdown' }).catch(e => console.error('Telegram send error', e));
//       }
//     }

//     res.status(201).json({ success: true });
//   } catch (err) {
//     console.error('API gas error', err);
//     res.status(500).json({ error: 'server error' });
//   }
// });

app.post('/api/gas', async (req, res) => {
  try {
    const { deviceId, value } = req.body;
    const apiKey = req.body.apiKey || req.headers['x-api-key'];

    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    if (typeof value === 'undefined') return res.status(400).json({ error: 'value required' });

    const device = await Device.findOne({ deviceId });
    if (!device) return res.status(401).json({ error: 'Invalid device' });

    if (!apiKey || apiKey !== device.apiKey)
      return res.status(401).json({ error: 'Unauthorized: invalid apiKey' });

    // Save the reading
    const reading = new GasReading({ deviceId, value });
    await reading.save();

    // Notify connected dashboards
    io.to(deviceId).emit('new-reading', {
      deviceId,
      value,
      timestamp: reading.timestamp,
    });

    // Determine threshold
    const threshold =
      device.alertThreshold != null
        ? device.alertThreshold
        : GLOBAL_ALERT_THRESHOLD;

    const wasActive = device.alertActive;
    const nowActive = value >= threshold;

    // Update device record
    device.lastValue = value;
    device.alertActive = nowActive;
    await device.save();

    // 🚨 Alert just triggered
    if (!wasActive && nowActive) {
      console.log(`🚨 Gas leak detected for ${deviceId} (${value})`);
      if (bot && device.telegramChatId) {
        const text = `🚨 *Gas Alert*\nDevice: ${
          device.deviceName || device.deviceId
        }\nValue: ${value}\nTime: ${new Date(reading.timestamp).toLocaleString()}`;
        bot
          .sendMessage(device.telegramChatId, text, { parse_mode: 'Markdown' })
          .catch((e) => console.error('Telegram send error', e));
      }
    }

    // ✅ Alert resolved
    else if (wasActive && !nowActive) {
      console.log(`✅ Gas level back to normal for ${deviceId} (${value})`);
      if (bot && device.telegramChatId) {
        const text = `✅ *Gas Normal*\nDevice: ${
          device.deviceName || device.deviceId
        }\nValue: ${value}\nTime: ${new Date(reading.timestamp).toLocaleString()}`;
        bot
          .sendMessage(device.telegramChatId, text, { parse_mode: 'Markdown' })
          .catch((e) => console.error('Telegram send error', e));
      }
    }

    res.status(201).json({ success: true });
  } catch (err) {
    console.error('API gas error', err);
    res.status(500).json({ error: 'server error' });
  }
});


/**
 * GET /api/gas?deviceId=...&limit=..
 * Get recent readings for a device.
 * NOTE: this endpoint is intentionally simple: possession of the deviceId grants access to the dashboard.
 * If you need stronger security, protect this endpoint with tokens or login.
 */
app.get('/api/gas', async (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    const limit = Math.min(200, Number(req.query.limit) || 50);
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const readings = await GasReading.find({ deviceId }).sort({ timestamp: -1 }).limit(limit);
    res.json(readings);
  } catch (err) {
    console.error('GET /api/gas error', err);
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * POST /api/link-telegram
 * Link a telegram chat to a device programmatically (optional).
 * Body: { deviceId, chatId, apiKey }
 * The device's apiKey is required to authorize linking
 */
app.post('/api/link-telegram', async (req, res) => {
  try {
    const { deviceId, chatId, apiKey } = req.body;
    if (!deviceId || !chatId || !apiKey) return res.status(400).json({ error: 'deviceId, chatId, apiKey required' });

    const device = await Device.findOne({ deviceId });
    if (!device) return res.status(404).json({ error: 'device not found' });
    if (device.apiKey !== apiKey) return res.status(401).json({ error: 'unauthorized' });

    device.telegramChatId = chatId.toString();
    await device.save();
    res.json({ success: true });
  } catch (err) {
    console.error('/api/link-telegram error', err);
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * Serve the per-device dashboard page
 */
app.get('/dashboard/:deviceId', (req, res) => {
  res.sendFile(__dirname + '/public/device-dashboard.html');
});

// simple index (optional)
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
