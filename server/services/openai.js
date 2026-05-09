const config = require('../config');
const db = require('../database');

const MODEL = config.OPENAI_MODEL || 'gpt-image-2';

function getConfig() {
  const apiKey = db.getSetting('openai_api_key') || config.OPENAI_API_KEY;
  const baseURL = (db.getSetting('openai_base_url') || config.OPENAI_BASE_URL || '').replace(/\/+$/, '');
  if (!apiKey) throw new Error('未配置 API Key');
  if (!baseURL) throw new Error('未配置 API Base URL');
  return { apiKey, baseURL };
}

// 物料统一数据源（前后端共享唯一来源）
const MATERIALS = [
  { key: 'door', name: '门头招牌', icon: '🏪', desc: 'Wide horizontal signboard layout, strong long-distance readability, bold title hierarchy, clean flat print design.', defaultW: 300, defaultH: 100, defaultAspectRatio: '3:1' },
  { key: 'poster', name: '活动海报', icon: '📢', desc: 'Vertical promotional poster layout, strong visual hierarchy, bold headline area, clean flat print design.', defaultW: 40, defaultH: 60, defaultAspectRatio: '2:3' },
  { key: 'menu', name: '餐饮菜单', icon: '🍜', desc: 'Restaurant menu flat layout, clear category sections, readable dish and price hierarchy, clean print-ready design.', defaultW: 21, defaultH: 30, defaultAspectRatio: '2:3' },
  { key: 'rollup', name: '易拉宝', icon: '🎞️', desc: 'Tall vertical exhibition banner layout, top-to-bottom information flow, bold title with supporting sections, flat print-ready design.', defaultW: 80, defaultH: 200, defaultAspectRatio: '2:5' },
  { key: 'wall', name: '文化墙', icon: '🏢', desc: 'Wide horizontal corporate information layout, modular section arrangement, strong visual order, flat print-ready design.', defaultW: 300, defaultH: 150, defaultAspectRatio: '2:1' },
  { key: 'brochure', name: '宣传册封面', icon: '📒', desc: 'Brochure cover spread layout, editorial composition, clean premium typography, flat print-ready design.', defaultW: 42, defaultH: 29, defaultAspectRatio: '3:2' },
  { key: 'flyer', name: '宣传单页', icon: '📄', desc: 'Promotional flyer flat layout, concise information blocks, clear call-to-action hierarchy, print-ready design.', defaultW: 21, defaultH: 30, defaultAspectRatio: '2:3' },
  { key: 'ecom', name: '电商主图', icon: '🛒', desc: 'Square product-focused flat composition, strong product emphasis, clean promotional layout, e-commerce ready design.', defaultW: 1024, defaultH: 1024, unit: 'px', defaultAspectRatio: '1:1' },
  { key: 'moment', name: '朋友圈配图', icon: '📱', desc: 'Square social-share flat composition, clean visual hierarchy, strong readability on mobile, share-ready design.', defaultW: 1024, defaultH: 1024, unit: 'px', defaultAspectRatio: '1:1' },
];

const SCENE_DESCS = Object.fromEntries(
  MATERIALS.map(m => [m.key, m.desc])
);

// 根据物料宽高比选择 grsai aspectRatio（与 grsai 支持的预设完全对齐）
// gpt-image-2-vip: 动态计算像素值（OpenAI 约束：边长≤3840，16的倍数，长短边比≤3:1，总像素655360~8294400）
// gpt-image-2: 预设比例字符串（从大到小排列，ratio > maxRatio 时命中）
const RATIO_PRESETS = [
  // 横版（ratio > 1）
  { maxRatio: 3.5, value: '3:1' },
  { maxRatio: 2.5, value: '21:9' },
  { maxRatio: 1.9, value: '2:1' },
  { maxRatio: 1.8, value: '16:9' },
  { maxRatio: 1.35, value: '3:2' },
  { maxRatio: 1.1, value: '4:3' },
  // 竖版（ratio < 1）
  { maxRatio: 0.95, value: '1:1' },
  { maxRatio: 0.8, value: '5:4' },
  { maxRatio: 0.75, value: '4:5' },
  { maxRatio: 0.6, value: '3:4' },
  { maxRatio: 0.5, value: '2:3' },
  { maxRatio: 0.44, value: '9:16' },
  { maxRatio: 0.38, value: '1:2' },
  { maxRatio: 0.25, value: '9:21' },
  { maxRatio: Infinity, value: '1:3' },
];

