# 部署说明（Railway）

## 平台说明

当前项目可直接部署到 Railway，适合演示和轻量试用。

> 注意：项目当前仍使用 `SQL.js + 本地数据文件 + uploads/`，不适合作为长期正式生产方案。

## 必需环境变量

```env
NODE_ENV=production
JWT_SECRET=<随机长字符串>
OPENAI_API_KEY=<grsai key>
OPENAI_BASE_URL=https://grsai.dakka.com.cn
OPENAI_MODEL=gpt-image-2
```

## 推荐环境变量

```env
ALLOWED_ORIGINS=https://your-app.up.railway.app
RAILWAY_PUBLIC_DOMAIN=your-app.up.railway.app
IMAGE_HOST_TOKEN=<imgbb key>
ADMIN_USERNAMES=jamdo
NEW_USER_POINTS=10
POINTS_PER_GENERATE=1
POINTS_PER_GENERATE_HD=2
POINTS_PER_GENERATE_4K=3
INVITE_NEW_USER_POINTS=2
INVITE_FIRST_GENERATE_POINTS=2
```

## 管理员启动引导（可选）

```env
ADMIN_BOOTSTRAP_USERNAME=jamdo
ADMIN_BOOTSTRAP_PASSWORD=900213
ADMIN_BOOTSTRAP_FORCE_RESET=false
```

- 默认行为：仅当管理员账号不存在时自动创建。
- 若要强制重置已有管理员密码，设置：

```env
ADMIN_BOOTSTRAP_FORCE_RESET=true
```

## 端口与公网域名

- Railway 运行时会注入 `PORT`，日志里可能显示 `localhost:8080`。
- 生成公网域名时，要填写服务实际监听的端口（通常是 `8080`，以日志为准）。

## 当前限制

1. 数据库为 `SQL.js`，以内存运行并持久化到本地数据文件。
2. `uploads/` 为本地文件目录，重新部署/迁移后不保证长期保留。
3. 适合演示、试用，不适合长期生产使用。

## 长期生产建议

后续若正式上线，建议迁移：

- 数据库：`better-sqlite3` 或 PostgreSQL
- 上传文件：对象存储 / 图床
- 鉴权：微信登录 / 短信登录
