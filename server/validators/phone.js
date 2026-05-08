function normalizePhone(value) {
  return String(value || '').trim();
}

function validatePhone(value) {
  const phone = normalizePhone(value);
  if (!/^1\d{10}$/.test(phone)) {
    return '请输入正确的11位手机号码';
  }
  return '';
}

module.exports = { normalizePhone, validatePhone };
