const nodemailer = require('nodemailer');
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const transporter = (() => {
  // Prefer explicit SMTP host/port (use SendGrid, Mailgun, etc.) configured via env.
  if (process.env.EMAIL_HOST) {
    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT, 10) : 587,
      secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for 587
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      connectionTimeout: 10000,
    });
  }

  if (process.env.EMAIL_SERVICE) {
    return nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      connectionTimeout: 10000,
    });
  }

  // Fallback to Gmail service if no explicit host/service provided (may time out on some hosts)
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    connectionTimeout: 10000,
  });
})();

const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();  // 6 digits

const normalizeToE164 = (input) => {
  // Accept either a full E.164 string (starts with '+'), an email, or an object { countryCode, phone }
  if (typeof input === 'string') {
    const s = input.trim();
    if (s.includes('@')) return { type: 'email', normalized: s };
    if (s.startsWith('+')) return { type: 'phone', normalized: s };
    // Not E.164 and not email
    throw new Error('Phone number is not in E.164 format. Provide full E.164 (e.g. +441234567890) or pass countryCode and phone separately');
  }

  if (input && typeof input === 'object') {
    if (input.contact && typeof input.contact === 'string') {
      return normalizeToE164(input.contact);
    }
    const { countryCode, phone } = input;
    if (!countryCode || !phone) throw new Error('Provide both countryCode and phone for phone verification');
    const cc = String(countryCode).replace(/\D/g, '');
    const digits = String(phone).replace(/\D/g, '');
    const withoutLeadingZero = digits.replace(/^0+/, '');
    return { type: 'phone', normalized: `+${cc}${withoutLeadingZero}` };
  }

  throw new Error('Invalid contact input');
};

const sendOtp = async (input) => {
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);  // 5 min

  // Normalize input and know whether it's email or phone
  const { type, normalized } = normalizeToE164(input);

  if (type === 'email') {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: normalized,
      subject: 'Your Purple Wheel OTP',
      text: `Your verification code is ${code}. It expires in 5 minutes.`,
    };
    await transporter.sendMail(mailOptions);
    return { code, expiresAt, normalizedContact: normalized };
  }

  // Phone flow: call Twilio Verify with a normalized E.164 number
  try {
    console.log('Sending OTP to', normalized);
    await client.verify.v2.services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: normalized, channel: 'sms' });
  } catch (err) {
    console.error('sendOtp error for contact', JSON.stringify(input), err.message || err);
    throw err;
  }

  return { code, expiresAt, normalizedContact: normalized };
};

module.exports = sendOtp;