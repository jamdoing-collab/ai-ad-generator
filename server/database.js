const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createSettingsCrypto } = require('./settingsCrypto');
const { createSettingsStore } = require('./settingsStore');

const dbPath = path.join(__dirname, '../data/ad-generator.db');

let db = null;

const config = require('./config');
let settingsStore = null;

let settingsCrypto;
try {
  settingsCrypto = createSettingsCrypto(config.JWT_SECRET);
} catch {
  console.error('[数据库] 错误：缺少 JWT_SECRET 环境变量，无法加密敏感设置');
  process.exit(1);
}
const { encryptValue, decryptValue, SETTINGS_ENCRYPT_PREFIX } = settingsCrypto;

const ALLOWED_TABLES = ['users', 'sessions', 'images', 'point_changes', 'orders', 'settings', 'invite_rewards'];

function getTableColumns(tableName) {
  if (!ALLOWED_TABLES.includes(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  const result = db.exec(`PRAGMA table_info("${tableName}")`);
  const columns = result[0]?.values || [];
  return new Set(columns.map(column => column[1]));
}

function generateInviteCode() {
  return crypto.randomBytes(6).toString('base64url');
}

function inviteCodeExists(inviteCode) {
  const stmt = db.prepare('SELECT id FROM users WHERE invite_code = ? LIMIT 1');
  stmt.bind([inviteCode]);
  const exists = stmt.step();
  stmt.free();
  return exists;
}

function createUniqueInviteCode() {
  let inviteCode = generateInviteCode();
  while (inviteCodeExists(inviteCode)) {
    inviteCode = generateInviteCode();
  }
  return inviteCode;
}

function ensureUserColumns() {
  const columns = getTableColumns('users');

  if (!columns.has('points')) {
    db.run('ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0');
    db.run('UPDATE users SET points = 0 WHERE points IS NULL');
  }

  if (!columns.has('created_at')) {
    db.run('ALTER TABLE users ADD COLUMN created_at TEXT');
    db.run('UPDATE users SET created_at = datetime("now") WHERE created_at IS NULL');
  }

  if (!columns.has('updated_at')) {
    db.run('ALTER TABLE users ADD COLUMN updated_at TEXT');
    db.run('UPDATE users SET updated_at = datetime("now") WHERE updated_at IS NULL');
  }

  if (!columns.has('is_admin')) {
    db.run('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
  }

  if (!columns.has('invite_code')) {
    db.run('ALTER TABLE users ADD COLUMN invite_code TEXT');
  }

  if (!columns.has('referred_by_user_id')) {
    db.run('ALTER TABLE users ADD COLUMN referred_by_user_id INTEGER');
  }

  const stmt = db.prepare('SELECT id FROM users WHERE invite_code IS NULL OR invite_code = ""');
  const missingIds = [];
  while (stmt.step()) {
    missingIds.push(stmt.getAsObject().id);
  }
  stmt.free();

  for (const userId of missingIds) {
    db.run('UPDATE users SET invite_code = ? WHERE id = ?', [createUniqueInviteCode(), userId]);
  }

  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code)');
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
  invite_code TEXT UNIQUE,
  referred_by_user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (referred_by_user_id) REFERENCES users(id)
)
  `);
  ensureUserColumns();
  
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
    quality TEXT DEFAULT 'default',
    image_paths TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
  `);

  const imageColumns = getTableColumns('images');
  if (!imageColumns.has('quality')) {
    db.run("ALTER TABLE images ADD COLUMN quality TEXT DEFAULT 'default'");
    db.run("UPDATE images SET quality = 'default' WHERE quality IS NULL OR quality = ''");
  }
  
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

  migrateSettingsIfNeeded();

  db.run(`
    CREATE TABLE IF NOT EXISTS invite_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_user_id INTEGER NOT NULL,
      invited_user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(invited_user_id, type),
      FOREIGN KEY (inviter_user_id) REFERENCES users(id),
      FOREIGN KEY (invited_user_id) REFERENCES users(id)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_images_user_id ON images(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_point_changes_user_id ON point_changes(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_users_referred_by_user_id ON users(referred_by_user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_invite_rewards_inviter_user_id ON invite_rewards(inviter_user_id)');

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
        quality TEXT DEFAULT 'default',
        image_paths TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    const recreatedColumns = new Set(['id', 'user_id', 'scene', 'prompt', 'width', 'height', 'quality', 'image_paths', 'created_at']);
    const newCols = cols[0].values
      .filter(c => c[1] !== 'dpi' && recreatedColumns.has(c[1]))
      .map(c => c[1])
      .join(', ');
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

settingsStore = createSettingsStore({
  getDb: () => db,
  encryptValue,
  decryptValue,
  saveDatabase
});

function migrateSettingsIfNeeded() {
  const stmt = db.prepare('SELECT key, value FROM settings WHERE value LIKE ?');
  stmt.bind([`${SETTINGS_ENCRYPT_PREFIX}%`]);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();

  for (const row of rows) {
    const raw = row.value.slice(SETTINGS_ENCRYPT_PREFIX.length);
    if (raw.split(':').length === 2) {
      const decrypted = decryptValue(row.value);
      if (decrypted) {
        settingsStore.setSetting(row.key, decrypted);
      }
    }
  }
}

function getUserByUsername(username) {
  const stmt = db.prepare('SELECT id, username, points, is_admin, invite_code, referred_by_user_id, created_at FROM users WHERE username = ?');
  stmt.bind([username]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function getUserAuthByUsername(username) {
  const stmt = db.prepare('SELECT id, username, password, points, is_admin, invite_code, referred_by_user_id, created_at FROM users WHERE username = ?');
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
  const stmt = db.prepare('SELECT id, username, points, is_admin, invite_code, referred_by_user_id, created_at FROM users WHERE id = ?');
  stmt.bind([id]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function getUserByInviteCode(inviteCode) {
  if (!inviteCode) return null;
  const stmt = db.prepare('SELECT id, username, points, is_admin, invite_code, referred_by_user_id, created_at FROM users WHERE invite_code = ?');
  stmt.bind([inviteCode]);
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
  const inviteCode = createUniqueInviteCode();
  const referredByUserId = Number.isInteger(Number(options.referredByUserId)) ? Number(options.referredByUserId) : null;
  db.run(
    'INSERT INTO users (username, password, points, is_admin, invite_code, referred_by_user_id) VALUES (?, ?, ?, ?, ?, ?)',
    [username, password, points, isAdmin, inviteCode, referredByUserId]
  );
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  const id = row.id || 0;
  saveDatabase();
  return { id, username, points, is_admin: isAdmin, invite_code: inviteCode, referred_by_user_id: referredByUserId };
}

function getUserImageCount(userId) {
  const stmt = db.prepare('SELECT COUNT(*) AS count FROM images WHERE user_id = ?');
  stmt.bind([userId]);
  let count = 0;
  if (stmt.step()) {
    count = stmt.getAsObject().count || 0;
  }
  stmt.free();
  return count;
}

function updateUserPoints(userId, points) {
  const params = points < 0
    ? [points, userId, points]
    : [points, userId];
  const query = points < 0
    ? 'UPDATE users SET points = points + ?, updated_at = datetime("now") WHERE id = ? AND points + ? >= 0'
    : 'UPDATE users SET points = points + ?, updated_at = datetime("now") WHERE id = ?';

  db.run(query, params);
  if (db.getRowsModified() === 0) {
    const user = getUserById(userId);
    if (!user) {
      return { ok: false, reason: 'user_not_found' };
    }
    return { ok: false, reason: 'insufficient_points' };
  }

  const user = getUserById(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  const newPoints = user.points;
  saveDatabase();
  return { ok: true, newPoints };
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
  db.run('BEGIN');
  try {
    db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    db.run('DELETE FROM point_changes WHERE user_id = ?', [userId]);
    db.run('DELETE FROM images WHERE user_id = ?', [userId]);
    db.run('DELETE FROM orders WHERE user_id = ?', [userId]);
    db.run('DELETE FROM invite_rewards WHERE inviter_user_id = ? OR invited_user_id = ?', [userId, userId]);
    db.run('UPDATE users SET referred_by_user_id = NULL WHERE referred_by_user_id = ?', [userId]);
    db.run('DELETE FROM users WHERE id = ?', [userId]);
    db.run('COMMIT');
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
    }
    throw err;
  }
  saveDatabase();
}

const { getSetting, setSetting, deleteSetting } = settingsStore;

function logPointChange(userId, type, amount, description) {
  const user = getUserById(userId);
  const balance = user ? user.points : 0;
  db.run('INSERT INTO point_changes (user_id, type, amount, balance, description) VALUES (?, ?, ?, ?, ?)',
    [userId, type, amount, balance, description]);
  saveDatabase();
}

function awardInviteReward(invitedUserId, type, amount, description) {
  const parsedAmount = Number(amount);
  if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    return { ok: false, message: '无效奖励点数' };
  }

  const invitedUser = getUserById(invitedUserId);
  if (!invitedUser || !invitedUser.referred_by_user_id) {
    return { ok: false, message: '没有邀请关系' };
  }

  const inviterUserId = Number(invitedUser.referred_by_user_id);
  if (inviterUserId === Number(invitedUserId)) {
    return { ok: false, message: '不能奖励自邀请' };
  }

  db.run('BEGIN');
  try {
    db.run(
      'INSERT INTO invite_rewards (inviter_user_id, invited_user_id, type, amount) VALUES (?, ?, ?, ?)',
      [inviterUserId, invitedUserId, type, parsedAmount]
    );

    db.run(
      'UPDATE users SET points = points + ?, updated_at = datetime("now") WHERE id = ?',
      [parsedAmount, inviterUserId]
    );
    if (db.getRowsModified() === 0) {
      db.run('ROLLBACK');
      return { ok: false, message: '邀请者不存在' };
    }

    const inviter = getUserById(inviterUserId);
    const newPoints = inviter ? inviter.points : 0;
    db.run(
      'INSERT INTO point_changes (user_id, type, amount, balance, description) VALUES (?, ?, ?, ?, ?)',
      [inviterUserId, 'invite_reward', parsedAmount, newPoints, description]
    );

    db.run('COMMIT');
    saveDatabase();
    return { ok: true, inviterUserId, newPoints };
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
    }
    if (String(err.message || '').includes('UNIQUE')) {
      return { ok: false, alreadyAwarded: true };
    }
    console.error('[邀请奖励] 记录奖励失败:', err.message);
    return { ok: false, message: '记录奖励失败' };
  }
}

function getInviteSummary(userId) {
  const invitedStmt = db.prepare('SELECT COUNT(*) AS count FROM users WHERE referred_by_user_id = ?');
  invitedStmt.bind([userId]);
  const invitedCount = invitedStmt.step() ? invitedStmt.getAsObject().count || 0 : 0;
  invitedStmt.free();

  const effectiveStmt = db.prepare('SELECT COUNT(DISTINCT invited_user_id) AS count FROM invite_rewards WHERE inviter_user_id = ?');
  effectiveStmt.bind([userId]);
  const effectiveCount = effectiveStmt.step() ? effectiveStmt.getAsObject().count || 0 : 0;
  effectiveStmt.free();

  const rewardStmt = db.prepare('SELECT COALESCE(SUM(amount), 0) AS sum FROM invite_rewards WHERE inviter_user_id = ?');
  rewardStmt.bind([userId]);
  const rewardPoints = rewardStmt.step() ? rewardStmt.getAsObject().sum || 0 : 0;
  rewardStmt.free();

  return {
    invitedCount,
    effectiveCount,
    rewardPoints
  };
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

function saveImage(userId, scene, prompt, width, height, imagePaths, quality = 'default') {
  try {
    db.run('INSERT INTO images (user_id, scene, prompt, width, height, quality, image_paths) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, scene, prompt, width, height, quality, JSON.stringify(imagePaths)]);
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

  db.run('BEGIN');
  try {
    // 使用条件更新实现原子操作，防止并发重复入账
    db.run(
      'UPDATE orders SET status = ?, pay_info = ?, updated_at = datetime("now") WHERE id = ? AND status = ?',
      ['completed', JSON.stringify({ channel: 'mock', paidAt: new Date().toISOString() }), orderId, 'pending']
    );

    if (db.getRowsModified() === 0) {
      db.run('ROLLBACK');
      return { ok: false, message: '订单状态异常或已被处理' };
    }

    db.run(
      'UPDATE users SET points = points + ?, updated_at = datetime("now") WHERE id = ?',
      [order.points, order.user_id]
    );
    if (db.getRowsModified() === 0) {
      db.run('ROLLBACK');
      return { ok: false, message: '用户不存在' };
    }

    const user = getUserById(order.user_id);
    const newPoints = user ? user.points : 0;
    db.run(
      'INSERT INTO point_changes (user_id, type, amount, balance, description) VALUES (?, ?, ?, ?, ?)',
      [order.user_id, 'recharge', order.points, newPoints, `充值${order.points}点数`]
    );

    db.run('COMMIT');
    saveDatabase();

    console.log(`[支付成功] 订单:${orderId} 用户:${order.user_id}`);
    return { ok: true, newPoints };
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
    }
    throw err;
  }
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
  getUserAuthByUsername,
  getUserById,
  getUserByInviteCode,
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
  awardInviteReward,
  getInviteSummary,
  getUserImageCount,
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
