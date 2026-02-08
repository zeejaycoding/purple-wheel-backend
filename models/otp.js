const mongoose = require('mongoose');

const OtpSchema = new mongoose.Schema({
  contact: { type: String, required: true, index: true },
  code: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Otp', OtpSchema);
