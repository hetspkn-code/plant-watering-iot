// models/Device.js
const mongoose = require('mongoose');

// const deviceSchema = new mongoose.Schema({
//   deviceId: { type: String, required: true, unique: true },
//   apiKey: { type: String, required: true },
//   deviceName: { type: String },
//   telegramChatId: { type: String, default: null },
//   alertThreshold: { type: Number, default: null }, // optional per-device
//   createdAt: { type: Date, default: Date.now }
// });

const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true },
  apiKey: { type: String, required: true },
  deviceName: String,
  alertThreshold: { type: Number, default: 400 },
  telegramChatId: String,
  dashboardUrl: String,
  alertActive: { type: Boolean, default: false }, // 👈 NEW
  lastValue: { type: Number, default: 0 },        // 👈 NEW
});


module.exports = mongoose.model('Device', deviceSchema);
