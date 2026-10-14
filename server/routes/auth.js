import express from 'express';
import { createUser, findUserByEmail } from '../lib/db.js';
import { createToken, hashPassword, publicUser, requireAuth, verifyPassword } from '../lib/auth.js';
import { rateLimit } from '../lib/rateLimit.js';

const router = express.Router();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many attempts. Please wait a few minutes.' });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = v => (typeof v === 'string' ? v.trim() : '');

router.post('/auth/signup', authLimiter, async (req, res) => {
  const email = clean(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const phone = clean(req.body?.phone);
  const age = Number(req.body?.age);
  const name = clean(req.body?.name) || email.split('@')[0];

  if (!EMAIL_RE.test(email)) return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
  if (!phone) return res.status(400).json({ success: false, error: 'Phone number is required.' });
  if (!Number.isInteger(age) || age < 1 || age > 120) return res.status(400).json({ success: false, error: 'Please enter a valid age.' });

  if (await findUserByEmail(email)) {
    return res.status(409).json({ success: false, error: 'An account with this email already exists. Please sign in.' });
  }
  try {
    const user = await createUser({ email, name, phone, age, passwordHash: await hashPassword(password) });
    res.status(201).json({ success: true, token: createToken(user), user: publicUser(user) });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists. Please sign in.' });
    }
    throw err;
  }
});

router.post('/auth/login', authLimiter, async (req, res) => {
  const email = clean(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = email ? await findUserByEmail(email) : null;
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ success: false, error: 'Invalid email or password.' });
  }
  res.json({ success: true, token: createToken(user), user: publicUser(user) });
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: publicUser(req.user) });
});

export default router;
