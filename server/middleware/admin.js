const auth = require('./auth');
const db = require('../database');

function admin(req, res, next) {
  auth(req, res, () => {
    const user = db.getUserById(req.userId);
    if (!user || !user.is_admin) {
      return res.status(403).json({ code: 403, message: '仅管理员可访问' });
    }

    req.adminUser = user;
    next();
  });
}

module.exports = admin;
