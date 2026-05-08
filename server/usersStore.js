function createUsersStore({ getDb, saveDatabase, generateInviteCode }) {
  function getUserByUsername(username) {
    const db = getDb();
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
    const db = getDb();
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
    const db = getDb();
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

  function inviteCodeExists(inviteCode) {
    const db = getDb();
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

  function createUser(username, password, options = {}) {
    const db = getDb();
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

  function updateUserPassword(userId, hashedPassword) {
    const db = getDb();
    db.run('UPDATE users SET password = ?, updated_at = datetime("now") WHERE id = ?', [hashedPassword, userId]);
    saveDatabase();
  }

  function updateUserAdminProfile(userId, updates = {}) {
    const db = getDb();
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
    const db = getDb();
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

  function deleteUserById(userId) {
    const db = getDb();
    db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    db.run('DELETE FROM point_changes WHERE user_id = ?', [userId]);
    db.run('DELETE FROM images WHERE user_id = ?', [userId]);
    db.run('DELETE FROM orders WHERE user_id = ?', [userId]);
    db.run('DELETE FROM invite_rewards WHERE inviter_user_id = ? OR invited_user_id = ?', [userId, userId]);
    db.run('UPDATE users SET referred_by_user_id = NULL WHERE referred_by_user_id = ?', [userId]);
    db.run('DELETE FROM users WHERE id = ?', [userId]);
    saveDatabase();
  }

  function getUserImageCount(userId) {
    const db = getDb();
    const stmt = db.prepare('SELECT COUNT(*) AS count FROM images WHERE user_id = ?');
    stmt.bind([userId]);
    let count = 0;
    if (stmt.step()) {
      count = stmt.getAsObject().count || 0;
    }
    stmt.free();
    return count;
  }

  return {
    getUserByUsername,
    getUserById,
    getUserByInviteCode,
    createUser,
    updateUserPassword,
    updateUserAdminProfile,
    updateUserProfile,
    deleteUserById,
    getUserImageCount,
    inviteCodeExists,
    createUniqueInviteCode
  };
}

module.exports = { createUsersStore };
