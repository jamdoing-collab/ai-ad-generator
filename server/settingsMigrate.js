function migrateLegacySettings(getDb, { decryptValue, encryptPrefix, setSetting }) {
  const db = getDb();
  const stmt = db.prepare('SELECT key, value FROM settings WHERE value LIKE ?');
  stmt.bind([`${encryptPrefix}%`]);

  const pending = [];
  while (stmt.step()) {
    pending.push(stmt.getAsObject());
  }
  stmt.free();

  for (const row of pending) {
    const raw = row.value.slice(encryptPrefix.length);
    if (raw.split(':').length === 2) {
      const decrypted = decryptValue(row.value);
      if (decrypted) {
        setSetting(row.key, decrypted);
      }
    }
  }
}

module.exports = { migrateLegacySettings };
