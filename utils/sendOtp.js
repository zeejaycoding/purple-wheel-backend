const nodemailer = require('nodemailer');
const { Resend } = (() => {
  try { return require('resend'); } catch (e) { return {}; }
})();
let sendgrid = null;
if (process.env.SENDGRID_API_KEY) {
  try { sendgrid = require('@sendgrid/mail'); sendgrid.setApiKey(process.env.SENDGRID_API_KEY); } catch (e) { console.warn('SendGrid package not installed or failed to load'); }
}
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const resend = (Resend && process.env.RESEND_API_KEY) ? new Resend(process.env.RESEND_API_KEY) : null;

// SMTP transporter fallback (used if Resend is not configured)
const transporter = (() => {
  try {
    if (process.env.EMAIL_HOST) {
      return nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT ? parseInt(process.env.EMAIL_PORT, 10) : 587,
        secure: process.env.EMAIL_SECURE === 'true',
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

    // Minimal Gmail fallback (may be blocked on some hosts)
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      return nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        connectionTimeout: 10000,
      });
    }
  } catch (e) {
    console.warn('Failed to create transporter fallback', e.message || e);
  }
  return null;
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
    // Prefer SendGrid Web API if configured
    if (sendgrid) {
      try {
        await sendgrid.send({
          to: normalized,
          from: process.env.SENDGRID_SENDER || process.env.EMAIL_USER || process.env.RESEND_FROM || 'onboarding@resend.dev',
          subject: mailOptions.subject,
          text: mailOptions.text,
          html: `<p>Your verification code is <strong>${code}</strong>. It expires in 5 minutes.</p>`,
        });
        return { code, expiresAt, normalizedContact: normalized };
      } catch (e) {
        console.error('SendGrid send failed, falling back:', e.message || e);
      }
    }

    // Next prefer Resend API if configured (avoids SMTP port blocking)
    if (resend) {
      try {
        await resend.emails.send({
          from: process.env.RESEND_FROM || process.env.EMAIL_USER || 'onboarding@resend.dev',
          to: normalized,
          subject: mailOptions.subject,
          html: `<p>Your verification code is <strong>${code}</strong>. It expires in 5 minutes.</p>`,
          text: mailOptions.text,
        });
        return { code, expiresAt, normalizedContact: normalized };
      } catch (e) {
        console.error('Resend send failed, falling back to SMTP:', e.message || e);
      }
    }

    if (transporter) {
      await transporter.sendMail(mailOptions);
      return { code, expiresAt, normalizedContact: normalized };
    }

    throw new Error('No email provider configured: set SENDGRID_API_KEY, RESEND_API_KEY, or SMTP env vars (EMAIL_HOST/EMAIL_SERVICE and EMAIL_USER/EMAIL_PASS)');
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