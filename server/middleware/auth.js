const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../database');

function verifyWithFallback(token) {
  const secrets = [config.JWT_SECRET, ...config.JWT_FALLBACK_SECRETS].filter(Boolean);

  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret);
    } catch {
    }
  }

  throw new Error('invalid token');
}

const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    || (req.query && req.query.token) || null;
  
  if (!token) {
    return res.status(401).json({ code: 401, message: '请先登录' });
  }

  try {
    const decoded = verifyWithFallback(token);
    const session = db.getSessionByToken(token);
    if (!session || session.user_id !== decoded.userId) {
      return res.status(401).json({ code: 401, message: '登录已失效，请重新登录' });
    }

    req.userId = decoded.userId;
    req.token = token;
    next();
  } catch {
    return res.status(401).json({ code: 401, message: '登录已过期，请重新登录' });
  }
};

module.exports = auth;
