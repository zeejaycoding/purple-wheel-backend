const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Otp = require('../models/Otp');
const jwt = require('jsonwebtoken');
const sendOtpUtil = require('../utils/sendOtp');
const twilio = require('twilio');

const client = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Rate limit map (in-memory, use Redis for prod)
const resendLimits = new Map();  // contact => { count, lastTime }

router.post('/send-otp', async (req, res) => {
  const { contact, countryCode, phone } = req.body;
  // contact may be an email, a full E.164 phone, or frontend can send countryCode + phone
  if (!contact && !(countryCode && phone)) return res.status(400).json({ msg: 'Provide contact or countryCode and phone' });

  // build a key for rate-limiting before sending
  const buildRateKey = () => {
    if (contact) {
      return contact;
    }
    const cc = String(countryCode).replace(/\D/g, '');
    const digits = String(phone).replace(/\D/g, '');
    const withoutLeadingZero = digits.replace(/^0+/, '');
    return `+${cc}${withoutLeadingZero}`;
  };

  const rateKey = buildRateKey();

  try {
    // Rate limit: max 3 resends per 10 min (do not increment until send succeeds)
    const now = Date.now();
    let limit = resendLimits.get(rateKey) || { count: 0, lastTime: now };
    if (now - limit.lastTime > 10 * 60 * 1000) limit = { count: 0, lastTime: now };  // reset after 10 min
    if (limit.count >= 3) return res.status(429).json({ msg: 'Too many resends, try later' });

    // Delete old OTP for the identifier we will store (for email, store; for phone Twilio handles)
    await Otp.deleteMany({ contact: rateKey });

    const sendInput = contact ? contact : { countryCode, phone };
    const { code, expiresAt, normalizedContact } = await sendOtpUtil(sendInput);

    // Store only for email (for phone, Twilio handles). Use normalizedContact as key for consistency.
    if (normalizedContact && normalizedContact.includes('@')) {
      await new Otp({ contact: normalizedContact, code, expiresAt }).save();
    }

    // Only increment rate limit after successful send
    limit.count++;
    limit.lastTime = now;
    resendLimits.set(rateKey, limit);

    res.json({ msg: 'OTP sent' });
  } catch (err) {
    console.error(err);
    const status = err.status || 500;
    const message = (err.message && String(err.message)) || (err.msg && String(err.msg)) || 'Server error';
    res.status(status).json({ msg: message });
  }
});

router.post('/verify-register', async (req, res) => {
  const { name, password, code } = req.body;
  let contact = req.body.contact;
  const { countryCode, phone } = req.body;
  if (!name || !(contact || (countryCode && phone)) || !password || !code) return res.status(400).json({ msg: 'All fields required' });

  try {
    let user = await User.findOne({ contact });
    if (user) return res.status(400).json({ msg: 'User exists' });

    if (contact && contact.includes('@')) {
      // Email verify
      const otp = await Otp.findOne({ contact });
      if (!otp || otp.code !== code || otp.expiresAt < Date.now()) {
        return res.status(400).json({ msg: 'Invalid or expired OTP' });
      }
      await Otp.deleteOne({ _id: otp._id });
    } else {
      // Phone verify with Twilio - normalize to E.164 like sendOtp
      if (!client) return res.status(500).json({ msg: 'Twilio not configured' });
      // Build normalized 'to' either from provided contact or from countryCode+phone
      let to;
      if (contact && contact.startsWith('+')) {
        to = contact.trim();
      } else if (countryCode && phone) {
        const cc = String(countryCode).replace(/\D/g, '');
        const digits = String(phone).replace(/\D/g, '');
        const withoutLeadingZero = digits.replace(/^0+/, '');
        to = `+${cc}${withoutLeadingZero}`;
      } else {
        return res.status(400).json({ msg: 'Phone not in E.164; provide countryCode and phone or full E.164 contact' });
      }
      const verification = await client.verify.v2.services(process.env.TWILIO_VERIFY_SID)
        .verificationChecks.create({ to, code });
      if (!verification || verification.status !== 'approved') return res.status(400).json({ msg: 'Invalid OTP' });
      // store normalized contact for consistency
      contact = to;
    }

    user = new User({ name, contact, password });
    await user.save();

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });

    res.json({ token, msg: 'Registered and logged in' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  let { contact, password } = req.body;
  const { countryCode, phone } = req.body;
  if (!(contact || (countryCode && phone)) || !password) return res.status(400).json({ msg: 'All fields required' });

  // normalize for lookup
  if (!contact && countryCode && phone) {
    const cc = String(countryCode).replace(/\D/g, '');
    const digits = String(phone).replace(/\D/g, '');
    const withoutLeadingZero = digits.replace(/^0+/, '');
    contact = `+${cc}${withoutLeadingZero}`;
  }

  try {
    const user = await User.findOne({ contact });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(400).json({ msg: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1d' });

    res.json({ token, msg: 'Logged in' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

// Reset password using OTP (email) or Twilio verify (phone)
router.post('/reset-password', async (req, res) => {
  const { code, newPassword } = req.body;
  let contact = req.body.contact;
  const { countryCode, phone } = req.body;
  if (!(contact || (countryCode && phone)) || !code || !newPassword) return res.status(400).json({ msg: 'All fields required' });

  try {
    // normalize contact for lookup
    if (!contact && countryCode && phone) {
      const cc = String(countryCode).replace(/\D/g, '');
      const digits = String(phone).replace(/\D/g, '');
      const withoutLeadingZero = digits.replace(/^0+/, '');
      contact = `+${cc}${withoutLeadingZero}`;
    }

    const user = await User.findOne({ contact });
    if (!user) return res.status(400).json({ msg: 'User not found' });

    if (contact.includes('@')) {
      const otp = await Otp.findOne({ contact });
      if (!otp || otp.code !== code || otp.expiresAt < Date.now()) {
        return res.status(400).json({ msg: 'Invalid or expired OTP' });
      }
      await Otp.deleteOne({ _id: otp._id });
    } else {
      if (!client) return res.status(500).json({ msg: 'Twilio not configured' });
      // for phone verification, contact is already normalized above
      if (!contact.startsWith('+')) return res.status(400).json({ msg: 'Phone not normalized; provide countryCode and phone or full E.164' });
      const verification = await client.verify.v2.services(process.env.TWILIO_VERIFY_SID)
        .verificationChecks.create({ to: contact, code });
      if (!verification || verification.status !== 'approved') return res.status(400).json({ msg: 'Invalid OTP' });
    }

    // update password
    user.password = newPassword;
    await user.save();

    res.json({ msg: 'Password reset' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
});

module.exports = router;