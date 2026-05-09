const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const config = require('../config');
const openai = require('../services/openai');
const sharp = require('sharp');
const generateRateLimit = require('../middleware/generateRateLimit');

const router = express.Router();
const uploadsRoot = path.resolve(__dirname, '../../uploads');
const generatedDir = path.join(uploadsRoot, 'generated');
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const activeGenerateRequests = new Map();
const recentGenerateResults = new Map();
const REQUEST_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of activeGenerateRequests) {
    if (now - entry.startedAt > REQUEST_DEDUPE_WINDOW_MS) activeGenerateRequests.delete(key);
  }
  for (const [key, entry] of recentGenerateResults) {
    if (now - entry.createdAt > REQUEST_DEDUPE_WINDOW_MS) recentGenerateResults.delete(key);
  }
}, 30 * 1000);

// 上传图片到 imgbb 图床，返回公网 URL
async function uploadToImageHost(filePath) {
  const apiKey = db.getSetting('image_host_token') || config.IMAGE_HOST_TOKEN;
  if (!apiKey) throw new Error('未配置图床 API Token，请在管理后台设置');

  // 压缩图片（限制 1200px 长边，JPEG 80% 质量）减少上传时间
  const compressed = await sharp(filePath)
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  const base64Image = compressed.toString('base64');

  const form = new FormData();
  form.append('key', apiKey);
  form.append('image', base64Image);

  const res = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`图床上传失败: HTTP ${res.status}`);
  const json = await res.json();

  if (json.success && json.data?.url) return json.data.url;

  throw new Error(json.error?.message || '图床上传失败');
}

// 可用的场景类型（从统一物料数据源生成）
const VALID_SCENES = openai.MATERIALS.map(m => m.key);

function formatImageDetail(image, { imageUrlBuilder, thumbUrl, includeOwnerUserId = false }) {
  const detail = {
    id: image.id,
    scene: image.scene,
    prompt: image.prompt,
    width: image.width,
    height: image.height,
    quality: image.quality || 'default',
    imagePaths: image.image_paths.map((_, i) => imageUrlBuilder(image.id, i)),
    localPaths: image.image_paths,
    thumbUrl,
    createdAt: image.created_at
  };

  if (includeOwnerUserId) {
    detail.ownerUserId = image.user_id;
  }

  return detail;
}

function buildGenerateResponse({ imageId, imagePaths, points, token }) {
  return {
    code: 0,
    data: {
      images: imagePaths.map((path, i) => ({ index: i, url: `/image/${imageId}?index=${i}&token=${token}`, localPath: path })),
      points,
      imageId
    }
  };
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function buildGenerateRequestKey(userId, payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ userId, ...payload }))
    .digest('hex');
}

async function validateImageFormat(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    const validFormats = ['jpeg', 'jpg', 'png', 'webp'];
    if (!validFormats.includes(metadata.format)) {
      throw new Error('不支持的图片格式');
    }
    return true;
  } catch {
    throw new Error('无效的图片文件');
  }
}

function resolveUploadPath(uploadPath) {
  const normalizedPath = path.normalize(uploadPath).replace(/^(\.\.[\/\\])+/, '');
  const resolvedPath = path.resolve(uploadsRoot, normalizedPath);
  const resolvedRoot = path.resolve(uploadsRoot);

  if (!resolvedPath.startsWith(resolvedRoot + path.sep) && resolvedPath !== resolvedRoot) {
    throw new Error('非法参考图路径');
  }

  return fs.realpath(resolvedPath).then(realPath => {
    if (!realPath.startsWith(resolvedRoot + path.sep) && realPath !== resolvedRoot) {
      throw new Error('非法参考图路径');
    }
    return realPath;
  });
}

