function validatePassword(password) {
  if (typeof password !== 'string') {
    return '密码必须是字符串';
  }
  if (password.length < 6 || password.length > 64) {
    return '密码长度需在6-64个字符之间';
  }
  return '';
}

module.exports = { validatePassword };
