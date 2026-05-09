const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;

// 部署在 Railway / 反向代理后时，信任第一层代理，确保 req.ip 可用于限速与日志。
app.set('trust proxy', 1);

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
app.use(express.static(path.join(__dirname, '../public')));

// 引入数据库
const db = require('./database');

async function startServer() {
  if (!config.JWT_SECRET) {
    throw new Error('缺少 JWT_SECRET 环境变量');
  }
  if (config.NODE_ENV === 'production' && config.ALLOWED_ORIGINS.length === 0) {
    throw new Error('生产环境必须配置 ALLOWED_ORIGINS，避免开放任意跨域来源');
  }

  // 初始化数据库
  await db.initDatabase();
  db.setConfiguredAdmins(config.ADMIN_USERNAMES);

  console.log('[启动配置] ALLOWED_ORIGINS =', JSON.stringify(config.ALLOWED_ORIGINS));
  console.log('[启动配置] ADMIN_BOOTSTRAP_PASSWORD =', process.env.ADMIN_BOOTSTRAP_PASSWORD ? '已设置' : '未设置');

  const bootstrapAdminUsername = (process.env.ADMIN_BOOTSTRAP_USERNAME || 'jamdo').trim();
  const bootstrapAdminPassword = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '').trim();
  const bootstrapForceReset = String(process.env.ADMIN_BOOTSTRAP_FORCE_RESET || '').trim().toLowerCase() === 'true';
  if (bootstrapAdminPassword) {
    const adminUser = db.getUserByUsername(bootstrapAdminUsername);
    const hashedPassword = await bcrypt.hash(bootstrapAdminPassword, 10);
    if (adminUser) {
      db.updateUserAdminProfile(adminUser.id, { is_admin: true });
      if (bootstrapForceReset) {
        db.updateUserPassword(adminUser.id, hashedPassword);
        console.log(`[管理员] 已强制重置账号 ${bootstrapAdminUsername} 的启动密码`);
      } else {
        console.log(`[管理员] 账号 ${bootstrapAdminUsername} 已存在，跳过密码重置`);
      }
    } else {
      db.createUser(bootstrapAdminUsername, hashedPassword, { points: 100, isAdmin: true });
      console.log(`[管理员] 已创建账号 ${bootstrapAdminUsername} 并设置启动密码`);
    }
  }

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

async function resolveImageFilePath(req, { requireOwnership }) {
  const imageId = parseInt(req.params.id);
  if (!imageId) return { error: { status: 400, body: { code: 400, message: '无效的图片ID' } } };

  const image = db.getImageById(imageId);
  if (!image) return { error: { status: 404, body: { code: 404, message: '图片不存在' } } };

  if (requireOwnership && image.user_id !== req.userId) {
    return { error: { status: 403, body: { code: 403, message: '无权访问' } } };
  }

  const index = parseInt(req.query.index) || 0;
  const imagePath = image.image_paths[index];
  if (!imagePath) return { error: { status: 404, body: { code: 404, message: '图片不存在' } } };

  const fullPath = path.resolve(__dirname, '../uploads', imagePath.replace(/^\/uploads\//, ''));
  if (!fullPath.startsWith(path.resolve(__dirname, '../uploads') + path.sep)) {
    return { error: { status: 403, body: { code: 403, message: '非法图片路径' } } };
  }

  return { fullPath };
}

async function sendThumbResponse(req, res, { cacheControl, errorLabel, requireOwnership }) {
  try {
    const { fullPath, error } = await resolveImageFilePath(req, { requireOwnership });
    if (error) return res.status(error.status).json(error.body);

    const thumbBuffer = await sharp(fullPath)
      .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', cacheControl);
    res.send(thumbBuffer);
  } catch (err) {
    console.error(`[${errorLabel}]`, err.message);
    res.status(500).json({ code: 500, message: '获取缩略图失败' });
  }
}

async function sendImageResponse(req, res, { cacheControl, errorLabel, requireOwnership }) {
  try {
    const { fullPath, error } = await resolveImageFilePath(req, { requireOwnership });
    if (error) return res.status(error.status).json(error.body);

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', cacheControl);
    res.sendFile(fullPath);
  } catch (err) {
    console.error(`[${errorLabel}]`, err.message);
    res.status(500).json({ code: 500, message: '获取图片失败' });
  }
}

// 缩略图（需登录，仅可访问自己图片）
const thumbRouter = express.Router();
thumbRouter.get('/:id', auth, async (req, res) => {
  return sendThumbResponse(req, res, {
    cacheControl: 'private, max-age=604800',
    errorLabel: '缩略图错误',
    requireOwnership: true
  });
});
app.use('/thumb', thumbRouter);

const publicThumbRouter = express.Router();
publicThumbRouter.get('/:id', async (req, res) => {
  return sendThumbResponse(req, res, {
    cacheControl: 'public, max-age=604800',
    errorLabel: '公开缩略图错误',
    requireOwnership: false
  });
});
app.use('/share/thumb', publicThumbRouter);

// 完整图片（需登录，仅可访问自己图片）
const imageRouter = express.Router();
imageRouter.get('/:id', auth, async (req, res) => {
  return sendImageResponse(req, res, {
    cacheControl: 'private, max-age=86400',
    errorLabel: '图片错误',
    requireOwnership: true
  });
});
app.use('/image', imageRouter);

const publicImageRouter = express.Router();
publicImageRouter.get('/:id', async (req, res) => {
  return sendImageResponse(req, res, {
    cacheControl: 'public, max-age=86400',
    errorLabel: '公开图片错误',
    requireOwnership: false
  });
});
app.use('/share/image', publicImageRouter);

// API 路由 - 支付回调公开，其他需要登录
app.use('/api/auth', express.json({ limit: '1mb' }), rateLimit, authRoutes);
app.use('/api/config', configRoutes);
app.use('/api/user', express.json({ limit: '1mb' }), auth, userRoutes);
app.use('/api/generate', express.json({ limit: '10mb' }), auth, generateRateLimit, generateRoutes);
app.use('/api/admin', express.json({ limit: '5mb' }), adminRoutes);
  app.get('/api/payment/packages', (req, res) => {
    const packages = Object.entries(config.RECHARGE_PACKAGES).map(([id, pkg]) => ({
      id,
      price: (pkg.price / 100).toFixed(2),
      priceCent: pkg.price,
      points: pkg.points
    }));
    res.json({ code: 0, data: packages });
  });
  app.use('/api/payment', express.json({ limit: '1mb' }), auth, paymentRoutes);
  
  // 首页
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  });

  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
  });
  
  // 错误处理
  app.use((err, req, res, _next) => {
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