// 生成图片
router.post('/image', async (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }

  const requestId = uuidv4().slice(0, 8);
  let referenceImagePaths = [];
  let tempReferenceImagePaths = [];
  let pointsCost = config.POINTS_PER_GENERATE;
  let generateRequestKey = null;

  try {
    const { scene, text, width = 60, height = 90, quality = 'default', referenceImage, feedback } = req.body;
    const feedbackText = feedback ? String(feedback).trim() || null : null;
    const referenceImages = Array.isArray(referenceImage)
      ? referenceImage.filter(Boolean).slice(0, 3)
      : (referenceImage ? [referenceImage] : []);
    const parsedWidth = parsePositiveNumber(width);
    const parsedHeight = parsePositiveNumber(height);
    const validQualities = ['default', '2k', '4k'];
    const qualityLevel = validQualities.includes(quality) ? quality : 'default';
    pointsCost = qualityLevel === '4k' ? config.POINTS_PER_GENERATE_4K : qualityLevel === '2k' ? config.POINTS_PER_GENERATE_HD : config.POINTS_PER_GENERATE;

    // 验证参数
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ code: 400, message: '请输入要生成的文字内容' });
    }

    if (text.trim().length > 600) {
      return res.status(400).json({ code: 400, message: '文字内容不能超过600个字符' });
    }
    
    if (!scene || !VALID_SCENES.includes(scene)) {
      return res.status(400).json({ code: 400, message: '请选择有效的物料类型' });
    }

    const materialDef = openai.MATERIALS.find(m => m.key === scene);
    const isPixelUnit = materialDef && materialDef.unit === 'px';
    const minSize = isPixelUnit ? 64 : 1;
    const maxSize = isPixelUnit ? 4096 : 300;
    const unitLabel = isPixelUnit ? 'px' : 'cm';

    if (!Number.isFinite(parsedWidth) || !Number.isFinite(parsedHeight) || parsedWidth < minSize || parsedWidth > maxSize || parsedHeight < minSize || parsedHeight > maxSize) {
      return res.status(400).json({ code: 400, message: `尺寸范围必须在 ${minSize}-${maxSize}${unitLabel} 之间` });
    }

    const ratio = parsedWidth / parsedHeight;
    if (ratio > 10 || ratio < 0.1) {
      return res.status(400).json({ code: 400, message: '宽高比超出 1:10 到 10:1 范围' });
    }

    generateRequestKey = buildGenerateRequestKey(req.userId, {
      scene,
      text: text.trim(),
      width: parsedWidth,
      height: parsedHeight,
      quality: qualityLevel,
      referenceImage: referenceImages,
      feedback: feedbackText
    });

    const cached = recentGenerateResults.get(generateRequestKey);
    if (cached) {
      console.log(`[生成请求:${requestId}] 命中近期成功结果缓存 key=${generateRequestKey.slice(0, 8)}`);
      return res.json(buildGenerateResponse({
        imageId: cached.imageId,
        imagePaths: cached.imagePaths,
        points: cached.points,
        token: req.token
      }));
    }

    if (activeGenerateRequests.has(generateRequestKey)) {
      console.warn(`[生成请求:${requestId}] 重复提交被拦截 key=${generateRequestKey.slice(0, 8)}`);
      return res.status(409).json({ code: 409, message: '相同内容正在生成中，请稍候查看结果' });
    }

    activeGenerateRequests.set(generateRequestKey, { startedAt: Date.now(), requestId, userId: req.userId });
    console.log(`[生成请求:${requestId}] 开始 user=${req.userId} scene=${scene} quality=${qualityLevel}`);

    // 原子扣点（防止并发竞态）
    const newPoints = db.updateUserPoints(req.userId, -pointsCost);
    if (newPoints === false) {
      activeGenerateRequests.delete(generateRequestKey);
      return res.status(402).json({ code: 402, message: '点数不足，请先充值' });
    }
    db.logPointChange(req.userId, 'generate', -pointsCost, `生成${scene}图片（${qualityLevel}）`);
    console.log(`[生成请求:${requestId}] 扣点成功 points=${newPoints}`);

    // 处理参考图
    for (const ref of referenceImages) {
      console.log(`[生成请求:${requestId}] 处理参考图 input=${String(ref).slice(0, 120)}`);
      if (ref.startsWith('data:')) {
        const base64Data = ref.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length > MAX_REFERENCE_IMAGE_BYTES) {
          throw new Error('参考图大小不能超过10MB');
        }
        const tempPath = path.join(__dirname, '../../uploads/temp', `ref_${Date.now()}_${uuidv4().slice(0, 6)}.png`);
        const tempDir = path.dirname(tempPath);
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(tempPath, buffer);
        await validateImageFormat(tempPath);
        console.log(`[生成请求:${requestId}] 参考图 base64 写入并校验成功 path=${tempPath}`);
        referenceImagePaths.push(tempPath);
        tempReferenceImagePaths.push(tempPath);
      } else if (ref.startsWith('/uploads/')) {
        const resolved = await resolveUploadPath(ref);
        console.log(`[生成请求:${requestId}] 参考图路径解析成功 path=${resolved}`);
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat) throw new Error('参考图文件不存在');
        console.log(`[生成请求:${requestId}] 参考图文件存在 size=${stat.size}`);
        await validateImageFormat(resolved);
        console.log(`[生成请求:${requestId}] 参考图文件格式校验成功 path=${resolved}`);
        referenceImagePaths.push(resolved);
      } else {
        console.error(`[生成请求:${requestId}] 参考图格式不支持 value=${String(ref).slice(0, 120)}`);
        throw new Error('不支持的参考图格式');
      }
    }
    
    // 上传参考图到图床，获取公网 URL
    let referenceImageUrls = [];
    if (referenceImagePaths.length > 0) {
      console.log(`[生成请求:${requestId}] 开始上传参考图 count=${referenceImagePaths.length}`);
      referenceImageUrls = await Promise.all(referenceImagePaths.map(uploadToImageHost));
      console.log(`[生成请求:${requestId}] 图床上传成功 urls=${referenceImageUrls.length}`);
    }

    // 调用 grsai 生成
    const generatedImages = await openai.generateImage({
      scene,
      userText: text.trim(),
      width: parsedWidth,
      height: parsedHeight,
      quality: qualityLevel,
      referenceImage: referenceImageUrls,
      feedback: feedbackText
    });
    console.log(`[生成请求:${requestId}] grsai 成功返回 images=${generatedImages.length}`);
    
    // 保存图片到文件
    await fs.mkdir(generatedDir, { recursive: true });
    const imagePaths = [];
    for (let i = 0; i < generatedImages.length; i++) {
      const filename = `${scene}_${parsedWidth}x${parsedHeight}${unitLabel}_${uuidv4().slice(0,8)}.png`;
      const filepath = path.join(generatedDir, filename);
      await fs.writeFile(filepath, generatedImages[i].buffer);
      imagePaths.push(`/uploads/generated/${filename}`);
    }
    console.log(`[生成请求:${requestId}] 本地写文件成功 count=${imagePaths.length}`);

    // 保存到数据库
    let imageId;
    try {
      imageId = db.saveImage(req.userId, scene, text.trim(), parsedWidth, parsedHeight, imagePaths, qualityLevel);
    } catch (saveErr) {
      console.error(`[生成请求:${requestId}] 保存图片记录失败`, saveErr.message);
      for (const p of imagePaths) {
        try { await fs.unlink(path.join(uploadsRoot, p.replace(/^\/uploads\//, ''))); } catch {
        }
      }
      return res.status(500).json({ code: 500, message: '生成成功但保存记录失败，请联系客服' });
    }

    console.log(`[生成请求:${requestId}] 数据库保存成功 imageId=${imageId}`);
    if (db.getUserImageCount(req.userId) === 1) {
      const inviteReward = db.awardInviteReward(
        req.userId,
        'first_generate',
        config.INVITE_FIRST_GENERATE_POINTS,
        '邀请好友首次生成奖励'
      );
      if (inviteReward.ok) {
        console.log(`[邀请奖励] 邀请者:${inviteReward.inviterUserId} 被邀请者:${req.userId}`);
      }
    }
    
    const responsePayload = buildGenerateResponse({
      imageId,
      imagePaths,
      points: newPoints,
      token: req.token
    });

    recentGenerateResults.set(generateRequestKey, { createdAt: Date.now(), imageId, imagePaths, points: newPoints });
    activeGenerateRequests.delete(generateRequestKey);
    console.log(`[生成请求:${requestId}] 响应返回成功`);
    res.json(responsePayload);
    
  } catch (err) {
    // 生成失败，退还点数
    const refund = db.updateUserPoints(req.userId, pointsCost);
    if (refund !== false) {
      db.logPointChange(req.userId, 'refund', pointsCost, '生成失败退还点数');
    } else {
      console.error('[退还点数失败] 用户不存在:', req.userId);
    }
    generateRateLimit.refundAttempt(req.userId);

    if (generateRequestKey) activeGenerateRequests.delete(generateRequestKey);
    console.error(`[生成请求:${requestId}] 生成图片错误`, err.message);
    if (err.message && (err.message.includes('未配置 API Key') || err.message.includes('未配置 API Base URL'))) {
      return res.status(503).json({ code: 503, message: '图片生成服务未配置，请联系管理员设置 API Key' });
    }
    res.status(500).json({ code: 500, message: '生成失败，请稍后重试' });
  } finally {
    for (const tempPath of tempReferenceImagePaths) {
      try { await fs.unlink(tempPath); } catch {
      }
    }
  }
});

