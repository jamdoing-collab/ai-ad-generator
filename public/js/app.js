const API_BASE = '/api';
// 与后端 openai.js MATERIALS 保持同步，仅 API 不可用时降级使用
const FALLBACK_MATERIALS = [
  { key: 'door', name: '门头招牌', icon: '🏪', defaultW: 300, defaultH: 100 },
  { key: 'poster', name: '活动海报', icon: '📢', defaultW: 40, defaultH: 60 },
  { key: 'menu', name: '餐饮菜单', icon: '🍜', defaultW: 21, defaultH: 30 },
  { key: 'rollup', name: '易拉宝', icon: '🎞️', defaultW: 80, defaultH: 200 },
  { key: 'wall', name: '文化墙', icon: '🏢', defaultW: 300, defaultH: 150 },
  { key: 'flyer', name: '宣传单页', icon: '📄', defaultW: 21, defaultH: 30 },
  { key: 'ecom', name: '电商主图', icon: '🛒', defaultW: 1024, defaultH: 1024, unit: 'px' },
  { key: 'moment', name: '朋友圈配图', icon: '📱', defaultW: 1024, defaultH: 1024, unit: 'px' },
];
let MATERIALS = FALLBACK_MATERIALS;

let currentMaterial = MATERIALS[0];
let authToken = localStorage.getItem('token');
let userInfo = null;
let uploadedImages = [];
let selectedQuality = 'default';
let isGenerating = false;
let currentResultImages = [];
let currentResultIndex = 0;
let resultSourcePage = 'generate';
let selectedPackageIndex = 0;
let packages = [];
let authExpiredNotified = false;
let toastTimer = null;
let pendingMineAfterLogin = false;

const $ = id => document.getElementById(id);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPE_MAP[char]);
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setDisplay(id, value) {
  const element = $(id);
  if (element) element.style.display = value;
}

function showToast(message) {
  let toast = $('globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalToast';
    toast.className = 'global-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('show');
  }, 2200);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('微信号已复制');
  } catch {
    showToast('复制失败，请手动复制');
  }
  document.body.removeChild(ta);
}

async function api(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const controller = new AbortController();
  const timeout = options.timeout || (endpoint.startsWith('/generate/') ? 300000 : 90000);
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') return { code: -1, message: '请求超时，请重试' };
    return { code: -1, message: '网络错误，请检查连接' };
  } finally {
    clearTimeout(timeoutId);
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { code: -1, message: '服务器响应异常' };
  }
  if (data.code === 401) {
    userInfo = null;
    updateMineDisplay();
    if (!authExpiredNotified) {
      authExpiredNotified = true;
      alert('登录状态校验失败，请重新登录');
      showLoginModal();
    }
  }
  return data;
}

async function loadMaterials() {
  try {
    const data = await api('/config/materials');
    if (data.code === 0 && Array.isArray(data.data) && data.data.length > 0) {
      MATERIALS = data.data;
    }
  } catch (e) {
    console.warn('加载物料列表失败，使用内嵌默认值', e);
  }
}

async function init() {
  await loadMaterials();
  renderMaterials();
  renderUploadedImages();
  bindSizeStepEvents();
  bindMobileEvents();
  selectMaterial(0);
  checkAuth();
}

function resetForm() {
  $('textInput').value = '';
  setTextInputErrorState('textInput', false);
  $('textError').textContent = '';
  uploadedImages = [];
  renderUploadedImages();
  selectedQuality = 'default';
  document.querySelectorAll('#qualityRow .quality-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.quality === 'default');
  });
  selectMaterial(0);
}

function checkAuth() {
  if (authToken) {
    loadUserInfo();
  } else {
    updateMineDisplay();
  }
}

async function loadUserInfo() {
  const res = await api('/user/info');
  if (res.code === 0) {
    userInfo = res.data;
    authExpiredNotified = false;
    updateMineDisplay();
  } else if (res.code !== 401) {
    userInfo = null;
    updateMineDisplay();
  }
}

