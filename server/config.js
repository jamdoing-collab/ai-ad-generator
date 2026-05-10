// 环境变量配置
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

function requirePositiveInt(envKey, defaultValue) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') return defaultValue;

  if (!/^[1-9]\d*$/.test(raw)) {
    console.warn(`[配置警告] ${envKey} 值无效（"${raw}"），使用默认值 ${defaultValue}`);
    return defaultValue;
  }

  return Number(raw);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const inferredPublicOrigin = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${String(process.env.RAILWAY_PUBLIC_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
  : '';

const finalAllowedOrigins = Array.from(new Set([
  ...allowedOrigins,
  publicBaseUrl,
  inferredPublicOrigin
].filter(Boolean)));

const jwtFallbackSecrets = (process.env.JWT_FALLBACK_SECRETS || '').split(',').map(item => item.trim()).filter(Boolean);

module.exports = {
  // 服务器配置
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // CORS 配置
  ALLOWED_ORIGINS: finalAllowedOrigins,
  
  // OpenAI 配置
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-image-2',

  // 公网可访问的基础 URL（用于参考图 URL 构造，留空则从请求头推断）
  PUBLIC_BASE_URL: publicBaseUrl,

  // 图床 API Token（imgbb）
  IMAGE_HOST_TOKEN: process.env.IMAGE_HOST_TOKEN || '',
  
  // JWT 配置
  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRES_IN: '7d',
  // JWT_FALLBACK_SECRETS 仅用于兼容旧token，生产环境应为空
  JWT_FALLBACK_SECRETS: jwtFallbackSecrets,
  
  // 管理员用户名（权威来源，启动时自动同步权限）
  ADMIN_USERNAMES: (process.env.ADMIN_USERNAMES || '').split(',').map(item => item.trim()).filter(Boolean),
  
  // 点数配置
  NEW_USER_POINTS: requirePositiveInt('NEW_USER_POINTS', 10),
  POINTS_PER_GENERATE: requirePositiveInt('POINTS_PER_GENERATE', 1),
  POINTS_PER_GENERATE_HD: requirePositiveInt('POINTS_PER_GENERATE_HD', 2),
  POINTS_PER_GENERATE_4K: requirePositiveInt('POINTS_PER_GENERATE_4K', 3),

  // 邀请奖励配置
  INVITE_NEW_USER_POINTS: requirePositiveInt('INVITE_NEW_USER_POINTS', 2),
  INVITE_FIRST_GENERATE_POINTS: requirePositiveInt('INVITE_FIRST_GENERATE_POINTS', 2),
  
  // 充值套餐（价格：分，点数）
  RECHARGE_PACKAGES: {
    pkg_10: { price: 900, points: 10 },
    pkg_50: { price: 3900, points: 50 },
    pkg_100: { price: 6900, points: 100 }
  }
};
