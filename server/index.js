const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;

// 安全头
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// 确保目录存在
const uploadDir = path.join(__dirname, '../uploads');
const tempUploadDir = path.join(uploadDir, 'temp');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(tempUploadDir)) fs.mkdirSync(tempUploadDir, { recursive: true });

// CORS 配置
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (config.ALLOWED_ORIGINS.length === 0 || config.ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, '../public')));

// 引入数据库
const db = require('./database');

async function startServer() {
  if (!config.JWT_SECRET) {
    throw new Error('缺少 JWT_SECRET 环境变量');
  }

  // 初始化数据库
  await db.initDatabase();
  db.setConfiguredAdmins(config.ADMIN_USERNAMES);
  console.log('[数据库] 已就绪');
  
  // 引入路由（需要等数据库初始化完成后）
  const authRoutes = require('./routes/auth');
  const userRoutes = require('./routes/user');
  const generateRoutes = require('./routes/generate');
  const paymentRoutes = require('./routes/payment');
  const adminRoutes = require('./routes/admin');
  const configRoutes = require('./routes/config');
  const auth = require('./middleware/auth');
  const rateLimit = require('./middleware/rateLimit');
  const generateRateLimit = require('./middleware/generateRateLimit');

  // API 路由 - 支付回调公开，其他需要登录
  app.use('/api/auth', express.json({ limit: '1mb' }), rateLimit, authRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/user', express.json({ limit: '1mb' }), auth, userRoutes);
  app.use('/api/generate', express.json({ limit: '10mb' }), auth, generateRateLimit, generateRoutes);
  app.use('/api/admin', express.json({ limit: '5mb' }), adminRoutes);
  app.use('/api/payment', express.json({ limit: '1mb' }), auth, paymentRoutes);
  
  // 首页
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
  });
  
  // 错误处理
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ code: 500, message: '服务器错误' });
  });
  
  // 启动服务
  app.listen(PORT, () => {
    console.log(`
  ╔═══════════════════════════════════════════════════╗
  ║ AI 广告设计服务已启动                              ║
  ║ 访问地址: http://localhost:${PORT}                    ║
  ╚═══════════════════════════════════════════════════╝
  `);
  });

  // 定期清理过期 session（每1小时）
  setInterval(() => {
    const deleted = db.cleanExpiredSessions();
    if (deleted > 0) console.log(`[清理] 已删除 ${deleted} 个过期session`);
  }, 3600000);

  // 进程退出时刷新数据库
  function gracefulShutdown(signal) {
    console.log(`[${signal}] 正在关闭服务...`);
    db.flushDatabase();
    process.exit(0);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

startServer().catch(err => {
  console.error('[启动失败]', err);
  process.exit(1);
});

module.exports = app;