function logout() {
  api('/auth/logout', { method: 'POST' });
  authToken = null;
  userInfo = null;
  authExpiredNotified = false;
  localStorage.removeItem('token');
  updateMineDisplay();
  showPage('generate');
  showToast('已退出登录');
}

function renderMaterials() {
  $('materialList').innerHTML = MATERIALS.map((m, i) => `
    <div class="material-chip ${i === 0 ? 'selected' : ''}" data-index="${i}">
      <span class="material-icon">${m.icon}</span>
      <span class="material-name">${m.name}</span>
    </div>
  `).join('');
}

function setTextInputErrorState(inputId, hasError) {
  const input = $(inputId);
  const panel = input?.closest('.content-input-panel') || null;
  if (input) input.classList.toggle('error', hasError);
  if (panel) panel.classList.toggle('error', hasError);
}

function bindMobileEvents() {
  $('materialList').addEventListener('click', e => {
    const chip = e.target.closest('.material-chip');
    if (!chip) return;
    selectMaterial(parseInt(chip.dataset.index));
  });

  $('textInput').addEventListener('input', e => {
    setTextInputErrorState('textInput', false);
    $('textError').textContent = '';
  });

  $('sizeWidth').addEventListener('input', () => { validateSize(); });
  $('sizeHeight').addEventListener('input', () => { validateSize(); });

  // 输入框聚焦时自动滚动到可视区域
  ['textInput', 'sizeWidth', 'sizeHeight'].forEach(id => {
    $(id).addEventListener('focus', () => {
      setTimeout(() => $(id).scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
    });
  });

  $('qualityRow').addEventListener('click', e => {
    const chip = e.target.closest('.quality-chip');
    if (!chip) return;
    selectedQuality = chip.dataset.quality;
    document.querySelectorAll('#qualityRow .quality-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.quality === selectedQuality);
    });
    const hints = { default: '1K，消耗 1 点', '2k': '2K，消耗 2 点', '4k': '4K，消耗 3 点' };
    $('qualityHint').textContent = hints[selectedQuality] || '';
    $('genBtn').textContent = `开始生成（${selectedQuality === '4k' ? 3 : selectedQuality === '2k' ? 2 : 1}点）`;
  });

  $('genBtn').addEventListener('click', () => startGenerate());

  $('mineEntry').addEventListener('click', () => {
    updateMineDisplay();
    showPage('mine');
  });

  $('adminEntry').addEventListener('click', () => {
    window.open('/admin', '_blank');
  });

  $('mineLoginBtn').addEventListener('click', () => {
    showLoginModal();
  });

  $('helpBtn').addEventListener('click', () => showPage('help'));
  $('helpBackBtn').addEventListener('click', () => showPage('mine'));

  $('retryBtn').addEventListener('click', () => {
    resetForm();
    showPage('generate');
  });
  $('downloadBtn').addEventListener('click', downloadImage);
  $('regenBtn').addEventListener('click', () => {
    showPage('generate');
  });

  // 全屏图片查看
  $('resultImg').addEventListener('click', () => {
    $('fullscreenImg').src = $('resultImg').src;
    $('fullscreenViewer').style.display = 'flex';
  });
  $('fullscreenViewer').addEventListener('click', () => {
    $('fullscreenViewer').style.display = 'none';
  });

  // 生成中禁止返回
  $('resultBackBtn').addEventListener('click', e => {
    if (isGenerating) { e.stopPropagation(); showToast('正在生成中，请稍候'); return; }
    resetForm();
    showPage(resultSourcePage);
  }, true);

  $('mineBackBtn').addEventListener('click', () => showPage('generate'));
  $('historyBackBtn').addEventListener('click', () => showPage('mine'));
  $('logoutBtn').addEventListener('click', () => showConfirm('确定退出登录？', logout));
  $('rechargeBtn').addEventListener('click', showRechargeModal);

  $('packageList')?.addEventListener('click', e => {
    const item = e.target.closest('.package-item');
    if (!item) return;
    selectedPackageIndex = parseInt(item.dataset.index, 10);
    renderPackages();
  });

  $('historyBtn').addEventListener('click', loadHistory);

  $('contactBtn').addEventListener('click', () => {
    setDisplay('contactModal', 'flex');
  });

  $('loginModalClose').addEventListener('click', hideLoginModal);
  $('loginModal').addEventListener('click', e => {
    if (e.target.id === 'loginModal') hideLoginModal();
  });
  $('modalLoginBtn').addEventListener('click', () => {
    doLogin($('modalLoginUsername').value.trim(), $('modalLoginPassword').value, {
      onSuccess: () => {
        hideLoginModal();
        pendingMineAfterLogin = false;
      }
    });
  });

  $('loginSwitchBtn').addEventListener('click', () => {
    const isLogin = $('loginModalTitle').textContent === '登录';
    $('loginModalTitle').textContent = isLogin ? '注册' : '登录';
    $('modalLoginBtn').textContent = isLogin ? '注册' : '登录';
    $('loginSwitchBtn').textContent = isLogin ? '已有账号？去登录' : '没有账号？去注册';
  });

  $('rechargeClose').addEventListener('click', () => setDisplay('rechargeModal', 'none'));
  $('rechargeModal').addEventListener('click', e => {
    if (e.target.id === 'rechargeModal') setDisplay('rechargeModal', 'none');
  });

  $('contactModalClose').addEventListener('click', () => setDisplay('contactModal', 'none'));
  $('contactModal').addEventListener('click', e => {
    if (e.target.id === 'contactModal') setDisplay('contactModal', 'none');
  });

  $('copyWechatBtn').addEventListener('click', () => {
    const wechat = $('contactWechat').textContent.trim();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(wechat).then(() => {
        showToast('微信号已复制');
      }).catch(() => fallbackCopy(wechat));
    } else {
      fallbackCopy(wechat);
    }
  });

  $('resultDots').addEventListener('click', onResultDotClick);
}

