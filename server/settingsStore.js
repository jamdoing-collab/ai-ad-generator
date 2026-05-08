const SENSITIVE_SETTINGS = ['openai_api_key', 'openai_base_url', 'image_host_token'];

function createSettingsStore({ getDb, encryptValue, decryptValue, saveDatabase }) {
  function getSetting(key) {
    const db = getDb();
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    stmt.bind([key]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return SENSITIVE_SETTINGS.includes(key) ? decryptValue(row.value) : row.value;
    }
    stmt.free();
    return '';
  }

  function setSetting(key, value) {
    const db = getDb();
    const storedValue = SENSITIVE_SETTINGS.includes(key) ? encryptValue(value) : value;
    db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now")) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime("now")',
      [key, storedValue]
    );
    saveDatabase();
  }

  function deleteSetting(key) {
    const db = getDb();
    db.run('DELETE FROM settings WHERE key = ?', [key]);
    saveDatabase();
  }

  return { getSetting, setSetting, deleteSetting, SENSITIVE_SETTINGS };
}

module.exports = { createSettingsStore, SENSITIVE_SETTINGS };
