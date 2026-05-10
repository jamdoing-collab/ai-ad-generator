# AI 广告设计系统 (H5 网页版)

基于 AI 图片生成模型的广告物料生成系统。

## 功能特性

- 8 种物料类型：门头招牌、活动海报、菜单、易拉宝、文化墙、宣传单页、电商主图、朋友圈配图
- 自定义尺寸（cm 物料 1-300cm，px 物料 64-4096px）
- 画质选择：默认 / 2K / 4K（消耗不同点数）
- 参考图上传（图生图，自动上传至图床）
- 结果二次修改（支持按修改要求增删内容，并在必要时自动重平衡版式）
- 用户注册/登录（当前按手机号作为账号）
- 点数系统（新用户赠送 10 点）
- 充值功能
- 生成历史记录（缩略图加速加载）
- 管理后台（用户管理、API 配置、数据统计）
- 使用帮助页面（带截图说明）

## 快速开始

### 1. 安装依赖

```bash
cd web
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入配置：

```bash
cp server/.env.example server/.env
# 编辑 server/.env，填写必要配置
```

必需配置：
- `OPENAI_API_KEY`: grsai API Key
- `JWT_SECRET`: JWT 密钥（生产环境请使用复杂随机字符串）

可选配置：
- `IMAGE_HOST_TOKEN`: imgbb 图床 API Token（参考图功能需要）
- `ADMIN_USERNAMES`: 管理员手机号/账号（逗号分隔）

### 3. 启动服务

```bash
npm start
```

服务将在 `PORT` 指定端口启动；本地默认示例为 `http://localhost:3000`，当前开发环境常用 `3003`。

## 页面说明

| 页面 | 路径 | 说明 |
|------|------|------|
| 首页 | `/` | 物料选择、内容输入、尺寸调整、画质选择、生成 |
| 个人中心 | `/` (mineEntry) | 点数余额、充值、生成历史、使用帮助 |
| 管理后台 | `/admin.html` | 用户管理、API 配置、数据统计 |

## API 接口

| 接口 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/api/auth/register` | POST | 注册 | 否 |
| `/api/auth/login` | POST | 登录 | 否 |
| `/api/user/info` | GET | 获取用户信息 | 是 |
| `/api/user/points` | GET | 获取点数 | 是 |
| `/api/config/materials` | GET | 获取物料类型 | 否 |
| `/api/config/gen-size` | GET | 根据 `scene + width + height` 校验尺寸并计算生成比例 | 否 |
| `/api/generate/image` | POST | 生成图片 | 是 |
| `/api/generate/history` | GET | 生成历史 | 是 |
| `/image/:id` | GET | 获取完整图片 | 是 |
| `/thumb/:id` | GET | 获取缩略图 | 是 |
| `/api/payment/packages` | GET | 充值套餐 | 否 |
| `/api/payment/create` | POST | 创建订单 | 是 |
| `/api/payment/confirm` | POST | 确认支付 | 是 |
| `/api/admin/*` | 各种 | 管理后台接口 | 管理员 |

## 生图模型 API 对接说明

当前对接 grsai 平台（gpt-image-2 / gpt-image-2-vip）。

### 端点

| 功能 | 端点 | 说明 |
|------|------|------|
| 生成图片 | `POST /v1/draw/completions` | 提交生图任务 |
| 获取结果 | `POST /v1/draw/result` | 轮询任务结果 |

### 修改模式说明

生成后的“修改图片”会复用原结果作为基础图，并结合用户反馈进行二次生成。当前修改策略为：

- 默认尽量保留原有设计语言、视觉层级和关键元素
- 只有当修改要求明确要求增删改内容时，才改动对应内容
- 如果内容发生增减，模型会做最小必要的版式再平衡，避免明显空洞或过度拥挤
- 输出仍然限制为平面的、可印刷的 2D 设计稿，不转成 mockup 或真实场景图

### 画质与模型

| 画质 | 模型 | 尺寸方式 | 点数 |
|------|------|------|------|
| 默认 | gpt-image-2 | 预设比例 | 1 点 |
| 2K | gpt-image-2-vip | 像素值（max 2048） | 2 点 |
| 4K | gpt-image-2-vip | 像素值（max 3840） | 3 点 |

### Host 地址

| 节点 | 地址 |
|------|------|
| 国内直连 | `https://grsai.dakka.com.cn` |
| 海外 | `https://grsaiapi.com` |

## 技术栈

- 前端：原生 HTML/CSS/JS
- 后端：Node.js + Express
- 数据库：SQL.js (SQLite，内存运行 + 定时持久化)
- AI：gpt-image-2 / gpt-image-2-vip（通过 grsai 平台）
- 图床：imgbb（参考图上传）

## Railway 部署

已验证可部署到 Railway。详细步骤见：

- [DEPLOY.md](./DEPLOY.md)

## 配置说明补充

- `NEW_USER_POINTS`、`POINTS_PER_GENERATE`、`POINTS_PER_GENERATE_HD`、`POINTS_PER_GENERATE_4K`、`INVITE_NEW_USER_POINTS`、`INVITE_FIRST_GENERATE_POINTS` 当前要求为**正整数**。
- 如果这些环境变量填写为非法值（例如 `0`、负数、带脏后缀的字符串），服务启动时会打印配置警告并回退到默认值。
- `JWT_FALLBACK_SECRETS` 仅用于兼容旧 token；生产环境建议留空，当前启动时会给出提示警告。

## 项目结构

```
web/
├── public/              # 前端静态文件
│   ├── index.html       # 主页面
│   ├── admin.html       # 管理后台
│   ├── css/style.css    # 样式
│   ├── js/app.js        # 前端逻辑
│   └── images/help/     # 帮助页截图
├── server/              # 后端服务
│   ├── index.js         # 入口文件
│   ├── config.js        # 配置
│   ├── database.js      # 数据库（加密存储敏感设置）
│   ├── .env             # 环境变量
│   ├── .env.example     # 环境变量示例
│   ├── middleware/      # 中间件（auth、admin、rateLimit）
│   ├── routes/          # 路由
│   └── services/        # 服务层（openai.js 生图逻辑）
├── data/                # 数据库文件（ad-generator.db）
├── uploads/             # 生成的图片
│   ├── generated/       # AI 生成图片
│   └── temp/            # 临时文件（参考图处理）
└── package.json
```

## 配置说明

在 `server/.env` 中：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | 服务端口 |
| `OPENAI_API_KEY` | - | grsai API Key（必需） |
| `OPENAI_BASE_URL` | grsai.dakka.com.cn | API 端点 |
| `OPENAI_MODEL` | gpt-image-2 | 生图模型 |
| `IMAGE_HOST_TOKEN` | - | imgbb 图床 Token |
| `JWT_SECRET` | - | JWT 密钥（必需） |
| `ADMIN_USERNAMES` | - | 管理员手机号/账号（逗号分隔） |
| `NEW_USER_POINTS` | 10 | 新用户赠送点数 |
| `POINTS_PER_GENERATE` | 1 | 默认画质消耗点数 |
| `POINTS_PER_GENERATE_HD` | 2 | 2K 画质消耗点数 |
| `POINTS_PER_GENERATE_4K` | 3 | 4K 画质消耗点数 |