function bindSizeStepEvents() {
  document.querySelectorAll('.size-step').forEach(button => {
    button.addEventListener('click', () => {
      const target = $(button.dataset.target);
      const step = parseFloat(button.dataset.step || '1');
      if (!target) return;
      const unit = currentMaterial.unit || 'cm';
      const minSize = unit === 'px' ? 64 : 1;
      const maxSize = unit === 'px' ? 4096 : 300;
      const currentValue = parseFloat(target.value);
      const nextValue = Math.min(maxSize, Math.max(minSize, (Number.isFinite(currentValue) ? currentValue : minSize) + step));
      target.value = String(nextValue);
      validateSize();
    });
  });
}

function selectMaterial(index) {
  if (!MATERIALS[index]) return;
  currentMaterial = MATERIALS[index];

  document.querySelectorAll('#materialList .material-chip').forEach((c, i) => {
    c.classList.toggle('selected', i === index);
  });
  $('sizeWidth').value = currentMaterial.defaultW;
  $('sizeHeight').value = currentMaterial.defaultH;

  // 动态更新单位（cm 或 px）
  const unit = currentMaterial.unit || 'cm';
  document.querySelectorAll('.size-unit').forEach(el => el.textContent = unit);
  $('sizeHint').textContent = unit === 'px' ? '尺寸范围：64-4096px' : '尺寸范围：1-300cm';

  validateSize();

  // 保持当前画质选择，更新提示文案
  const hints = { default: '1K，消耗 1 点', '2k': '2K，消耗 2 点', '4k': '4K，消耗 3 点' };
  $('qualityHint').textContent = hints[selectedQuality] || hints.default;
  $('genBtn').textContent = `开始生成（${selectedQuality === '4k' ? 3 : selectedQuality === '2k' ? 2 : 1}点）`;
}

