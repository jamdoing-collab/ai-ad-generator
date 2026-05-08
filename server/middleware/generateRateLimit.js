// 内存态生成频率限制：仅对当前进程有效，重启后计数会清空。
const userAttempts = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 3;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of userAttempts) {
    if (now - entry.firstAttempt > WINDOW_MS) userAttempts.delete(key);
  }
}, 30 * 1000);

function generateRateLimit(req, res, next) {
  const key = String(req.userId);
  const now = Date.now();
  let entry = userAttempts.get(key);

  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    entry = { firstAttempt: now, count: 0 };
    userAttempts.set(key, entry);
  }

  entry.count++;
  if (entry.count > MAX_PER_WINDOW) {
    return res.status(429).json({ code: 429, message: '生成过于频繁，请稍后再试' });
  }
  next();
}

function refundAttempt(userId) {
  const entry = userAttempts.get(String(userId));
  if (entry && entry.count > 0) entry.count--;
}

module.exports = generateRateLimit;
module.exports.refundAttempt = refundAttempt;