// 我的生成记录
router.get('/history', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const images = db.getUserImages(req.userId, limit, offset);
  
  const data = images.map(img => formatImageDetail(img, {
    imageUrlBuilder: (id, index) => `/image/${id}?index=${index}&token=${req.token}`,
    thumbUrl: `/thumb/${img.id}?token=${req.token}`
  }));
  
  res.set('Cache-Control', 'no-store');
  res.json({ code: 0, data });
});

router.get('/history/:id', async (req, res) => {
  const imageId = parseInt(req.params.id, 10);
  if (!imageId) {
    return res.status(400).json({ code: 400, message: '无效的图片ID' });
  }

  const image = db.getImageById(imageId);
  if (!image) {
    return res.status(404).json({ code: 404, message: '图片不存在' });
  }

  if (image.user_id !== req.userId) {
    const user = db.getUserById(req.userId);
    if (!user || !user.is_admin) {
      return res.status(403).json({ code: 403, message: '无权访问' });
    }
  }

  res.set('Cache-Control', 'no-store');
  res.json({
    code: 0,
    data: formatImageDetail(image, {
      imageUrlBuilder: (id, index) => `/image/${id}?index=${index}&token=${req.token}`,
      thumbUrl: `/thumb/${image.id}?token=${req.token}`
    })
  });
});

router.get('/public/:id', async (req, res) => {
  const imageId = parseInt(req.params.id, 10);
  if (!imageId) {
    return res.status(400).json({ code: 400, message: '无效的图片ID' });
  }

  const image = db.getImageById(imageId);
  if (!image) {
    return res.status(404).json({ code: 404, message: '图片不存在' });
  }

  res.set('Cache-Control', 'no-store');
  res.json({
    code: 0,
    data: formatImageDetail(image, {
      imageUrlBuilder: (id, index) => `/share/image/${id}?index=${index}`,
      thumbUrl: `/share/thumb/${image.id}`,
      includeOwnerUserId: true
    })
  });
});

module.exports = router;
