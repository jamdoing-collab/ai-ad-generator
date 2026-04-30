const attempts = new Map();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.firstAttempt > WINDOW_MS) {
      attempts.delete(key);
    }
  }
}

setInterval(cleanup, 60 * 1000);

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const key = `${ip}:${req.path}`;
  const now = Date.now();

  let entry = attempts.get(key);
  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    entry = { firstAttempt: now, count: 0 };
    attempts.set(key, entry);
  }

  entry.count++;

  if (entry.count > MAX_ATTEMPTS) {
    return res.status(429).json({ code: 429, message: '请求过于频繁，请稍后再试' });
  }

  next();
}

module.exports = rateLimit;