async function calcAspectRatio(width, height) {
  try {
    const data = await api(`/config/gen-size?width=${encodeURIComponent(width)}&height=${encodeURIComponent(height)}`);
    if (data.code === 0 && data.data?.aspectRatio) return data.data.aspectRatio;
  } catch (e) {
    console.warn('calcAspectRatio API failed', e);
  }
  const ratio = width / height;
  if (ratio > 3.5) return '3:1';
  if (ratio > 2.5) return '21:9';
  if (ratio > 1.9) return '2:1';
  if (ratio > 1.8) return '16:9';
  if (ratio > 1.35) return '3:2';
  if (ratio > 1.1) return '4:3';
  if (ratio > 0.95) return '1:1';
  if (ratio > 0.8) return '5:4';
  if (ratio > 0.75) return '4:5';
  if (ratio > 0.6) return '3:4';
  if (ratio > 0.5) return '2:3';
  if (ratio > 0.44) return '9:16';
  if (ratio > 0.38) return '1:2';
  if (ratio > 0.25) return '9:21';
  return '1:3';
}


async function validateSize() {
  const w = parseFloat($('sizeWidth').value);
  const h = parseFloat($('sizeHeight').value);
  const unit = currentMaterial.unit || 'cm';
  const minSize = unit === 'px' ? 64 : 1;
  const maxSize = unit === 'px' ? 4096 : 300;

  $('widthWrap').classList.remove('error');
  $('heightWrap').classList.remove('error');
  $('sizeHint').classList.remove('error');

  if (!w || !h || w < minSize || w > maxSize || h < minSize || h > maxSize) {
    $('sizeHint').textContent = `尺寸范围：${minSize}-${maxSize}${unit}`;
    $('sizeHint').classList.add('error');
    return false;
  }

  const ratio = w / h;
  if (ratio > 10 || ratio < 0.1) {
    $('sizeHint').textContent = '宽高比超出1:10~10:1';
    $('sizeHint').classList.add('error');
    return false;
  }

  if (ratio > 3 || ratio < 1/3) {
    $('sizeHint').textContent = '宽高比超出模型1:3~3:1限制';
    $('sizeHint').classList.add('error');
    showToast('宽高比超出模型限制（1:3~3:1），请调整尺寸');
    return false;
  }

  const aspectRatio = await calcAspectRatio(w, h);
  $('sizeHint').textContent = `生成比例 ${aspectRatio}`;
  return true;
}

function chooseImage() {
  if (uploadedImages.length >= 1) { alert('最多上传1张素材图'); return; }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.onchange = e => {
    const file = e.target.files[0];
    if (file.size > 10 * 1024 * 1024) { alert('图片大小不能超过10MB'); return; }
    const reader = new FileReader();
    reader.onload = evt => { uploadedImages = [evt.target.result]; renderUploadedImages(); };
    reader.readAsDataURL(file);
  };
  input.click();
}

function renderUploadedImages() {
  const html = uploadedImages.map((img, i) => `
    <div class="upload-thumb">
      <img src="${img}" alt="">
      <span class="upload-remove" data-index="${i}">×</span>
    </div>
  `).join('') + (uploadedImages.length < 1 ? '<div class="upload-btn"><span class="upload-plus">+</span><span>添加素材</span></div>' : '');

  const area = $('uploadArea');
  area.innerHTML = html;
  bindUploadAreaEvents(area);
}

function bindUploadAreaEvents(container) {
  container.querySelectorAll('.upload-remove').forEach(rm => {
    rm.addEventListener('click', () => {
      uploadedImages.splice(parseInt(rm.dataset.index, 10), 1);
      renderUploadedImages();
    });
  });
  const btn = container.querySelector('.upload-btn');
  if (btn) btn.addEventListener('click', chooseImage);
}

function renderResultDots(container) {
  if (!container) return;
  if (currentResultImages.length <= 1) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  container.style.display = '';
  container.innerHTML = currentResultImages.map((_, index) => `
    <button class="result-dot ${index === currentResultIndex ? 'active' : ''}" type="button" data-index="${index}" aria-label="查看第${index + 1}张结果"></button>
  `).join('');
}

