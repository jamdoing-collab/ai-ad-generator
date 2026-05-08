const API_BASE = '/api';
// 与后端 openai.js MATERIALS 保持同步，仅 API 不可用时降级使用
const FALLBACK_MATERIALS = [
  { key: 'door', name: '门头招牌', icon: '🏪', defaultW: 300, defaultH: 100, defaultAspectRatio: '3:1' },
  { key: 'poster', name: '活动海报', icon: '📢', defaultW: 40, defaultH: 60, defaultAspectRatio: '2:3' },
  { key: 'menu', name: '餐饮菜单', icon: '🍜', defaultW: 21, defaultH: 30, defaultAspectRatio: '2:3' },
  { key: 'rollup', name: '易拉宝', icon: '🎞️', defaultW: 80, defaultH: 200, defaultAspectRatio: '2:5' },
  { key: 'wall', name: '文化墙', icon: '🏢', defaultW: 300, defaultH: 150, defaultAspectRatio: '2:1' },
  { key: 'brochure', name: '宣传册封面', icon: '📒', defaultW: 42, defaultH: 29, defaultAspectRatio: '3:2' },
  { key: 'flyer', name: '宣传单页', icon: '📄', defaultW: 21, defaultH: 30, defaultAspectRatio: '2:3' },
  { key: 'ecom', name: '电商主图', icon: '🛒', defaultW: 1024, defaultH: 1024, unit: 'px', defaultAspectRatio: '1:1' },
  { key: 'moment', name: '朋友圈配图', icon: '📱', defaultW: 1024, defaultH: 1024, unit: 'px', defaultAspectRatio: '1:1' },
];
let MATERIALS = FALLBACK_MATERIALS;

let currentMaterial = MATERIALS[0];
let authToken = localStorage.getItem('token');
let userInfo = null;
let uploadedImages = [];
let selectedQuality = 'default';
let isGenerating = false;
let currentResultImages = [];
let currentResultImagesPath = [];
let currentResultIndex = 0;
let currentResultImageId = null;
let currentResultScene = null;
let currentResultText = null;
let currentResultWidth = null;
let currentResultHeight = null;
let currentDetailMode = 'result';
let resultSourcePage = 'generate';
let selectedPackageIndex = 0;
let packages = [];
let authExpiredNotified = false;
let toastTimer = null;
let pendingMineAfterLogin = false;
let inviteInfo = null;
let pendingInviteCode = localStorage.getItem('inviteCode') || '';

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

function getCurrentCost() {
  return selectedQuality === '4k' ? 3 : selectedQuality === '2k' ? 2 : 1;
}

const QUALITY_HINTS = {
  default: { cost: 1, text: 'AI创作中...', sub: '预计需要15-30秒', label: '1K，消耗 1 点' },
  '2k': { cost: 2, text: 'AI高清创作中...', sub: '预计需要30-60秒', label: '2K，消耗 2 点' },
  '4k': { cost: 3, text: 'AI超清创作中...', sub: '预计需要1-2分钟', label: '4K，消耗 3 点' }
};

function getCurrentQualityConfig() {
  return QUALITY_HINTS[selectedQuality] || QUALITY_HINTS.default;
}

function getCurrentMaterialUnit(sceneKey = currentResultScene) {
  return MATERIALS.find(m => m.key === sceneKey)?.unit || 'cm';
}

function copyText(text, successMessage = '已复制') {
  if (!text) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMessage);
    }).catch(() => fallbackCopy(text, successMessage));
  } else {
    fallbackCopy(text, successMessage);
  }
}

function getCurrentDetailShareLink() {
  if (currentResultImageId) {
    return `${window.location.origin}${window.location.pathname}?share=${currentResultImageId}`;
  }
  return `${window.location.origin}${window.location.pathname}`;
}

function renderResultDetailMeta() {
  const sceneName = MATERIALS.find(m => m.key === currentResultScene)?.name || currentResultScene || '-';
  const unit = getCurrentMaterialUnit(currentResultScene);
  const size = currentResultWidth && currentResultHeight ? `${currentResultWidth}×${currentResultHeight}${unit}` : '-';
  setText('resultDetailScene', sceneName);
  setText('resultDetailSize', size);
}

