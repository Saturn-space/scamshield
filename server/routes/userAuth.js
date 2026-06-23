const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'scamshield2024superSecretKey123';
const JWT_EXPIRES = '30d';

// ─── POST /api/auth/signup ────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { username, email, password, full_name } = req.body;

    console.log('📝 Signup attempt:', username, email);

    if (!username || !email || !password) {
      return res.status(400).json({ ok: false, err: 'Username, email, and password are required.' });
    }
    if (username.length < 3) {
      return res.status(400).json({ ok: false, err: 'Username must be at least 3 characters.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, err: 'Password must be at least 8 characters.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, err: 'Invalid email address.' });
    }

    const existing = await User.findOne({
      $or: [{ username }, { email: email.toLowerCase() }]
    });
    if (existing) {
      const field = existing.username === username ? 'Username' : 'Email';
      return res.status(400).json({ ok: false, err: `${field} already exists.` });
    }

    const user = new User({
      username,
      email: email.toLowerCase(),
      password_hash: password,  // will be hashed by pre-save hook
      full_name: full_name || username
    });
    await user.save();

    console.log('✅ User created:', user.username, 'hash length:', user.password_hash.length);

    const token = jwt.sign(
      { user_id: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        full_name: user.full_name
      }
    });
  } catch (error) {
    console.error('❌ Signup error:', error);
    res.status(500).json({ ok: false, err: 'Failed to create account: ' + error.message });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    console.log('🔐 Login attempt:', username, 'password length:', password?.length);

    if (!username || !password) {
      return res.status(400).json({ ok: false, err: 'Username and password are required.' });
    }

    // Find user by username OR email
    const user = await User.findOne({
      $or: [
        { username: username },
        { email: username.toLowerCase() }
      ]
    });

    if (!user) {
      console.log('❌ User not found:', username);
      return res.status(401).json({ ok: false, err: 'Invalid username or password.' });
    }

    console.log('✅ User found:', user.username);
    console.log('🔑 Stored hash starts with:', user.password_hash.substring(0, 10));

    // Compare password
    const isMatch = await user.comparePassword(password);

    console.log('🔍 Password match:', isMatch);

    if (!isMatch) {
      return res.status(401).json({ ok: false, err: 'Invalid username or password.' });
    }

    // Update last login
    user.last_login = new Date();
    await user.save();

    // Generate JWT
    const token = jwt.sign(
      { user_id: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    console.log('✅ Login successful for:', user.username);

    res.json({
      ok: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        full_name: user.full_name
      }
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ ok: false, err: 'Login failed: ' + error.message });
  }
});

module.exports = router;