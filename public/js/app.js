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

  $('qualityRow').addEventListener('click', e => {
    const chip = e.target.closest('.quality-chip');
    if (!chip) return;
    selectedQuality = chip.dataset.quality;
    document.querySelectorAll('#qualityRow .quality-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.quality === selectedQuality);
    });
    const hints = { default: '标准画质，消耗 1 点', '2k': '高清画质，消耗 2 点', '4k': '超清画质，消耗 2 点' };
    $('qualityHint').textContent = hints[selectedQuality] || '';
    $('genBtn').textContent = `开始生成（${selectedQuality === 'default' ? 1 : 2}点）`;
  });

  $('genBtn').addEventListener('click', () => startGenerate());

  $('mineEntry').addEventListener('click', () => {
    if (!authToken || !userInfo) {
      pendingMineAfterLogin = true;
      showLoginModal();
    } else {
      updateMineDisplay();
      showPage('mine');
    }
  });

  $('adminEntry').addEventListener('click', () => {
    window.open('/admin', '_blank');
  });

$('resultBackBtn').addEventListener('click', () => showPage(resultSourcePage));
$('retryBtn').addEventListener('click', () => showPage('generate'));
$('downloadBtn').addEventListener('click', downloadImage);
$('regenBtn').addEventListener('click', () => {
  showPage('generate');
});

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
        if (pendingMineAfterLogin) {
          pendingMineAfterLogin = false;
          showPage('mine');
        }
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
    navigator.clipboard.writeText(wechat).then(() => {
      showToast('微信号已复制');
    }).catch(() => {
      showToast('复制失败，请手动复制');
    });
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
  const hints = { default: '标准画质，消耗 1 点', '2k': '高清画质，消耗 2 点', '4k': '超清画质，消耗 2 点' };
  $('qualityHint').textContent = hints[selectedQuality] || hints.default;
  $('genBtn').textContent = `开始生成（${selectedQuality === 'default' ? 1 : 2}点）`;
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
  `).join('') + (uploadedImages.length < 1 ? '<div class="upload-btn"><span class="upload-plus">+</span><span>上传素材图</span></div>' : '');

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
  if (userInfo.points < 1) { alert('点数不足，请充值'); showRechargeModal(); return; }

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
    $('genBtn').textContent = '开始生成（1点）';
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
    setDisplay('adminEntry', userInfo.is_admin ? 'flex' : 'none');
  } else {
    setText('mineAvatar', '?');
    setText('mineName', '点击登录');
    setText('mineHint', '登录后可使用生成功能');
    setText('pointsNum', '--');
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

async function loadHistory() {
  showPage('history');
  const list = $('historyList');
  if (!list) return;
  list.innerHTML = '<div class="history-list"><div class="history-loading">加载中...</div></div>';

  try {
    const res = await api('/generate/history?limit=20');
    if (res.code !== 0 || !res.data?.length) {
      list.innerHTML = `
      <div class="history-empty">
        <div class="history-empty-icon">🎨</div>
        <div class="history-empty-title">暂无生成记录</div>
        <div class="history-empty-desc">去创作你的第一张AI广告设计吧</div>
      </div>`;
      return;
    }

    const listEl = list.querySelector('.history-list');
    if (!listEl) return;
    listEl.innerHTML = res.data.map(item => {
      const firstUrl = item.imagePaths?.[0];
      const sceneName = MATERIALS.find(m => m.key === item.scene)?.name || item.scene;
      return `
      <div class="history-card">
        <div class="history-card-img">${firstUrl ? `<img src="${firstUrl}" alt="${escapeHtml(sceneName)}">` : '<span class="history-card-empty">暂无图片</span>'}</div>
        <div class="history-card-label">${escapeHtml(sceneName)}</div>
      </div>
      `;
    }).join('');

    listEl.querySelectorAll('.history-card').forEach((card, i) => {
      card.addEventListener('click', () => {
        const item = res.data[i];
        const matIndex = MATERIALS.findIndex(m => m.key === item.scene);
        if (matIndex >= 0) selectMaterial(matIndex);
        $('textInput').value = item.prompt || '';
        $('sizeWidth').value = item.width;
        $('sizeHeight').value = item.height;
        validateSize();
        currentResultImages = item.imagePaths || [];
        currentResultIndex = 0;
        resultSourcePage = 'history';
        $('loadingWrap').style.display = 'none';
        $('errorState').style.display = 'none';
        $('resultWrap').style.display = 'flex';
        showResultImage(0);
        showPage('result');
      });
    });
  } catch {
    list.innerHTML = `
      <div class="history-empty">
        <div class="history-empty-icon">😵</div>
        <div class="history-empty-title">加载失败</div>
        <div class="history-empty-desc">请稍后重试</div>
      </div>`;
  }
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