function calcPixelSize(width, height, maxEdge = 2048) {
  const MAX_EDGE = maxEdge;
  const MIN_EDGE = 256;
  const MAX_RATIO = 3;
  const MIN_TOTAL = 262144;
  const MAX_TOTAL = 4194304;

  let ratio = width / height;
  if (ratio > MAX_RATIO) ratio = MAX_RATIO;
  if (ratio < 1 / MAX_RATIO) ratio = 1 / MAX_RATIO;

  // 计算最大可能的像素尺寸
  // w * h = MAX_TOTAL, w/h = ratio → w = sqrt(MAX_TOTAL * ratio), h = sqrt(MAX_TOTAL / ratio)
  let w = Math.round(Math.sqrt(MAX_TOTAL * ratio));
  let h = Math.round(Math.sqrt(MAX_TOTAL / ratio));

  // 限制最大边长
  if (w > MAX_EDGE) { w = MAX_EDGE; h = Math.round(w / ratio); }
  if (h > MAX_EDGE) { h = MAX_EDGE; w = Math.round(h * ratio); }

  // 对齐到 16 的倍数
  w = Math.round(w / 16) * 16;
  h = Math.round(h / 16) * 16;

  // 确保最小值
  if (w < MIN_EDGE) w = MIN_EDGE;
  if (h < MIN_EDGE) h = MIN_EDGE;

  // 确保总像素不低于最小值
  if (w * h < MIN_TOTAL) {
    const scale = Math.sqrt(MIN_TOTAL / (w * h));
    w = Math.round(w * scale / 16) * 16;
    h = Math.round(h * scale / 16) * 16;
  }

  return `${w}x${h}`;
}

function calcAspectRatio(width, height, quality = 'default') {
  if (quality === '2k') {
    return { model: 'gpt-image-2-vip', aspectRatio: calcPixelSize(width, height, 2048) };
  }
  if (quality === '4k') {
    return { model: 'gpt-image-2-vip', aspectRatio: calcPixelSize(width, height, 3840) };
  }
  const ratio = width / height;
  for (const r of RATIO_PRESETS) {
    if (ratio <= r.maxRatio) continue;
    return { model: MODEL, aspectRatio: r.value };
  }
  return { model: MODEL, aspectRatio: '1:3' };
}

function buildPrompt(scene, userText, feedback = null) {
  const desc = SCENE_DESCS[scene] || 'Commercial design.';
  const safeFeedback = feedback ? String(feedback).slice(0, 100) : null;
  const feedbackRule = safeFeedback
    ? `User feedback on previous result: ${safeFeedback}\nPlease adjust accordingly.`
    : '';

  const lines = [
    `${desc}`,
    'Generate a flat, print-ready 2D design draft only.',
    'Do not create mockups, photographed product setups, physical display stands, storefront exteriors, wall installations, lighting fixtures, room scenes, or any real-world environmental presentation.',
    'Do not show frames, supports, walls, store facades, shelves, spotlights, hanging structures, or perspective display effects.',
    'Focus only on the flat artwork itself.',
    'All text must be in Chinese.',
    feedbackRule,
    '',
    'Render ONLY the following text exactly as written. Do not add or modify any text.',
    '---',
    userText.trim(),
    '---',
  ];

  return lines.filter(Boolean).join('\n');
}

