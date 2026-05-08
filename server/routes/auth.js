const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../database');
const { validatePassword } = require('../validators/password');
const { normalizePhone, validatePhone } = require('../validators/phone');

const router = express.Router();

// 按用户名的登录限速（内存态；单进程生效，重启后清零）
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function checkLoginRateLimit(username) {
  const key = username.toLowerCase();
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { firstAttempt: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

function clearLoginAttempts(username) {
  loginAttempts.delete(username.toLowerCase());
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.firstAttempt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}, 60 * 1000);

// 注册
router.post('/register', async (req, res) => {
  try {
  const { username, password, inviteCode } = req.body;

  if (!username || !password) {
    return res.status(400).json({ code: 400, message: '用户名和密码不能为空' });
  }

  const normalizedUsername = normalizePhone(username);
  const phoneError = validatePhone(normalizedUsername);
  if (phoneError) {
    return res.status(400).json({ code: 400, message: phoneError });
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    return res.status(400).json({ code: 400, message: passwordError });
  }

  // 检查用户是否已存在
  const existingUser = db.getUserByUsername(normalizedUsername);
  if (existingUser) {
    return res.status(409).json({ code: 409, message: '用户名已存在' });
  }

  let inviter = null;
  const normalizedInviteCode = String(inviteCode || '').trim();
  if (normalizedInviteCode) {
    inviter = db.getUserByInviteCode(normalizedInviteCode);
  }

  // 创建用户
  const hashedPassword = await bcrypt.hash(password, 10);
  const inviteBonus = inviter ? config.INVITE_NEW_USER_POINTS : 0;
  const user = db.createUser(normalizedUsername, hashedPassword, {
    points: config.NEW_USER_POINTS + inviteBonus,
    referredByUserId: inviter?.id
  });
  db.logPointChange(user.id, 'gift', config.NEW_USER_POINTS, '新用户礼包');
  if (inviteBonus > 0) {
    db.logPointChange(user.id, 'invite_new_user_bonus', inviteBonus, '通过邀请注册奖励');
  }

  const token = jwt.sign(
    { userId: user.id },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN }
  );

  // 保存 session
  db.createSession(user.id, token);

  res.json({
    code: 0,
    data: {
      token,
      user: {
        id: user.id,
        username: user.username,
        points: user.points,
        is_admin: Boolean(user.is_admin)
      }
    }
  });
 } catch (err) {
    console.error('[注册错误]', err);
    res.status(500).json({ code: 500, message: '注册失败' });
  }
});

// 登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ code: 400, message: '用户名和密码不能为空' });
    }

    const normalizedUsername = normalizePhone(username);
    const isPhoneLogin = /^1\d{10}$/.test(normalizedUsername);
    if (!isPhoneLogin && normalizedUsername.length < 2) {
      return res.status(400).json({ code: 400, message: '用户名长度需在2个字符以上' });
    }
    if (password.length > 64) {
        return res.status(400).json({ code: 400, message: '密码长度超出限制' });
    }

    // 按用户名限速
    if (!checkLoginRateLimit(normalizedUsername)) {
      return res.status(429).json({ code: 429, message: '登录尝试过于频繁，请15分钟后再试' });
    }

    // 查找用户：手机号优先，兼容旧管理员账号（如 jamdo）
    const user = db.getUserByUsername(normalizedUsername);
    if (!user) {
      await bcrypt.compare(password, '$2a$10$invalidhashfortimingonly000000000000000000000000000000');
      return res.status(401).json({ code: 401, message: '用户名或密码错误' });
    }

    // 验证密码
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ code: 401, message: '用户名或密码错误' });
    }

    // 登录成功，清除该用户名的失败计数
    clearLoginAttempts(normalizedUsername);
    
    // 使该用户的所有旧session失效，防止session固定攻击
    db.deleteSessionByUserId(user.id);
    
    // 生成 token
    const token = jwt.sign(
      { userId: user.id },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN }
    );

    // 保存 session
    db.createSession(user.id, token);

  res.json({
    code: 0,
    data: {
      token,
      user: {
        id: user.id,
        username: user.username,
        points: user.points,
        is_admin: user.is_admin
      }
    }
  });
  } catch (err) {
    console.error('[登录错误]', err);
    res.status(500).json({ code: 500, message: '登录失败' });
  }
});

// 登出
router.post('/logout', (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token) {
    db.deleteSessionByToken(token);
  }
  res.json({ code: 0, message: '已登出' });
});

module.exports = router;
