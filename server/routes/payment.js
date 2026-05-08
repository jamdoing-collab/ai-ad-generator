const express = require('express');
const auth = require('../middleware/auth');
const db = require('../database');
const config = require('../config');

const router = express.Router();

router.use(auth);

// 创建订单
router.post('/create', (req, res) => {
  const { packageId } = req.body;
  const pkg = config.RECHARGE_PACKAGES[packageId];
  
  if (!pkg) {
    return res.status(400).json({ code: 400, message: '无效的套餐' });
  }
  
  try {
    const orderId = db.createOrder(req.userId, packageId, pkg.price, pkg.points);

    // 开发环境模拟第三方支付异步通知；生产环境必须由真实支付回调完成订单。
    if (config.NODE_ENV !== 'production') {
      setTimeout(() => {
        try {
          const result = db.completeOrderAtomic(orderId);
          if (!result.ok) {
            console.error('[模拟支付失败]', result.message);
          }
        } catch (err) {
          console.error('[模拟支付完成错误]', err);
        }
      }, 1500);
    }
    
    res.json({
      code: 0,
      data: {
        orderId,
        packageId,
        amount: (pkg.price / 100).toFixed(2),
        points: pkg.points
      }
    });
  } catch (err) {
    console.error('[创建订单错误]', err);
    res.status(500).json({ code: 500, message: '创建订单失败' });
  }
});

// 确认支付（客户端轮询用）
router.post('/confirm', (req, res) => {
  const { orderId } = req.body;
  
  try {
    const order = db.getOrderById(orderId);
    
    if (!order) {
      return res.status(404).json({ code: 404, message: '订单不存在' });
    }
    
    if (order.user_id !== req.userId) {
      return res.status(403).json({ code: 403, message: '无权操作' });
    }
    
  if (order.status === 'completed') {
    const user = db.getUserById(req.userId);
    return res.json({ code: 0, data: { success: true, points: user?.points || 0 } });
  }

  if (order.status === 'pending') {
    const elapsed = Date.now() - new Date(order.created_at).getTime();
    if (elapsed > 5 * 60 * 1000) {
      return res.json({ code: 0, data: { success: false, status: 'expired' } });
    }
  }

  res.json({ code: 0, data: { success: false, status: order.status } });
  } catch (err) {
    console.error('[确认支付错误]', err);
    res.status(500).json({ code: 500, message: '查询失败' });
  }
});

// 我的订单
router.get('/orders', (req, res) => {
  const orders = db.getUserOrders(req.userId);
  
  const data = orders.map(order => ({
    id: order.id,
    packageId: order.package_id,
    amount: (order.amount / 100).toFixed(2),
    points: order.points,
    status: order.status,
    created_at: order.created_at
  }));
  
  res.json({ code: 0, data });
});

module.exports = router;
