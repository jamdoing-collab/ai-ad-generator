const express = require('express');
const openai = require('../services/openai');

const router = express.Router();

router.get('/materials', (req, res) => {
  res.json({ code: 0, data: openai.MATERIALS });
});

router.get('/gen-size', (req, res) => {
  const w = parseFloat(req.query.width);
  const h = parseFloat(req.query.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > 4096 || h > 4096) {
    return res.status(400).json({ code: 400, message: '无效尺寸参数（范围1-4096）' });
  }
  const result = openai.calcAspectRatio(w, h);
  res.json({ code: 0, data: { aspectRatio: result.aspectRatio } });
});

module.exports = router;