function showResultImage(index) {
  if (!currentResultImages.length) return;
  currentResultIndex = Math.max(0, Math.min(index, currentResultImages.length - 1));
  $('resultImg').src = currentResultImages[currentResultIndex];
  renderResultDots($('resultDots'));
}

function onResultDotClick(event) {
  const dot = event.target.closest('.result-dot');
  if (!dot) return;
  showResultImage(parseInt(dot.dataset.index, 10) || 0);
}

async function validateAll() {
  const text = $('textInput').value.trim();
  let valid = true;

  $('genError').textContent = '';

  if (text.length < 2) {
    setTextInputErrorState('textInput', true);
    showToast('请输入至少2个字');
    valid = false;
  }

  if (!(await validateSize())) {
    $('genError').textContent = '请检查尺寸输入';
    valid = false;
  }

  return valid;
}

async function startGenerate() {
  if (isGenerating) return;
  if (!authToken || !userInfo) { showLoginModal(); return; }
  const needPoints = selectedQuality === '4k' ? 3 : selectedQuality === '2k' ? 2 : 1;
  if (userInfo.points < needPoints) { alert('点数不足，请充值'); showRechargeModal(); return; }

  isGenerating = true;

  if (!(await validateAll())) { isGenerating = false; return; }

  if (!currentMaterial?.key) { showToast('请选择物料类型'); isGenerating = false; return; }

  const text = $('textInput').value.trim();
  const width = parseFloat($('sizeWidth').value);
  const height = parseFloat($('sizeHeight').value);

  resultSourcePage = 'generate';
  $('loadingWrap').style.display = 'flex';
  $('resultWrap').style.display = 'none';
  $('errorState').style.display = 'none';
  $('genBtn').disabled = true;
  $('genBtn').textContent = '生成中...';

  const loadingMsgs = {
    default: { text: 'AI创作中...', sub: '预计需要15-30秒' },
    '2k': { text: 'AI高清创作中...', sub: '预计需要30-60秒' },
    '4k': { text: 'AI超清创作中...', sub: '预计需要1-2分钟' },
  };
  const msg = loadingMsgs[selectedQuality] || loadingMsgs.default;
  $('loadingText').textContent = msg.text;
  $('loadingSub').textContent = msg.sub;

  showPage('result');

  try {
    const res = await api('/generate/image', {
      method: 'POST',
      body: JSON.stringify({
        scene: currentMaterial.key,
        text: text,
        width: width,
        height: height,
        quality: selectedQuality,
        referenceImage: uploadedImages[0] || null
      })
    });

    if (res.code === 0) {
      if (!res.data.images?.length) throw new Error('生成结果为空，请重试');
      currentResultImages = res.data.images.map(img => img.url);
      currentResultIndex = 0;
      userInfo.points = res.data.points;
      $('loadingWrap').style.display = 'none';
      $('resultWrap').style.display = 'flex';
      showResultImage(0);
      updateMineDisplay();
      if ($('feedbackInput')) $('feedbackInput').value = '';
    } else {
      throw new Error(res.message);
    }
  } catch (err) {
    $('loadingWrap').style.display = 'none';
    $('errorState').style.display = 'flex';
    $('errorMsg').textContent = err.message || '生成失败';
  } finally {
    isGenerating = false;
    $('genBtn').disabled = false;
    const cost = selectedQuality === '4k' ? 3 : selectedQuality === '2k' ? 2 : 1;
    $('genBtn').textContent = `开始生成（${cost}点）`;
  }
}

function downloadImage() {
  const url = currentResultImages[currentResultIndex];
  if (!url) return;
  const filename = `AI广告-${currentMaterial?.name || 'design'}-${Date.now()}.png`;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  showToast('已保存到本地');
}


function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('page-active'));
  const target = $(`page${page.charAt(0).toUpperCase() + page.slice(1)}`);
  if (target) target.classList.add('page-active');
}

function showLoginModal() {
  $('loginModalTitle').textContent = '登录';
  $('modalLoginBtn').textContent = '登录';
  $('loginSwitchBtn').textContent = '没有账号？去注册';
  setDisplay('loginModal', 'flex');
}

