const express = require('express');
const openai = require('../services/openai');

const router = express.Router();

router.get('/materials', (req, res) => {
  res.json({ code: 0, data: openai.MATERIALS });
});

router.get('/gen-size', (req, res) => {
  const scene = String(req.query.scene || '').trim();
  const w = parseFloat(req.query.width);
  const h = parseFloat(req.query.height);

  if (!scene) {
    return res.status(400).json({ code: 400, message: '缺少物料类型' });
  }

  const materialDef = openai.MATERIALS.find(item => item.key === scene);
  if (!materialDef) {
    return res.status(400).json({ code: 400, message: '无效物料类型' });
  }

  const isPixelUnit = materialDef.unit === 'px';
  const minSize = isPixelUnit ? 64 : 1;
  const maxSize = isPixelUnit ? 4096 : 300;
  const unitLabel = isPixelUnit ? 'px' : 'cm';

  if (!Number.isFinite(w) || !Number.isFinite(h) || w < minSize || h < minSize || w > maxSize || h > maxSize) {
    return res.status(400).json({ code: 400, message: `无效尺寸参数（范围${minSize}-${maxSize}${unitLabel}）` });
  }

  const ratio = w / h;
  if (ratio > 10 || ratio < 0.1) {
    return res.status(400).json({ code: 400, message: '宽高比超出 1:10 到 10:1 范围' });
  }

  const result = openai.calcAspectRatio(w, h);
  res.json({ code: 0, data: { aspectRatio: result.aspectRatio } });
});

module.exports = router;
