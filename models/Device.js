const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true },
  apiKey: { type: String, required: true },
  deviceName: String,
  alertThreshold: { type: Number, default: 500 }, // dry threshold
  wetThreshold: { type: Number, default: 650 },
  forcedPump: { type: String, enum: ['on','off',null], default: null }, // manual override
  alertActive: { type: Boolean, default: false },
  lastValue: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Device', deviceSchema);