function applyDetailResult({ scene, text, width, height, images, imageId, points, mode }) {
  currentResultScene = scene;
  currentResultText = text;
  currentResultWidth = width;
  currentResultHeight = height;
  currentResultImages = images.map(img => img.url);
  currentResultImagesPath = images.map(img => img.localPath || '');
  currentResultImageId = imageId || currentResultImageId;
  currentResultIndex = 0;
  currentDetailMode = mode;
  if (userInfo && typeof points === 'number') {
    userInfo.points = points;
  }
}

function openModifyModal(mode) {
  currentDetailMode = mode;
  setText('modifyModalTitle', mode === 'history' ? '修改历史图片' : '修改当前图片');
  setText('modifyCost', getCurrentCost());
  if ($('modifyFeedbackInput')) $('modifyFeedbackInput').value = '';
  if ($('modifySubmitBtn')) {
    $('modifySubmitBtn').disabled = false;
    $('modifySubmitBtn').textContent = '重新生成';
  }
  setDisplay('modifyModal', 'flex');
}

function closeModifyModal() {
  setDisplay('modifyModal', 'none');
}

function captureInviteCode() {
  const params = new URLSearchParams(window.location.search);
  const ref = (params.get('ref') || params.get('invite') || '').trim();
  if (/^[a-zA-Z0-9_-]{4,32}$/.test(ref)) {
    pendingInviteCode = ref;
    localStorage.setItem('inviteCode', ref);
  }
}