function buildEditPrompt(scene, userText, feedback = null) {
  const desc = SCENE_DESCS[scene] || 'Commercial design.';
  const safeFeedback = feedback ? String(feedback).slice(0, 100) : null;
  const feedbackRule = safeFeedback
    ? `Requested changes:\n${safeFeedback}`
    : '';

  const lines = [
    `This image is a ${desc.toLowerCase().trim()}`,
    'Edit the provided image with minimal necessary changes.',
    'Preserve the original layout, composition, hierarchy, typography placement, and key visual elements as much as possible.',
    'Do not redesign the whole image unless the requested changes require it.',
    'Only modify the aspects explicitly requested below.',
    'Keep the output as a flat, print-ready 2D design draft only.',
    'Do not turn it into a mockup, photographed real-world setup, display stand, storefront scene, wall scene, lighting scene, or any environmental rendering.',
    'Do not add frames, supports, walls, store facades, spotlights, room perspective, or physical presentation context.',
    'All text in the image must remain in Chinese.',
    feedbackRule,
    '',
    'Keep the following text exactly unchanged. Do not add, remove, or rewrite any text.',
    '---',
    userText.trim(),
    '---',
  ];

  return lines.filter(Boolean).join('\n');
}

// 下载图片 URL 到 Buffer
const MAX_DOWNLOAD_SIZE = 32 * 1024 * 1024;

