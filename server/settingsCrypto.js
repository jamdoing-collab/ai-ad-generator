const crypto = require('crypto');

const SETTINGS_ENCRYPT_PREFIX = 'enc:';

function createSettingsCrypto(secret) {
  if (!secret) {
    throw new Error('缺少 JWT_SECRET 环境变量，无法加密敏感设置');
  }

  const key = crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'settings-encryption', 32);

  function encryptValue(plaintext) {
    if (!plaintext) return plaintext;
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
      const raw = ciphertext.slice(SETTINGS_ENCRYPT_PREFIX.length);
      const parts = raw.split(':');

      if (parts.length === 3) {
        const iv = Buffer.from(parts[0], 'hex');
        const tag = Buffer.from(parts[1], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(parts[2], 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }

      if (parts.length === 2) {
        const iv = Buffer.from(parts[0], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(parts[1], 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }

      return '';
    } catch (err) {
      console.error('[数据库] 解密设置失败:', err.message);
      return '';
    }
  }

  return { encryptValue, decryptValue, SETTINGS_ENCRYPT_PREFIX };
}

module.exports = { createSettingsCrypto };
