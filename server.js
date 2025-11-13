// server.js -- Plant watering server (Express + Mongoose + Socket.IO)
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const Device = require('./models/Device');      // reuse/modify as below
const Reading = require('./models/Reading'); // use as generic Reading

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/plant-watering';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// connect to mongo
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(()=> console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Utility: generate apiKey
function genKey() {
  return crypto.randomBytes(18).toString('hex');
}

/**
 * Device registration
 * POST /api/register
 * body: { deviceId, deviceName? }
 * returns: { deviceId, apiKey, deviceName }
 * If device exists returns existing apiKey.
 */
app.post('/api/register', async (req, res) => {
  try {
    const { deviceId, deviceName } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    let device = await Device.findOne({ deviceId });
    if (!device) {
      device = new Device({
        deviceId,
        apiKey: genKey(),
        deviceName: deviceName || deviceId,
        alertThreshold: 500, // default soil threshold (you can change)
        alertActive: false
      });
      await device.save();
    }
    return res.json({ deviceId: device.deviceId, apiKey: device.apiKey, deviceName: device.deviceName });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

/**
 * Device posts a reading
 * POST /api/readings
 * body: { deviceId, apiKey, soilValue, pumpState? }
 * server saves reading and returns control instruction (pump: "on"|"off"|"none")
 */
app.post('/api/readings', async (req, res) => {
  try {
    const { deviceId, apiKey, soilValue, pumpState } = req.body;
    if (!deviceId || typeof soilValue === 'undefined') return res.status(400).json({ error: 'deviceId and soilValue required' });

    const device = await Device.findOne({ deviceId });
    if (!device) return res.status(401).json({ error: 'Unknown device' });
    if (!apiKey || apiKey !== device.apiKey) return res.status(401).json({ error: 'Invalid apiKey' });

    const reading = new Reading({ deviceId, value: soilValue });
    await reading.save();

    // update device lastValue/pump state
    device.lastValue = soilValue;
    if (typeof pumpState !== 'undefined') device.alertActive = !!pumpState;
    await device.save();

    // emit live update for dashboards
    io.to(deviceId).emit('new-reading', { deviceId, soilValue, timestamp: reading.timestamp });

    // Decide control: simple hysteresis using device.alertThreshold, and optional device fields
    // If soilValue < dry -> turn pump ON. If soilValue > wet threshold -> turn OFF.
    const dryThreshold = device.alertThreshold ?? 500;       // default
    const wetThreshold = device.wetThreshold ?? (dryThreshold + 120);

    let action = "none";
    // If device requested manual override (alertActive used as pumpState), prefer it:
    if (device.forcedPump === 'on') action = 'on';
    else if (device.forcedPump === 'off') action = 'off';
    else {
      // automatic
      if (soilValue < dryThreshold) action = 'on';
      else if (soilValue > wetThreshold) action = 'off';
      else action = 'none';
    }

    return res.json({ success: true, action, dryThreshold, wetThreshold });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

/**
 * Dashboard control APIs (simple)
 * POST /api/device/:deviceId/force  { apiKey, action: "on"|"off"|"auto" }
 * GET  /api/device/:deviceId        { apiKey } returns device info
 */
app.post('/api/device/:deviceId/force', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { apiKey, action } = req.body;
    const device = await Device.findOne({ deviceId });
    if (!device) return res.status(404).json({ error: 'device not found' });
    if (!apiKey || apiKey !== device.apiKey) return res.status(401).json({ error: 'invalid apiKey' });

    if (action === 'on' || action === 'off') {
      device.forcedPump = action;
    } else {
      device.forcedPump = null; // go back to auto
    }
    await device.save();
    io.to(deviceId).emit('device-update', { deviceId, forcedPump: device.forcedPump });
    return res.json({ success: true, forcedPump: device.forcedPump });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

app.get('/api/device/:deviceId', async (req, res) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) return res.status(404).json({ error: 'not found' });
    return res.json(device);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

/**
 * Serve the dashboard page (you can open /dashboard/<deviceId>)
 */
app.get('/dashboard/:deviceId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'device-dashboard.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO: allow dashboard clients to join a room for a device
io.on('connection', socket => {
  console.log('client connected', socket.id);
  socket.on('join', deviceId => {
    socket.join(deviceId);
    console.log('socket joined room', deviceId);
  });
  socket.on('disconnect', () => console.log('client disconnected', socket.id));
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
