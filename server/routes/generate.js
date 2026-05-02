const express = require('express');
const path = require('path');
const fs = require('fs/promises');
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

fs.mkdir(generatedDir, { recursive: true }).catch(() => {});

// 可用的场景类型（从统一物料数据源生成）
const VALID_SCENES = openai.MATERIALS.map(m => m.key);

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

async function validateImageFormat(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    const validFormats = ['jpeg', 'jpg', 'png', 'webp'];
    if (!validFormats.includes(metadata.format)) {
      throw new Error('不支持的图片格式');
    }
    return true;
  } catch (err) {
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

  return resolvedPath;
}

// 生成图片
router.post('/image', async (req, res) => {
  if (!req.userId) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }

  let referenceImagePath = null;
  let shouldCleanupTemp = false;
  let pointsCost = config.POINTS_PER_GENERATE;

  try {
    const { scene, text, width = 60, height = 90, quality = 'default', referenceImage, feedback } = req.body;
    const parsedWidth = parsePositiveNumber(width);
    const parsedHeight = parsePositiveNumber(height);
    const validQualities = ['default', '2k', '4k'];
    const qualityLevel = validQualities.includes(quality) ? quality : 'default';
    pointsCost = qualityLevel === '4k' ? config.POINTS_PER_GENERATE_4K : qualityLevel === '2k' ? config.POINTS_PER_GENERATE_HD : config.POINTS_PER_GENERATE;

    // 验证参数
    if (!text || text.trim().length === 0) {
      return res.status(400).json({ code: 400, message: '请输入要生成的文字内容' });
    }

    if (text.trim().length > 200) {
      return res.status(400).json({ code: 400, message: '文字内容不能超过200个字符' });
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

    // 原子扣点（防止并发竞态）
    const newPoints = db.updateUserPoints(req.userId, -pointsCost);
    if (newPoints === false) {
      return res.status(402).json({ code: 402, message: '点数不足，请先充值' });
    }
    db.logPointChange(req.userId, 'generate', -pointsCost, `生成${scene}图片（${qualityLevel}）`);

    console.log(`[生成请求] 用户:${req.userId} 场景:${scene}`);
    
    // 处理参考图
    if (referenceImage) {
      if (referenceImage.startsWith('data:')) {
        // Base64 图片，保存到临时文件
        const base64Data = referenceImage.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        if (buffer.length > MAX_REFERENCE_IMAGE_BYTES) {
          throw new Error('参考图大小不能超过10MB');
        }
        const tempPath = path.join(__dirname, '../../uploads/temp', `ref_${Date.now()}.png`);

        const tempDir = path.dirname(tempPath);
        await fs.mkdir(tempDir, { recursive: true });
        await fs.writeFile(tempPath, buffer);

        // 校验图片格式
        await validateImageFormat(tempPath);

        referenceImagePath = tempPath;
        shouldCleanupTemp = true;
      } else if (referenceImage.startsWith('/uploads/')) {
        const resolved = resolveUploadPath(referenceImage);
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat) throw new Error('参考图文件不存在');
        const realPath = await fs.realpath(resolved);
        const resolvedRoot = path.resolve(uploadsRoot);
        if (!realPath.startsWith(resolvedRoot + path.sep) && realPath !== resolvedRoot) {
          throw new Error('非法参考图路径');
        }
        referenceImagePath = realPath;
        await validateImageFormat(referenceImagePath);
      } else {
        throw new Error('不支持的参考图格式');
      }
    }
    
    // 上传参考图到图床，获取公网 URL
    let referenceImageUrl = null;
    if (referenceImagePath) {
      referenceImageUrl = await uploadToImageHost(referenceImagePath);
      console.log('[图床上传成功]', referenceImageUrl);
    }

    // 调用 grsai 生成
    const generatedImages = await openai.generateImage({
      scene,
      userText: text.trim(),
      width: parsedWidth,
      height: parsedHeight,
      quality: qualityLevel,
      referenceImage: referenceImageUrl,
      feedback: (feedback && typeof feedback.trim === 'function') ? feedback.trim() : null
    });
    
    // 保存图片到文件
    const imagePaths = [];
    for (let i = 0; i < generatedImages.length; i++) {
      const unitLabel = isPixelUnit ? 'px' : 'cm';
      const filename = `${scene}_${parsedWidth}x${parsedHeight}${unitLabel}_${uuidv4().slice(0,8)}.png`;
      const filepath = path.join(generatedDir, filename);
      await fs.writeFile(filepath, generatedImages[i].buffer);
      imagePaths.push(`/uploads/generated/${filename}`);
    }

    // 保存到数据库
    let imageId;
    try {
      imageId = db.saveImage(req.userId, scene, text.trim(), parsedWidth, parsedHeight, imagePaths);
    } catch (saveErr) {
      console.error('[保存图片记录失败]', saveErr.message);
      for (const p of imagePaths) {
        try { await fs.unlink(path.join(uploadsRoot, p.replace(/^\/uploads\//, ''))); } catch (e) {}
      }
      return res.status(500).json({ code: 500, message: '生成成功但保存记录失败，请联系客服' });
    }

    console.log(`[生成成功] 图片ID:${imageId}`);
    
    res.json({
      code: 0,
      data: {
        images: imagePaths.map((url, i) => ({ index: i, url })),
        points: newPoints,
        imageId
      }
    });
    
  } catch (err) {
    // 生成失败，退还点数
    const refund = db.updateUserPoints(req.userId, pointsCost);
    if (refund !== false) {
      db.logPointChange(req.userId, 'refund', pointsCost, '生成失败退还点数');
    } else {
      console.error('[退还点数失败] 用户不存在:', req.userId);
    }
    generateRateLimit.refundAttempt(req.userId);

    console.error('[生成图片错误]', err.message);
    if (err.message && (err.message.includes('未配置 API Key') || err.message.includes('未配置 API Base URL'))) {
      return res.status(503).json({ code: 503, message: '图片生成服务未配置，请联系管理员设置 API Key' });
    }
    res.status(500).json({ code: 500, message: '生成失败，请稍后重试' });
  } finally {
    if (shouldCleanupTemp && referenceImagePath) {
      try { await fs.unlink(referenceImagePath); } catch (cleanupErr) {}
    }
  }
});

// 我的生成记录
router.get('/history', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const images = db.getUserImages(req.userId, limit, offset);
  
  const data = images.map(img => ({
    id: img.id,
    scene: img.scene,
    prompt: img.prompt,
    width: img.width,
    height: img.height,
    imagePaths: img.image_paths,
    thumbUrl: `/api/generate/image/${img.id}?thumb=1`,
    createdAt: img.created_at
  }));
  
  res.set('Cache-Control', 'no-store');
  res.json({ code: 0, data });
});

// 获取图片文件（用于前端请求）
router.get('/image/:id', async (req, res) => {
  try {
    const imageId = parseInt(req.params.id);
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

    const index = parseInt(req.query.index) || 0;
    const imagePath = image.image_paths[index];

    if (!imagePath) {
      return res.status(404).json({ code: 404, message: '图片不存在' });
    }

  const fullPath = path.resolve(uploadsRoot, imagePath.replace(/^\/uploads\//, ''));
  if (!fullPath.startsWith(uploadsRoot + path.sep)) {
    return res.status(403).json({ code: 403, message: '非法图片路径' });
  }
  try { await fs.stat(fullPath); } catch { return res.status(404).json({ code: 404, message: '图片文件不存在' }); }

  // 缩略图模式：?thumb=1 返回 300px 宽的 JPEG
  if (req.query.thumb === '1') {
    const thumbBuffer = await sharp(fullPath)
      .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=604800');
    return res.send(thumbBuffer);
  }

  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  const data = await fs.readFile(fullPath);
  res.send(data);
  } catch (err) {
    console.error('[获取图片错误]', err);
    res.status(500).json({ code: 500, message: '获取图片失败' });
  }
});

module.exports = router;