function getShareImageId() {
  const params = new URLSearchParams(window.location.search);
  const share = (params.get('share') || '').trim();
  const id = Number(share);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function parseDetailHash() {
  const hash = (window.location.hash || '').replace(/^#/, '');
  if (!hash) return null;
  const match = hash.match(/^(history|result)-(\d+)$/);
  if (!match) return null;
  return { mode: match[1], id: Number(match[2]) };
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

function fallbackCopy(text, successMessage = '已复制') {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast(successMessage);
  } catch {
    showToast('复制失败，请手动复制');
  }
  document.body.removeChild(ta);
}

async function api(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const controller = new AbortController();
  const timeout = options.timeout || (endpoint.startsWith('/generate/') ? 660000 : 90000);
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
  } catch {
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
  captureInviteCode();
  await loadMaterials();
  renderMaterials();
  renderUploadedImages();
  bindSizeStepEvents();
  bindMobileEvents();
  selectMaterial(0);
  checkAuth();
  window.addEventListener('hashchange', () => handleDetailHash());
  setTimeout(() => handleDetailHash(), 0);
}

async function handleDetailHash() {
  const shareId = getShareImageId();
  if (shareId) {
    await loadPublicDetailById(shareId);
    return;
  }
  const detail = parseDetailHash();
  if (!detail || !authToken) return;
  if (detail.mode === 'history') {
    await loadHistoryDetailById(detail.id);
  }
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
    const shareId = getShareImageId();
    if (shareId) {
      loadPublicDetailById(shareId);
    }
  } else if (res.code !== 401) {
    userInfo = null;
    updateMineDisplay();
  }
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
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

  $('textInput').addEventListener('input', () => {
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
    const config = getCurrentQualityConfig();
    $('qualityHint').textContent = config.label;
    $('genBtn').textContent = `开始生成（${config.cost}点）`;
  });

  $('genBtn').addEventListener('click', () => startGenerate());

  $('mineEntry').addEventListener('click', () => {
    if (!userInfo) {
      pendingMineAfterLogin = true;
      showToast('请先登录后进入个人中心');
      showLoginModal();
      return;
    }
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
  $('inviteBtn').addEventListener('click', loadInvitePage);
  $('inviteBackBtn').addEventListener('click', () => showPage('mine'));
  $('copyInviteBtn').addEventListener('click', copyInviteLink);

  $('retryBtn').addEventListener('click', () => {
    showPage('generate');
  });
  $('downloadBtn').addEventListener('click', downloadImage);
  $('modifyBtn').addEventListener('click', () => openModifyModal('result'));
  $('shareBtn').addEventListener('click', () => copyText(getCurrentDetailShareLink(), '详情页链接已复制'));

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
    if (window.location.hash.startsWith('#result-')) history.replaceState(null, '', window.location.pathname + window.location.search);
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
  $('historyDetailBackBtn').addEventListener('click', () => {
    if (window.location.hash.startsWith('#history-')) history.replaceState(null, '', window.location.pathname + window.location.search);
    showPage('history');
  });
  $('historyDetailSaveBtn').addEventListener('click', downloadImage);
  $('historyDetailModifyBtn').addEventListener('click', () => openModifyModal('history'));
  $('historyDetailShareBtn').addEventListener('click', () => copyText(getCurrentDetailShareLink(), '详情页链接已复制'));

  $('contactBtn').addEventListener('click', () => {
    setDisplay('contactModal', 'flex');
  });

  $('loginModalClose').addEventListener('click', hideLoginModal);
    $('loginModal').addEventListener('click', event => {
      if (event.target.id === 'loginModal') hideLoginModal();
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
    setLoginModalMode(isLogin ? 'register' : 'login');
  });

  $('rechargeClose').addEventListener('click', () => setDisplay('rechargeModal', 'none'));
  $('rechargeModal').addEventListener('click', e => {
    if (e.target.id === 'rechargeModal') setDisplay('rechargeModal', 'none');
  });

  $('contactModalClose').addEventListener('click', () => setDisplay('contactModal', 'none'));
  $('contactModal').addEventListener('click', e => {
    if (e.target.id === 'contactModal') setDisplay('contactModal', 'none');
  });

  $('modifyModalClose').addEventListener('click', closeModifyModal);
  $('modifyModal').addEventListener('click', e => {
    if (e.target.id === 'modifyModal') closeModifyModal();
  });
  $('modifySubmitBtn').addEventListener('click', () => {
    if (currentDetailMode === 'history') {
      regenerateCurrentDetail('history');
      return;
    }
    regenerateCurrentDetail('result');
  });

  $('copyWechatBtn').addEventListener('click', () => {
    const wechat = $('contactWechat').textContent.trim();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(wechat).then(() => {
        showToast('微信号已复制');
      }).catch(() => fallbackCopy(wechat, '微信号已复制'));
    } else {
      fallbackCopy(wechat, '微信号已复制');
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

async function selectMaterial(index) {
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
  $('sizeHint').classList.remove('error');
  $('sizeHint').textContent = `生成比例 ${currentMaterial.defaultAspectRatio || await calcAspectRatio(currentMaterial.defaultW, currentMaterial.defaultH)}`;

  // 保持当前画质选择，更新提示文案
  const config = getCurrentQualityConfig();
  $('qualityHint').textContent = config.label;
  $('genBtn').textContent = `开始生成（${config.cost}点）`;
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
  updateTweakCost();
  renderResultDetailMeta();
}

function waitForImageLoad(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => reject(new Error('结果图片加载失败'));
    img.src = url;
  });
}

function updateTweakCost() {
  if ($('modifyCost')) $('modifyCost').textContent = getCurrentCost();
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
  } else if (text.length > 600) {
    setTextInputErrorState('textInput', true);
    showToast('文字内容不能超过600个字符');
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
  const needPoints = getCurrentCost();
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

  const msg = getCurrentQualityConfig();
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
      applyDetailResult({
        scene: currentMaterial.key,
        text,
        width,
        height,
        images: res.data.images,
        imageId: res.data.imageId || null,
        points: res.data.points,
        mode: 'result'
      });
      $('loadingWrap').style.display = 'none';
      $('resultWrap').style.display = 'flex';
      showResultImage(0);
      window.location.hash = `result-${currentResultImageId}`;
      updateMineDisplay();

      waitForImageLoad(currentResultImages[0]).catch(() => {
        showToast('生成成功，但结果图片加载失败，请稍后重试查看历史记录');
      });
    } else {
      const msg = res.code === 503
        ? '服务未配置密钥，请联系管理员'
        : res.code === 409
          ? '相同内容正在生成中，请稍候查看结果'
          : res.message;
      throw new Error(msg);
    }
  } catch (err) {
    if (err.message && err.message.includes('未配置密钥')) {
      showToast(err.message);
      showPage('generate');
    } else if (err.message && err.message.includes('正在生成中')) {
      showToast(err.message);
      $('loadingWrap').style.display = 'flex';
      $('resultWrap').style.display = 'none';
      $('errorState').style.display = 'none';
    } else {
      $('loadingWrap').style.display = 'none';
      $('errorState').style.display = 'flex';
      $('errorMsg').textContent = err.message || '生成请求失败，请稍后重试';
    }
  } finally {
    isGenerating = false;
    $('genBtn').disabled = false;
    $('genBtn').textContent = `开始生成（${getCurrentCost()}点）`;
  }
}

async function regenerateCurrentDetail(mode) {
  if (isGenerating) return;
  if (!authToken || !userInfo) { showLoginModal(); return; }

  const feedback = ($('modifyFeedbackInput').value || '').trim();
  const needPoints = getCurrentCost();
  if (userInfo.points < needPoints) { alert('点数不足，请充值'); showRechargeModal(); return; }

  isGenerating = true;
  $('modifySubmitBtn').disabled = true;
  $('modifySubmitBtn').textContent = '重新生成中...';

  const localPath = currentResultImagesPath[currentResultIndex] || '';
  const refSrc = localPath || currentResultImages[currentResultIndex];

  try {
    const res = await api('/generate/image', {
      method: 'POST',
      body: JSON.stringify({
        scene: currentResultScene,
        text: currentResultText,
        width: currentResultWidth,
        height: currentResultHeight,
        quality: selectedQuality,
        referenceImage: refSrc,
        feedback: feedback || null
      })
    });

    if (res.code === 0) {
      if (!res.data.images?.length) throw new Error('生成结果为空，请重试');

      applyDetailResult({
        scene: currentResultScene,
        text: currentResultText,
        width: currentResultWidth,
        height: currentResultHeight,
        images: res.data.images,
        imageId: res.data.imageId || currentResultImageId,
        points: res.data.points,
        mode
      });

      if (mode === 'history') {
        $('historyDetailImg').src = currentResultImages[0];
        waitForImageLoad(currentResultImages[0]).catch(() => {
          showToast('修改成功，但结果图片加载失败，请稍后重试查看历史记录');
        });
      } else {
        showResultImage(0);
      }
      updateMineDisplay();
      closeModifyModal();
      window.location.hash = `${mode}-${currentResultImageId}`;
      showToast('调整完成');
    } else {
      const msg = res.code === 503
        ? '服务未配置密钥，请联系管理员'
        : res.code === 409
          ? '相同内容正在生成中，请稍候查看结果'
          : res.message;
      throw new Error(msg);
    }
  } catch (err) {
    if (err.message && err.message.includes('正在生成中')) {
      showToast(err.message);
      closeModifyModal();
    } else {
      showToast(err.message || '调整失败，请重试');
    }
  } finally {
    isGenerating = false;
    $('modifySubmitBtn').disabled = false;
    $('modifySubmitBtn').textContent = '重新生成';
  }
}

function downloadImage() {
  const url = currentResultImages[currentResultIndex];
  if (!url) return;
  const materialName = MATERIALS.find(m => m.key === currentResultScene)?.name || currentMaterial?.name || 'design';
  const filename = `AI广告-${materialName}-${Date.now()}.png`;
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

function setDetailActionsVisible(canEdit) {
  setDisplay('modifyBtn', canEdit ? '' : 'none');
  setDisplay('historyDetailModifyBtn', canEdit ? '' : 'none');
}

async function loadHistoryDetailById(imageId) {
  const res = await api(`/generate/history/${imageId}`);
  if (res.code !== 0 || !res.data) {
    showToast(res.message || '历史详情加载失败');
    return;
  }
  $('historyDetailPageTitle').textContent = '作品详情';
  setDetailActionsVisible(true);
  loadHistoryDetail(res.data);
}

async function loadPublicDetailById(imageId) {
  const res = await api(`/generate/public/${imageId}`);
  if (res.code !== 0 || !res.data) {
    showToast(res.message || '分享详情加载失败');
    return;
  }

  const item = res.data;
  const fullUrl = item.imagePaths?.[0];
  const sceneName = MATERIALS.find(m => m.key === item.scene)?.name || item.scene;
  const width = item.width || 0;
  const height = item.height || 0;
  const unit = item.scene && MATERIALS.find(m => m.key === item.scene)?.unit || 'cm';
  const sizeStr = width && height ? `${width}×${height}${unit}` : '-';
  const dateStr = item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '-';
  const canEdit = Boolean(userInfo && item.ownerUserId === userInfo.id);

  $('historyDetailPageTitle').textContent = '作品详情';
  $('historyDetailImg').src = fullUrl || '';
  $('historyDetailScene').textContent = sceneName;
  $('historyDetailSize').textContent = sizeStr;
  $('historyDetailDate').textContent = dateStr;

  applyDetailResult({
    scene: item.scene,
    text: item.prompt,
    width,
    height,
    images: [{ url: fullUrl, localPath: '' }],
    imageId: item.id,
    points: userInfo?.points ?? 0,
    mode: 'history'
  });

  setDetailActionsVisible(canEdit);
  updateTweakCost();
  renderResultDetailMeta();
  showPage('historyDetail');
  waitForImageLoad(fullUrl).catch(() => {
    showToast('作品详情已打开，但图片加载失败，请稍后重试');
  });
}

function setLoginModalMode(mode) {
  const isRegister = mode === 'register';
  $('loginModalTitle').textContent = isRegister ? '注册' : '登录';
  $('modalLoginBtn').textContent = isRegister ? '注册' : '登录';
  $('loginSwitchBtn').textContent = isRegister ? '已有账号？去登录' : '没有账号？去注册';
  if ($('modalLoginUsername')) {
    $('modalLoginUsername').placeholder = '请输入手机号码';
  }
  if ($('modalLoginPassword')) {
    $('modalLoginPassword').placeholder = isRegister ? '请输入6位以上数字' : '请输入密码';
  }
  setDisplay('inviteRegisterHint', isRegister && pendingInviteCode ? 'block' : 'none');
}

function showLoginModal() {
  setLoginModalMode(pendingInviteCode ? 'register' : 'login');
  setDisplay('loginModal', 'flex');
}

function hideLoginModal() {
  setDisplay('loginModal', 'none');
  if ($('modalLoginUsername')) $('modalLoginUsername').value = '';
  if ($('modalLoginPassword')) $('modalLoginPassword').value = '';
}

async function doLogin(username, password, options = {}) {
  if (!username || !password) { alert('请输入手机号和密码'); return; }

  const isRegister = $('loginModalTitle').textContent === '注册';
  const endpoint = isRegister ? '/auth/register' : '/auth/login';
  const payload = { username, password };
  if (isRegister && pendingInviteCode) {
    payload.inviteCode = pendingInviteCode;
  }

  const res = await api(endpoint, {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  if (res.code === 0) {
    authToken = res.data.token;
    userInfo = res.data.user;
    localStorage.setItem('token', authToken);
    if (isRegister) {
      localStorage.removeItem('inviteCode');
      pendingInviteCode = '';
    }
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
    setDisplay('inviteBtn', 'flex');
    setDisplay('logoutBtn', 'block');
    setDisplay('adminEntry', userInfo.is_admin ? 'flex' : 'none');
  } else {
    setText('mineAvatar', '👤');
    setText('mineName', '未登录');
    setText('mineHint', '登录后可使用AI生成功能');
    setDisplay('mineLoginBtn', 'block');
    setDisplay('pointsCard', 'none');
    setDisplay('historyBtn', 'none');
    setDisplay('inviteBtn', 'none');
    setDisplay('logoutBtn', 'none');
    setDisplay('adminEntry', 'none');
  }
}

function getInviteLink() {
  const code = inviteInfo?.inviteCode || userInfo?.invite_code;
  if (!code) return '';
  return `${window.location.origin}${window.location.pathname}?ref=${encodeURIComponent(code)}`;
}

async function loadInvitePage() {
  if (!userInfo) {
    showLoginModal();
    return;
  }

  showPage('invite');
  setText('inviteLink', '邀请链接生成中...');

  const res = await api('/user/invite');
  if (res.code !== 0) {
    showToast(res.message || '邀请信息加载失败');
    setText('inviteLink', '暂时无法生成邀请链接');
    return;
  }

  inviteInfo = res.data;
  const summary = inviteInfo.summary || {};
  setText('inviteCount', summary.invitedCount || 0);
  setText('inviteEffectiveCount', summary.effectiveCount || 0);
  setText('inviteRewardPoints', summary.rewardPoints || 0);
  setText('inviteLink', getInviteLink());
}

function copyInviteLink() {
  const link = getInviteLink();
  if (!link) {
    showToast('邀请链接暂不可用');
    return;
  }

  if (navigator.clipboard) {
    navigator.clipboard.writeText(link).then(() => {
      showToast('邀请链接已复制');
    }).catch(() => fallbackCopy(link, '邀请链接已复制'));
  } else {
    fallbackCopy(link, '邀请链接已复制');
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
let historyLoadFailed = false;
const HISTORY_BATCH = 10;

function renderHistoryLoadMore(listEl) {
  if (!listEl) return;
  const existing = $('historyLoadMoreWrap');
  if (existing) existing.remove();
  if (historyDone || historyOffset === 0) return;

  const wrap = document.createElement('div');
  wrap.id = 'historyLoadMoreWrap';
  wrap.className = 'history-load-more-wrap';
  wrap.innerHTML = `<button class="btn-action btn-regen history-load-more-btn" id="historyLoadMoreBtn" type="button">${historyLoading ? '加载中...' : '加载更多'}</button>`;
  listEl.parentNode?.appendChild(wrap);

  const btn = $('historyLoadMoreBtn');
  if (btn) {
    btn.disabled = historyLoading;
    btn.addEventListener('click', async () => {
      await loadMoreHistory(listEl);
    });
  }
}

function renderHistoryItems(items, listEl) {
  const html = items.map(item => {
    const imgUrl = item.thumbUrl || item.imagePaths?.[0];
    const fullUrl = item.imagePaths?.[0];
    const sceneName = MATERIALS.find(m => m.key === item.scene)?.name || item.scene;
    const width = item.width || '';
    const height = item.height || '';
    const sizeStr = width && height ? `${width}×${height}` : '';
    return `
    <div class="history-card" 
      data-id="${item.id}" 
      data-full-url="${escapeHtml(fullUrl || '')}"
      data-scene="${escapeHtml(item.scene || '')}"
      data-prompt="${escapeHtml(item.prompt || '')}"
      data-width="${width}"
      data-height="${height}"
      data-size="${sizeStr}"
      data-date="${item.createdAt || ''}">
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
        loadHistoryDetail(item);
      });
    }
  });
}

async function loadMoreHistory(listEl) {
  if (historyLoading || historyDone) return;
  historyLoading = true;
  historyLoadFailed = false;
  renderHistoryLoadMore(listEl);

  try {
    const res = await api(`/generate/history?limit=${HISTORY_BATCH}&offset=${historyOffset}`);
    if (res.code !== 0 || !res.data?.length) {
      historyDone = true;
      return;
    }
    renderHistoryItems(res.data, listEl);
    historyOffset += res.data.length;
    if (res.data.length < HISTORY_BATCH) historyDone = true;
  } catch {
    historyLoadFailed = true;
  } finally {
    historyLoading = false;
    renderHistoryLoadMore(listEl);
  }
}

async function loadHistory() {
  showPage('history');
  const list = $('historyList');
  if (!list) return;

  historyOffset = 0;
  historyLoading = false;
  historyDone = false;
  historyLoadFailed = false;

  list.innerHTML = '<div class="history-list" id="historyListInner"></div>';
  const listEl = $('historyListInner');

  await loadMoreHistory(listEl);

  if (historyOffset === 0) {
    list.innerHTML = historyLoadFailed ? `
    <div class="history-empty history-error-state">
      <div class="history-empty-icon">⚠️</div>
      <div class="history-empty-title">加载失败</div>
      <div class="history-empty-desc">点击重试后重新加载历史记录</div>
      <button class="error-btn history-retry-btn" id="historyRetryBtn">点击重试</button>
    </div>` : `
    <div class="history-empty">
      <div class="history-empty-icon">🎨</div>
      <div class="history-empty-title">暂无生成记录</div>
      <div class="history-empty-desc">去创作你的第一张AI广告设计吧</div>
    </div>`;

    if (historyLoadFailed) {
      const retryBtn = $('historyRetryBtn');
      if (retryBtn) retryBtn.addEventListener('click', () => loadHistory());
    }
    return;
  }

  renderHistoryLoadMore(listEl);
}

function loadHistoryDetail(item) {
  const fullUrl = item.imagePaths?.[0];
  const sceneName = MATERIALS.find(m => m.key === item.scene)?.name || item.scene;
  const width = item.width || 0;
  const height = item.height || 0;
  const unit = item.scene && MATERIALS.find(m => m.key === item.scene)?.unit || 'cm';
  const sizeStr = width && height ? `${width}×${height}${unit}` : '-';
  const dateStr = item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '-';

  $('historyDetailImg').src = fullUrl || '';
  $('historyDetailScene').textContent = sceneName;
  $('historyDetailSize').textContent = sizeStr;
  $('historyDetailDate').textContent = dateStr;

  applyDetailResult({
    scene: item.scene,
    text: item.prompt,
    width,
    height,
    images: [{ url: fullUrl, localPath: fullUrl }],
    imageId: item.id,
    points: userInfo?.points ?? 0,
    mode: 'history'
  });

  updateTweakCost();
  renderResultDetailMeta();
  window.location.hash = `history-${item.id}`;
  showPage('historyDetail');
  waitForImageLoad(fullUrl).catch(() => {
    showToast('历史详情已打开，但图片加载失败，请稍后重试');
  });
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
