function validatePassword(password) {
  if (typeof password !== 'string') {
    return '密码必须是字符串';
  }
  if (password.length < 6 || password.length > 64) {
    return '密码长度需在6-64个字符之间';
  }
  if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(password)) {
    return '密码需同时包含字母和数字';
  }
  return '';
}

module.exports = { validatePassword };