function hideLoginModal() {
  setDisplay('loginModal', 'none');
  if ($('modalLoginUsername')) $('modalLoginUsername').value = '';
  if ($('modalLoginPassword')) $('modalLoginPassword').value = '';
}

async function doLogin(username, password, options = {}) {
  if (!username || !password) { alert('请输入用户名和密码'); return; }

  const isRegister = $('loginModalTitle').textContent === '注册';
  const endpoint = isRegister ? '/auth/register' : '/auth/login';

  const res = await api(endpoint, {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });

  if (res.code === 0) {
    authToken = res.data.token;
    userInfo = res.data.user;
    localStorage.setItem('token', authToken);
    updateMineDisplay();
    showToast(isRegister ? '注册成功' : '登录成功');
    if (typeof options.onSuccess === 'function') {
      options.onSuccess();
    }
  } else {
    alert(res.message || (isRegister ? '注册失败' : '登录失败'));
  }
}

function updateMineDisplay() {
  const nameEl = $('mineName');
  if (userInfo) {
    setText('mineAvatar', userInfo.username?.charAt(0) || '👤');
    nameEl.textContent = userInfo.username || '用户';
    const existingBadge = nameEl.querySelector('.mine-badge');
    if (existingBadge) existingBadge.remove();
    if (userInfo.is_admin) {
      const badge = document.createElement('span');
      badge.className = 'mine-badge';
      badge.textContent = '管理员';
      nameEl.appendChild(badge);
    }
    setText('mineHint', '');
    setText('pointsNum', userInfo.points);
    setDisplay('mineLoginBtn', 'none');
    setDisplay('pointsCard', 'flex');
    setDisplay('historyBtn', 'flex');
    setDisplay('logoutBtn', 'block');
    setDisplay('adminEntry', userInfo.is_admin ? 'flex' : 'none');
  } else {
    setText('mineAvatar', '👤');
    setText('mineName', '未登录');
    setText('mineHint', '登录后可使用AI生成功能');
    setDisplay('mineLoginBtn', 'block');
    setDisplay('pointsCard', 'none');
    setDisplay('historyBtn', 'none');
    setDisplay('logoutBtn', 'none');
    setDisplay('adminEntry', 'none');
  }
}

async function showRechargeModal() {
  const res = await api('/payment/packages');
  if (res.code === 0) {
    packages = res.data;
    selectedPackageIndex = 0;
    renderPackages();
    $('rechargePoints').textContent = userInfo?.points || 0;
    $('rechargeModal').style.display = 'flex';
  }
}

function renderPackages() {
  if (!$('packageList')) return;
  $('packageList').innerHTML = packages.map((p, i) => `
    <div class="package-item ${i === selectedPackageIndex ? 'selected' : ''}" data-index="${i}">
      <div class="package-points">${p.points}点</div>
      <div class="package-price">¥${p.price}</div>
    </div>
  `).join('');
}

async function doRecharge() {
  const pkg = packages[selectedPackageIndex];
  if (!pkg) return;

  if ($('payBtn')) {
    $('payBtn').disabled = true;
    $('payBtn').textContent = '支付确认中...';
  }

  try {
    const res = await api('/payment/create', {
      method: 'POST',
      body: JSON.stringify({ packageId: pkg.id })
    });

    if (res.code !== 0) {
      throw new Error(res.message || '创建订单失败');
    }

    let confirmed = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(attempt === 0 ? 1800 : 1000);
      const confirmRes = await api('/payment/confirm', {
        method: 'POST',
        body: JSON.stringify({ orderId: res.data.orderId })
      });

      if (confirmRes.code !== 0) {
        throw new Error(confirmRes.message || '支付状态查询失败');
      }

      if (confirmRes.data.success) {
        confirmed = true;
        break;
      }
    }

    if (!confirmed) {
      throw new Error('支付处理中，请稍后在点数余额中确认');
    }

    await loadUserInfo();
    $('rechargeModal').style.display = 'none';
    showToast(`充值成功！${pkg.points}点已到账`);
  } catch (err) {
    alert(err.message || '支付失败');
  } finally {
    if ($('payBtn')) {
      $('payBtn').disabled = false;
      $('payBtn').textContent = '立即支付';
    }
  }
}

