# AI 广告设计系统 (H5 网页版)

基于 AI 图片生成模型的广告物料生成系统。

## 功能特性

- 8 种物料类型：门头招牌、活动海报、菜单、易拉宝、文化墙、宣传单页、电商主图、朋友圈配图
- 自定义尺寸（1-300cm）
- 参考图上传（图生图）
- 用户注册/登录
- 点数系统（新用户赠送 10 点，每次生成消耗 1 点）
- 充值功能
- 生成历史记录

## 快速开始

### 1. 安装依赖

```bash
cd web
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入 API Key：

```bash
cp server/.env.example server/.env
# 编辑 server/.env，填写 OPENAI_API_KEY
```

### 3. 启动服务

```bash
npm start
```

服务将在 http://localhost:3000 启动

## API 接口

| 接口 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/api/auth/register` | POST | 注册 | 否 |
| `/api/auth/login` | POST | 登录 | 否 |
| `/api/user/info` | GET | 获取用户信息 | 是 |
| `/api/user/points` | GET | 获取点数 | 是 |
| `/api/config/materials` | GET | 获取物料类型 | 否 |
| `/api/config/gen-size` | GET | 计算生成比例 | 否 |
| `/api/generate/image` | POST | 生成图片 | 是 |
| `/api/generate/history` | GET | 生成历史 | 是 |
| `/api/payment/packages` | GET | 充值套餐 | 是 |
| `/api/payment/create` | POST | 创建订单 | 是 |
| `/api/payment/confirm` | POST | 确认支付 | 是 |

## 生图模型 API 对接说明

当前对接 grsai 平台（gpt-image-2）。

### 端点

| 功能 | 端点 | 说明 |
|------|------|------|
| 生成图片 | `POST /v1/draw/completions` | 提交生图任务 |
| 获取结果 | `POST /v1/draw/result` | 轮询任务结果 |

### 请求参数

```json
{
  "model": "gpt-image-2",
  "prompt": "提示词",
  "aspectRatio": "1:1",
  "urls": ["参考图URL（可选）"],
  "webHook": "-1",
  "shutProgress": false
}
```

### 支持的 aspectRatio

`auto`, `1:1`, `3:2`, `2:3`, `16:9`, `9:16`, `5:4`, `4:5`, `4:3`, `3:4`, `21:9`, `9:21`, `1:3`, `3:1`, `2:1`, `1:2`，以及像素值如 `1024x1024`

### Host 地址

| 节点 | 地址 |
|------|------|
| 国内直连 | `https://grsai.dakka.com.cn` |
| 海外 | `https://grsaiapi.com` |

### 响应格式（流式 NDJSON / 轮询）

```json
{
  "id": "task-id",
  "progress": 100,
  "status": "succeeded",
  "results": [{ "url": "https://..." }]
}
```

## 技术栈

- 前端：原生 HTML/CSS/JS
- 后端：Node.js + Express
- 数据库：SQL.js (SQLite)
- AI：gpt-image-2（通过 grsai 平台）

## 项目结构

```
web/
├── public/           # 前端静态文件
│   ├── index.html
│   ├── admin.html
│   ├── css/style.css
│   └── js/app.js
├── server/           # 后端服务
│   ├── index.js      # 入口文件
│   ├── config.js     # 配置
│   ├── database.js   # 数据库
│   ├── .env          # 环境变量
│   ├── middleware/   # 中间件
│   ├── routes/       # 路由
│   └── services/     # 服务层（openai.js 生图逻辑）
├── data/             # 数据库文件
├── uploads/          # 上传文件
└── package.json
```

## 配置说明

在 `server/.env` 中：

- `PORT`: 服务端口（默认 3000）
- `OPENAI_API_KEY`: grsai API Key（必需）
- `OPENAI_BASE_URL`: API 端点（默认 https://grsai.dakka.com.cn）
- `OPENAI_MODEL`: 生图模型（默认 gpt-image-2）
- `JWT_SECRET`: JWT 密钥（必需）
- `NEW_USER_POINTS`: 新用户赠送点数（默认 10）
- `POINTS_PER_GENERATE`: 每次生成消耗点数（默认 1）
