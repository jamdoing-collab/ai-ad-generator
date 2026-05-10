const express = require('express');
const db = require('../database');
const { normalizePhone, validatePhone } = require('../validators/phone');

const router = express.Router();

// 获取用户信息
router.get('/info', (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) {
    return res.status(404).json({ code: 404, message: '用户不存在' });
  }
  res.json({
    code: 0,
    data: {
      id: user.id,
      username: user.username,
      points: user.points,
      is_admin: user.is_admin,
      invite_code: user.invite_code,
      created_at: user.created_at
    }
  });
});

// 获取邀请信息
router.get('/invite', (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) {
    return res.status(404).json({ code: 404, message: '用户不存在' });
  }

  res.json({
    code: 0,
    data: {
      inviteCode: user.invite_code,
      summary: db.getInviteSummary(req.userId)
    }
  });
});

// 更新用户信息
router.put('/info', (req, res) => {
  try {
    const updateData = req.body;

    if (!updateData || Object.keys(updateData).length === 0) {
      return res.status(400).json({ code: 400, message: '没有要更新的内容' });
    }

    const normalizedUpdate = {};

    if (Object.prototype.hasOwnProperty.call(updateData, 'username')) {
      const newUsername = normalizePhone(updateData.username);
      const phoneError = validatePhone(newUsername);
      if (phoneError) {
        return res.status(400).json({ code: 400, message: phoneError });
      }
      const existing = db.getUserByUsername(newUsername);
      if (existing && existing.id !== req.userId) {
        return res.status(409).json({ code: 409, message: '用户名已被占用' });
      }
      normalizedUpdate.username = newUsername;
    }

    if (Object.keys(normalizedUpdate).length === 0) {
      return res.status(400).json({ code: 400, message: '没有可更新的合法字段' });
    }

    db.updateUserProfile(req.userId, normalizedUpdate);

    const user = db.getUserById(req.userId);
    if (!user) {
      return res.status(500).json({ code: 500, message: '更新后获取用户信息失败' });
    }
    res.json({
      code: 0,
      data: {
        id: user.id,
        username: user.username,
        points: user.points,
        is_admin: user.is_admin,
        invite_code: user.invite_code
      }
    });
  } catch (err) {
    console.error('[更新用户信息错误]', err);
    res.status(500).json({ code: 500, message: '更新失败' });
  }
});

// 获取点数
router.get('/points', (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) {
    return res.status(404).json({ code: 404, message: '用户不存在' });
  }
  res.json({ code: 0, data: { points: user.points } });
});

// 获取点数变化记录
router.get('/points/history', (req, res) => {
  const history = db.getPointHistory(req.userId);
  res.json({ code: 0, data: history });
});

module.exports = router;
