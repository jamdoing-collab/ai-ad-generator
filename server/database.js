const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '../data/ad-generator.db');

let db = null;

const crypto = require('crypto');

const config = require('./config');
const SETTINGS_ENCRYPT_KEY = config.JWT_SECRET;
if (!SETTINGS_ENCRYPT_KEY) {
  console.error('[数据库] 错误：缺少 JWT_SECRET 环境变量，无法加密敏感设置');
  process.exit(1);
}
const SETTINGS_ENCRYPT_PREFIX = 'enc:';

function encryptValue(plaintext) {
  if (!plaintext) return plaintext;
  const key = crypto.createHash('sha256').update(SETTINGS_ENCRYPT_KEY).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return SETTINGS_ENCRYPT_PREFIX + iv.toString('hex') + ':' + tag + ':' + encrypted;
}

function decryptValue(ciphertext) {
  if (!ciphertext || !ciphertext.startsWith(SETTINGS_ENCRYPT_PREFIX)) return ciphertext;
  try {
    // 兼容旧格式 aes-256-cbc（iv:密文）和新格式 aes-256-gcm（iv:tag:密文）
    const raw = ciphertext.slice(SETTINGS_ENCRYPT_PREFIX.length);
    const parts = raw.split(':');
    const key = crypto.createHash('sha256').update(SETTINGS_ENCRYPT_KEY).digest();

    if (parts.length === 3) {
      // aes-256-gcm
      const iv = Buffer.from(parts[0], 'hex');
      const tag = Buffer.from(parts[1], 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(parts[2], 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }

    if (parts.length === 2) {
      // 旧格式 aes-256-cbc，解密后自动升级为 gcm
      const iv = Buffer.from(parts[0], 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(parts[1], 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }

    return ciphertext;
  } catch (err) {
    console.error('[数据库] 解密设置失败:', err.message);
    return ciphertext;
  }
}

const SENSITIVE_SETTINGS = ['openai_api_key', 'openai_base_url', 'image_host_token'];

const ALLOWED_TABLES = ['users', 'sessions', 'images', 'point_changes', 'orders', 'settings'];

function hasColumn(tableName, columnName) {
  if (!ALLOWED_TABLES.includes(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  const result = db.exec(`PRAGMA table_info("${tableName}")`);
  const columns = result[0]?.values || [];
  return columns.some(column => column[1] === columnName);
}

function ensureUserAdminColumn() {
  if (!hasColumn('users', 'points')) {
    db.run('ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0');
    db.run('UPDATE users SET points = 0 WHERE points IS NULL');
  }

  if (!hasColumn('users', 'created_at')) {
    db.run('ALTER TABLE users ADD COLUMN created_at TEXT');
    db.run('UPDATE users SET created_at = datetime("now") WHERE created_at IS NULL');
  }

  if (!hasColumn('users', 'updated_at')) {
    db.run('ALTER TABLE users ADD COLUMN updated_at TEXT');
    db.run('UPDATE users SET updated_at = datetime("now") WHERE updated_at IS NULL');
  }

  if (!hasColumn('users', 'is_admin')) {
    db.run('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
  }
}

async function initDatabase() {
  const SQL = await initSqlJs();
  
  // 尝试读取已存在的数据库
  let data = null;
  if (fs.existsSync(dbPath)) {
    data = fs.readFileSync(dbPath);
  }
  
  db = new SQL.Database(data);
  
  // 创建表
  db.run(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  points INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)
  `);
  ensureUserAdminColumn();
  
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  db.run(`
  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    scene TEXT NOT NULL,
    prompt TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    image_paths TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS point_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance INTEGER NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      package_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      points INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      pay_info TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_images_user_id ON images(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_point_changes_user_id ON point_changes(user_id)');

  // 迁移：旧表列名为 image_urls，新代码期望 image_paths
  const cols = db.exec("PRAGMA table_info(images)");
  if (cols.length && cols[0].values.some(c => c[1] === 'image_urls' && !cols[0].values.some(c2 => c2[1] === 'image_paths'))) {
    console.log('[数据库] 迁移 images.image_urls → image_paths ...');
    db.run('ALTER TABLE images RENAME COLUMN image_urls TO image_paths');
    // 清除旧的 base64 数据（不可用且占空间）
    db.run("UPDATE images SET image_paths = '[]' WHERE image_paths NOT LIKE '/%'");
    saveDatabaseSync();
  }

  // 迁移：删除旧 images 表 dpi 列（SQLite 需重建表）
  if (cols.length && cols[0].values.some(c => c[1] === 'dpi')) {
    console.log('[数据库] 迁移 images 表：删除废弃 dpi 列 ...');
    db.run('ALTER TABLE images RENAME TO images_old');
    db.run(`
      CREATE TABLE images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        scene TEXT NOT NULL,
        prompt TEXT NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        image_paths TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    const newCols = cols[0].values.filter(c => c[1] !== 'dpi').map(c => c[1]).join(', ');
    db.run(`INSERT INTO images (${newCols}) SELECT ${newCols} FROM images_old`);
    db.run('DROP TABLE images_old');
    db.run('CREATE INDEX IF NOT EXISTS idx_images_user_id ON images(user_id)');
    saveDatabaseSync();
  }

  saveDatabaseSync();
  console.log('[数据库] 初始化完成');
}

let saveTimer = null;
const SAVE_DEBOUNCE_MS = 2000;

function saveDatabase() {
  if (!db) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(dbPath, buffer);
    } catch (err) {
      console.error('[数据库] 持久化失败:', err.message);
    }
  }, SAVE_DEBOUNCE_MS);
}

function saveDatabaseSync() {
  if (!db) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const data = db.export();
  const buffer = Buffer.from(data);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(dbPath, buffer);
}

function getUserByUsername(username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  stmt.bind([username]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function getUserById(id) {
  const stmt = db.prepare('SELECT id, username, points, is_admin, created_at FROM users WHERE id = ?');
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function createUser(username, password, options = {}) {
  const points = Number.isFinite(Number(options.points)) ? Number(options.points) : 0;
  const isAdmin = options.isAdmin ? 1 : 0;
  db.run('INSERT INTO users (username, password, points, is_admin) VALUES (?, ?, ?, ?)', [username, password, points, isAdmin]);
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  const id = row.id || 0;
  saveDatabase();
  return { id, username, points, is_admin: isAdmin };
}

function updateUserPoints(userId, points) {
  const params = points < 0
    ? [points, userId, points]
    : [points, userId];
  const query = points < 0
    ? 'UPDATE users SET points = points + ?, updated_at = datetime("now") WHERE id = ? AND points + ? >= 0'
    : 'UPDATE users SET points = points + ?, updated_at = datetime("now") WHERE id = ?';

  db.run(query, params);
  if (db.getRowsModified() === 0) return false;

  const user = getUserById(userId);
  if (!user) return false;
  const newPoints = user.points;
  saveDatabase();
  return newPoints;
}

function getSessionByToken(token) {
  const stmt = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > datetime("now") ORDER BY id DESC LIMIT 1');
  stmt.bind([token]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function createSession(userId, token) {
  db.run('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime("now", "+7 days"))', [userId, token]);
  saveDatabase();
}

function deleteSessionByToken(token) {
  db.run('DELETE FROM sessions WHERE token = ?', [token]);
  saveDatabase();
}

function deleteSessionByUserId(userId) {
  db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  saveDatabase();
}

function setConfiguredAdmins(usernames) {
  if (!Array.isArray(usernames) || usernames.length === 0) return;
  const placeholders = usernames.map(() => '?').join(', ');
  db.run(`UPDATE users SET is_admin = 1, updated_at = datetime("now") WHERE username IN (${placeholders})`, usernames);
  saveDatabase();
}

function listUsersWithStats() {
  const results = [];
  const stmt = db.prepare(`
  SELECT
  u.id,
  u.username,
  u.points,
  u.is_admin,
  u.created_at,
      COUNT(DISTINCT i.id) AS generate_count,
      COUNT(DISTINCT CASE WHEN o.status = 'completed' THEN o.id END) AS order_count
      FROM users u
      LEFT JOIN images i ON i.user_id = u.id
      LEFT JOIN orders o ON o.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);

  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }

  stmt.free();
  return results;
}

function getAdminStats() {
  const totalUsers = db.exec('SELECT COUNT(*) AS count FROM users')[0]?.values?.[0]?.[0] || 0;
  const totalPoints = db.exec('SELECT COALESCE(SUM(points), 0) AS sum FROM users')[0]?.values?.[0]?.[0] || 0;
  const totalOrders = db.exec('SELECT COUNT(*) AS count FROM orders')[0]?.values?.[0]?.[0] || 0;
  const totalGenerations = db.exec('SELECT COUNT(*) AS count FROM images')[0]?.values?.[0]?.[0] || 0;

  return {
    totalUsers,
    totalPoints,
    totalOrders,
    totalGenerations
  };
}

function updateUserAdminProfile(userId, updates = {}) {
  const fields = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(updates, 'points')) {
    fields.push('points = ?');
    params.push(updates.points);
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'is_admin')) {
    fields.push('is_admin = ?');
    params.push(updates.is_admin ? 1 : 0);
  }

  if (fields.length === 0) return false;

  params.push(userId);
  db.run(`UPDATE users SET ${fields.join(', ')}, updated_at = datetime("now") WHERE id = ?`, params);
  saveDatabase();
  return getUserById(userId);
}

function updateUserProfile(userId, updates = {}) {
  const ALLOWED_FIELDS = ['username'];
  const fields = [];
  const params = [];

  if (Object.keys(updates).length === 0) return false;

  for (const [key, value] of Object.entries(updates)) {
    if (ALLOWED_FIELDS.includes(key)) {
      fields.push(`${key} = ?`);
      params.push(value);
    }
  }

  if (fields.length === 0) return false;

  params.push(userId);
  db.run(`UPDATE users SET ${fields.join(', ')}, updated_at = datetime("now") WHERE id = ?`, params);
  saveDatabase();
  return getUserById(userId);
}

function updateUserPassword(userId, hashedPassword) {
  db.run('UPDATE users SET password = ?, updated_at = datetime("now") WHERE id = ?', [hashedPassword, userId]);
  saveDatabase();
}

function deleteUserById(userId) {
  db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  db.run('DELETE FROM point_changes WHERE user_id = ?', [userId]);
  db.run('DELETE FROM images WHERE user_id = ?', [userId]);
  db.run('DELETE FROM orders WHERE user_id = ?', [userId]);
  db.run('DELETE FROM users WHERE id = ?', [userId]);
  saveDatabase();
}

function getSetting(key) {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  stmt.bind([key]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    if (SENSITIVE_SETTINGS.includes(key)) {
      const decrypted = decryptValue(row.value);
      // 旧 CBC 格式自动升级为 GCM
      if (row.value && row.value.startsWith(SETTINGS_ENCRYPT_PREFIX)) {
        const raw = row.value.slice(SETTINGS_ENCRYPT_PREFIX.length);
        if (raw.split(':').length === 2) {
          setSetting(key, decrypted);
        }
      }
      return decrypted;
    }
    return row.value;
  }
  stmt.free();
  return '';
}

function setSetting(key, value) {
  const storedValue = SENSITIVE_SETTINGS.includes(key) ? encryptValue(value) : value;
  db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime("now")',
    [key, storedValue]
  );
  saveDatabase();
}

function deleteSetting(key) {
  db.run('DELETE FROM settings WHERE key = ?', [key]);
  saveDatabase();
}

function logPointChange(userId, type, amount, description) {
  const user = getUserById(userId);
  const balance = user ? user.points : 0;
  db.run('INSERT INTO point_changes (user_id, type, amount, balance, description) VALUES (?, ?, ?, ?, ?)',
    [userId, type, amount, balance, description]);
  saveDatabase();
}

function getPointHistory(userId, limit = 20) {
  const results = [];
  const stmt = db.prepare('SELECT * FROM point_changes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');
  stmt.bind([userId, limit]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function saveImage(userId, scene, prompt, width, height, imagePaths) {
  try {
    db.run('INSERT INTO images (user_id, scene, prompt, width, height, image_paths) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, scene, prompt, width, height, JSON.stringify(imagePaths)]);
    const result = db.exec('SELECT last_insert_rowid() as id');
    const id = result[0]?.values[0]?.[0] || 0;
    saveDatabase();
    return id;
  } catch (err) {
    console.error('[saveImage] error:', err);
    throw err;
  }
}

function getUserImages(userId, limit = 20, offset = 0) {
  const results = [];
  const stmt = db.prepare('SELECT * FROM images WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?');
  stmt.bind([userId, limit, offset]);
  while (stmt.step()) {
    const row = stmt.getAsObject();
    row.image_paths = JSON.parse(row.image_paths || '[]');
    results.push(row);
  }
  stmt.free();
  return results;
}

function getImageById(id) {
  const stmt = db.prepare('SELECT * FROM images WHERE id = ?');
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    row.image_paths = JSON.parse(row.image_paths || '[]');
    return row;
  }
  stmt.free();
  return null;
}

function createOrder(userId, packageId, amount, points) {
  db.run('INSERT INTO orders (user_id, package_id, amount, points) VALUES (?, ?, ?, ?)',
    [userId, packageId, amount, points]);
  const result = db.exec('SELECT last_insert_rowid() as id');
  const id = result[0]?.values[0]?.[0] || 0;
  saveDatabase();
  return id;
}

function completeOrderAtomic(orderId) {
  const order = getOrderById(orderId);
  if (!order) {
    return { ok: false, message: '订单不存在' };
  }

  if (order.status === 'completed') {
    return { ok: true, alreadyCompleted: true };
  }

  // 使用条件更新实现原子操作，防止并发重复入账
  const result = db.run(
    'UPDATE orders SET status = ?, pay_info = ?, updated_at = datetime("now") WHERE id = ? AND status = ?',
    ['completed', JSON.stringify({ channel: 'mock', paidAt: new Date().toISOString() }), orderId, 'pending']
  );

  if (db.getRowsModified() === 0) {
    return { ok: false, message: '订单状态异常或已被处理' };
  }

  const newPoints = updateUserPoints(order.user_id, order.points);
  logPointChange(order.user_id, 'recharge', order.points, `充值${order.points}点数`);
  saveDatabase();

  console.log(`[支付成功] 订单:${orderId} 用户:${order.user_id}`);
  return { ok: true, newPoints };
}

function getOrderById(orderId) {
  const stmt = db.prepare('SELECT * FROM orders WHERE id = ?');
  stmt.bind([orderId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function getUserOrders(userId) {
  const results = [];
  const stmt = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20');
  stmt.bind([userId]);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function cleanExpiredSessions() {
  try {
    db.run("DELETE FROM sessions WHERE expires_at < datetime('now')");
    const deleted = db.getRowsModified();
    if (deleted > 0) {
      saveDatabase();
    }
    return deleted;
  } catch (err) {
    console.error('[数据库] 清理session失败:', err.message);
    return 0;
  }
}

module.exports = {
  initDatabase,
  getUserByUsername,
  getUserById,
  getSessionByToken,
  createUser,
  createSession,
  deleteSessionByToken,
  deleteSessionByUserId,
  setConfiguredAdmins,
  listUsersWithStats,
  getAdminStats,
  updateUserAdminProfile,
  updateUserProfile,
  updateUserPassword,
  deleteUserById,
  getSetting,
  setSetting,
  deleteSetting,
  updateUserPoints,
  logPointChange,
  getPointHistory,
  saveImage,
  getUserImages,
  getImageById,
  createOrder,
  completeOrderAtomic,
  getOrderById,
  getUserOrders,
  cleanExpiredSessions,
  flushDatabase: saveDatabaseSync,
  get db() { return db; }
};
