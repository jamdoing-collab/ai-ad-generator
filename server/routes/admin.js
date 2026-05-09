const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const db = require('../database');
const admin = require('../middleware/admin');
const { validatePassword } = require('../validators/password');
const { normalizePhone, validatePhone } = require('../validators/phone');

const router = express.Router();

router.use(admin);

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}********${value.slice(-4)}`;
}

router.get('/stats', (req, res) => {
  res.json({ code: 0, data: db.getAdminStats() });
});

router.get('/settings', (req, res) => {
  const openaiApiKey = db.getSetting('openai_api_key');
  const openaiBaseUrl = db.getSetting('openai_base_url');
  const imageHostToken = db.getSetting('image_host_token');
  res.json({
    code: 0,
    data: {
      hasOpenAiKey: Boolean(openaiApiKey),
      maskedOpenAiKey: maskSecret(openaiApiKey),
      openaiBaseUrl: openaiBaseUrl || '',
      hasImageHostToken: Boolean(imageHostToken),
      maskedImageHostToken: maskSecret(imageHostToken)
    }
  });
});

router.put('/settings', (req, res) => {
  try {
    if (Object.prototype.hasOwnProperty.call(req.body, 'openaiBaseUrl')) {
      const openaiBaseUrl = String(req.body.openaiBaseUrl || '').trim();
      if (openaiBaseUrl) {
        db.setSetting('openai_base_url', openaiBaseUrl);
      } else {
        db.deleteSetting('openai_base_url');
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'openaiApiKey')) {
      const openaiApiKey = String(req.body.openaiApiKey || '').trim();
      if (!openaiApiKey) {
        db.deleteSetting('openai_api_key');
      } else {
        db.setSetting('openai_api_key', openaiApiKey);
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'imageHostToken')) {
      const imageHostToken = String(req.body.imageHostToken || '').trim();
      if (imageHostToken) {
        db.setSetting('image_host_token', imageHostToken);
      } else {
        db.deleteSetting('image_host_token');
      }
    }

    res.json({ code: 0, message: '设置已更新' });
  } catch (err) {
    console.error('[管理员更新设置错误]', err);
    res.status(500).json({ code: 500, message: '更新设置失败' });
  }
});

router.get('/users', (req, res) => {
  const users = db.listUsersWithStats().map(user => ({
    id: user.id,
    username: user.username,
    points: user.points,
    is_admin: Boolean(user.is_admin),
    generate_count: user.generate_count,
    order_count: user.order_count,
    created_at: user.created_at
  }));

  res.json({ code: 0, data: users });
});

router.post('/users', async (req, res) => {
  try {
  const { username, password, points = 0, is_admin = false } = req.body;

  if (!username || !password) {
    return res.status(400).json({ code: 400, message: '用户名和密码不能为空' });
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return res.status(400).json({ code: 400, message: passwordError });
  }

  const normalizedUsername = normalizePhone(username);
  const phoneError = validatePhone(normalizedUsername);
  if (phoneError) {
    return res.status(400).json({ code: 400, message: phoneError });
  }

  if (db.getUserByUsername(normalizedUsername)) {
    return res.status(409).json({ code: 409, message: '用户名已存在' });
  }

  const parsedPoints = Number(points);
  if (!Number.isInteger(parsedPoints) || parsedPoints < 0) {
    return res.status(400).json({ code: 400, message: '点数必须是大于等于 0 的整数' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = db.createUser(normalizedUsername, hashedPassword, {
    points: parsedPoints,
    isAdmin: Boolean(is_admin)
  });

  res.json({
    code: 0,
    data: {
      id: user.id,
      username: user.username,
      points: user.points,
      is_admin: Boolean(user.is_admin)
    }
  });
  } catch (err) {
    console.error('[管理员创建用户错误]', err);
    res.status(500).json({ code: 500, message: '创建用户失败' });
  }
});

router.put('/users/:id', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const existingUser = db.getUserById(userId);

    if (!existingUser) {
      return res.status(404).json({ code: 404, message: '用户不存在' });
    }

  const updates = {};

  if (Object.prototype.hasOwnProperty.call(req.body, 'points')) {
    const parsedPoints = Number(req.body.points);
    if (!Number.isInteger(parsedPoints) || parsedPoints < 0) {
      return res.status(400).json({ code: 400, message: '点数必须是大于等于 0 的整数' });
    }
    updates.points = parsedPoints;
    const diff = parsedPoints - existingUser.points;
    if (diff !== 0) {
      db.logPointChange(userId, 'admin_adjust', diff, '管理员调整点数');
    }
  }

    if (Object.prototype.hasOwnProperty.call(req.body, 'is_admin')) {
      if (existingUser.id === req.userId && !req.body.is_admin) {
        return res.status(400).json({ code: 400, message: '不能取消自己的管理员权限' });
      }
      updates.is_admin = Boolean(req.body.is_admin);
    }

    const updatedUser = db.updateUserAdminProfile(userId, updates) || existingUser;

    if (req.body.password) {
      const passwordError = validatePassword(req.body.password);
      if (passwordError) {
        return res.status(400).json({ code: 400, message: passwordError });
      }

      const hashedPassword = await bcrypt.hash(req.body.password, 10);
      db.updateUserPassword(userId, hashedPassword);
    }

  res.json({
    code: 0,
    data: {
      id: updatedUser.id,
      username: updatedUser.username,
      points: updatedUser.points,
      is_admin: Boolean(updatedUser.is_admin),
      created_at: updatedUser.created_at
    }
  });
  } catch (err) {
    console.error('[管理员更新用户错误]', err);
    res.status(500).json({ code: 500, message: '更新用户失败' });
  }
});

router.delete('/users/:id', (req, res) => {
  try {
    const userId = Number(req.params.id);
    const existingUser = db.getUserById(userId);

    if (!existingUser) {
      return res.status(404).json({ code: 404, message: '用户不存在' });
    }

    if (existingUser.id === req.userId) {
      return res.status(400).json({ code: 400, message: '不能删除当前登录管理员' });
    }

    // 清理该用户的图片文件
  const uploadsRoot = path.resolve(__dirname, '../../uploads');
  let offset = 0;
  const BATCH = 1000;
  let userImages;
  do {
    userImages = db.getUserImages(userId, BATCH, offset);
    for (const img of userImages) {
      const paths = img.image_paths || [];
      for (const p of paths) {
        const abs = path.resolve(uploadsRoot, p.replace(/^\/uploads\//, ''));
        if (!abs.startsWith(uploadsRoot + path.sep)) continue;
        try { fs.unlinkSync(abs); } catch {}
      }
    }
    offset += BATCH;
  } while (userImages.length === BATCH);

    db.deleteUserById(userId);
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    console.error('[管理员删除用户错误]', err);
    res.status(500).json({ code: 500, message: '删除用户失败' });
  }
});

module.exports = router;