async function downloadToBuffer(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`下载图片失败: HTTP ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_DOWNLOAD_SIZE) throw new Error('下载文件超过32MB限制');
      return Buffer.from(arrayBuffer);
    } catch (e) {
      if (attempt < retries) {
        console.log(`[grsai] 下载重试 ${attempt + 1}/${retries}: ${e.message}`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      } else {
        throw e;
      }
    }
  }
}

// 解析 NDJSON 流式响应，返回 { result, taskId }
async function parseStreamResponse(response) {
  let buffer = '';
  let taskId = null;
  for await (const chunk of response.body) {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const data = JSON.parse(trimmed);
        if (data.id) taskId = data.id;
        if (data.progress !== undefined) {
          console.log(`[grsai] 进度: ${data.progress}%`);
        }
        if (data.status === 'succeeded' || data.status === 'failed') {
          return { result: data, taskId };
        }
        // grsai 错误格式：{ code: -1, msg: "error message" }
        if (data.code !== undefined && data.code !== 0) {
          throw new Error(data.msg || data.error || 'API 请求失败');
        }
      } catch (e) {
        if (e.message !== 'skip') throw e;
      }
    }
  }
  // process remaining buffer
  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer.trim());
      if (data.id) taskId = data.id;
      if (data.status === 'succeeded' || data.status === 'failed') return { result: data, taskId };
      if (data.code !== undefined && data.code !== 0) throw new Error(data.msg || data.error || 'API 请求失败');
    } catch (e) {
      if (e.message && !e.message.includes('JSON')) throw e;
    }
  }
  return { result: null, taskId };
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'EAI_AGAIN']);

function isTransientError(error) {
  if (TRANSIENT_CODES.has(error.code)) return true;
  if (error.cause && TRANSIENT_CODES.has(error.cause.code)) return true;
  return false;
}

const MAX_GENERATE_RETRIES = 2;

async function generateImage(options) {
  const { scene, userText, width, height, referenceImage, feedback, quality = 'default' } = options;
  const { model: genModel, aspectRatio } = calcAspectRatio(width, height, quality);
  const prompt = referenceImage
    ? buildEditPrompt(scene, userText, feedback)
    : buildPrompt(scene, userText, feedback);

  for (let attempt = 0; attempt <= MAX_GENERATE_RETRIES; attempt++) {
    try {
      const { apiKey, baseURL } = getConfig();

      const body = {
        model: genModel,
        prompt,
        aspectRatio,
        quality: 'auto',
        webHook: '-1',
        shutProgress: true,
      };

      // 参考图（需要公开可访问的 URL）
      if (referenceImage) {
        body.urls = [referenceImage];
      }

      console.log('[grsai] 生图请求:', { scene, aspectRatio, model: genModel, quality, attempt, promptLen: prompt.length });

      const res = await fetch(`${baseURL}/v1/draw/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new Error(`API 请求失败: HTTP ${res.status} ${errText}`);
        err.status = res.status;
        throw err;
      }

      let result;

      // 判断响应类型：流式 NDJSON 还是 JSON（webHook=-1 时返回 JSON）
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json') && !contentType.includes('ndjson')) {
        // JSON 模式（webHook=-1 时返回 task id）
        const json = await res.json();
        if (json.code !== 0) throw new Error(json.msg || '提交任务失败');
        const taskId = json.data?.id;
        if (!taskId) throw new Error('未获取到任务 ID');
        console.log('[grsai] 任务已提交:', taskId);

        // 轮询结果
        result = await pollResult(baseURL, apiKey, taskId);
      } else {
        // 流式 NDJSON 模式
        const streamResult = await parseStreamResponse(res);
        result = streamResult.result;

        // 流式连接断开但有 taskId，回退到轮询
        if (!result && streamResult.taskId) {
          console.log('[grsai] 流式中断，回退轮询:', streamResult.taskId);
          result = await pollResult(baseURL, apiKey, streamResult.taskId);
        }
      }

      if (!result) throw new Error('未收到生成结果');

      if (result.status === 'failed') {
        const reason = result.failure_reason === 'output_moderation' ? '输出内容违规'
          : result.failure_reason === 'input_moderation' ? '输入内容违规'
          : result.error || '生成失败';
        throw new Error(reason);
      }

      const imageUrl = result.results?.[0]?.url || result.url;
      if (!imageUrl) throw new Error('未返回图片 URL');

      console.log('[grsai] 下载图片...');
      const buffer = await downloadToBuffer(imageUrl);
      console.log('[grsai] 生成成功');
      return [{ index: 0, buffer }];

    } catch (error) {
      const transient = isTransientError(error);
      console.error('[grsai] 生成失败 (attempt', attempt, '):', error.status, error.message, error.code || '');

      if (transient && attempt < MAX_GENERATE_RETRIES) {
        const delay = 3000 * (attempt + 1);
        console.log(`[grsai] 瞬态错误，${delay}ms 后重试...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const msg = error.status === 429 ? '请求过于频繁，请稍后重试'
        : error.status === 403 ? 'API 访问被拒绝，请检查配置'
        : error.status === 401 ? 'API Key 无效，请重新配置'
        : error.code === 'ETIMEDOUT' ? '请求超时，请重试'
        : error.code === 'ECONNRESET' ? '连接中断，请重试'
        : error.message || '图片生成服务暂时不可用';
      throw new Error(msg);
    }
  }
}

// 轮询获取结果（自适应间隔：前10秒1秒轮询，之后2秒）
async function pollResult(baseURL, apiKey, taskId) {
  const deadline = Date.now() + 600000;
  const fastEnd = Date.now() + 10000;
  while (Date.now() < deadline) {
    const interval = Date.now() < fastEnd ? 1000 : 2000;
    await new Promise(r => setTimeout(r, interval));

    const res = await fetch(`${baseURL}/v1/draw/result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ id: taskId }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) continue;

    const json = await res.json();
    const data = json.data;
    if (!data) continue;

    if (data.progress !== undefined) {
      console.log(`[grsai] 轮询进度: ${data.progress}%`);
    }

    if (data.status === 'succeeded' || data.status === 'failed') {
      return data;
    }
  }
  throw new Error('生成超时（3分钟）');
}

module.exports = {
  generateImage,
  buildPrompt,
  buildEditPrompt,
  calcAspectRatio,
  MODEL,
  SCENE_DESCS,
  MATERIALS
};