$('payBtn')?.addEventListener('click', doRecharge);

let historyOffset = 0;
let historyLoading = false;
let historyDone = false;
let historyScrollHandler = null;
const HISTORY_BATCH = 10;

function renderHistoryItems(items, listEl) {
  const html = items.map(item => {
    const imgUrl = item.thumbUrl || item.imagePaths?.[0];
    const fullUrl = item.imagePaths?.[0];
    const sceneName = MATERIALS.find(m => m.key === item.scene)?.name || item.scene;
    return `
    <div class="history-card" data-full-url="${escapeHtml(fullUrl || '')}">
      <div class="history-card-img">${imgUrl ? `<img src="${imgUrl}" alt="${escapeHtml(sceneName)}" loading="lazy">` : '<span class="history-card-empty">暂无图片</span>'}</div>
      <div class="history-card-label">${escapeHtml(sceneName)}</div>
    </div>
    `;
  }).join('');
  listEl.insertAdjacentHTML('beforeend', html);

  const cards = listEl.querySelectorAll('.history-card');
  items.forEach((item, i) => {
    const card = cards[cards.length - items.length + i];
    if (card) {
      card.addEventListener('click', () => {
        const fullUrl = card.dataset.fullUrl;
        if (fullUrl) {
          $('fullscreenImg').src = fullUrl;
          $('fullscreenViewer').style.display = 'flex';
        }
      });
    }
  });
}

async function loadMoreHistory(listEl) {
  if (historyLoading || historyDone) return;
  historyLoading = true;

  try {
    const res = await api(`/generate/history?limit=${HISTORY_BATCH}&offset=${historyOffset}`);
    if (res.code !== 0 || !res.data?.length) {
      historyDone = true;
      return;
    }
    renderHistoryItems(res.data, listEl);
    historyOffset += res.data.length;
    if (res.data.length < HISTORY_BATCH) historyDone = true;
  } catch { showToast('加载历史记录失败'); } finally {
    historyLoading = false;
  }
}

async function loadHistory() {
  showPage('history');
  const list = $('historyList');
  if (!list) return;

  historyOffset = 0;
  historyLoading = false;
  historyDone = false;

  list.innerHTML = '<div class="history-list" id="historyListInner"></div>';
  const listEl = $('historyListInner');

  await loadMoreHistory(listEl);

  if (historyOffset === 0) {
    list.innerHTML = `
    <div class="history-empty">
      <div class="history-empty-icon">🎨</div>
      <div class="history-empty-title">暂无生成记录</div>
      <div class="history-empty-desc">去创作你的第一张AI广告设计吧</div>
    </div>`;
    return;
  }

  // 滚动到底部自动加载更多（移除旧监听器防止重复绑定）
  const mainEl = list.closest('.main') || list;
  if (historyScrollHandler) mainEl.removeEventListener('scroll', historyScrollHandler);
  historyScrollHandler = () => {
    if (mainEl.scrollTop + mainEl.clientHeight >= mainEl.scrollHeight - 100) {
      loadMoreHistory(listEl);
    }
  };
  mainEl.addEventListener('scroll', historyScrollHandler);
}

function showConfirm(message, onOk) {
  $('confirmMsg').textContent = message;
  setDisplay('confirmModal', 'flex');

  const close = () => setDisplay('confirmModal', 'none');
  const okBtn = $('confirmOkBtn');
  const cancelBtn = $('confirmCancelBtn');
  const newOk = okBtn.cloneNode(true);
  const newCancel = cancelBtn.cloneNode(true);
  okBtn.replaceWith(newOk);
  cancelBtn.replaceWith(newCancel);

  newOk.addEventListener('click', () => { close(); onOk(); });
  newCancel.addEventListener('click', close);
}

init();
