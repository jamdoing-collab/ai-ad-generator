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

> 说明：上述点数相关配置当前要求为**正整数**。如果填写为非法值（如 `0`、负数、`12abc`、`1.5点`），服务会在启动时打印配置警告，并回退到默认值。

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

## JWT 兼容配置提示

- `JWT_FALLBACK_SECRETS` 仅用于兼容历史 token。
- 生产环境建议保持为空；当前服务在生产环境启动时，如果该配置非空，会打印警告日志。

## 端口与公网域名

- Railway 运行时会注入 `PORT`，日志里可能显示 `localhost:8080`。
- 生成公网域名时，要填写服务实际监听的端口（通常是 `8080`，以日志为准）。

## 当前限制

1. 数据库为 `SQL.js`，以内存运行并持久化到本地数据文件。
2. `uploads/` 为本地文件目录，重新部署/迁移后不保证长期保留。
3. 适合演示、试用，不适合长期生产使用。

## 生成与修改行为补充

- `/api/config/gen-size` 当前会结合 `scene + width + height` 一起校验尺寸范围，而不是只按通用数值范围计算。
- 生成后的“修改图片”支持内容感知的版式调整：如果修改要求明确提出增删改内容，模型会在尽量保留原设计风格的前提下做最小必要的布局再平衡。

## 长期生产建议

后续若正式上线，建议迁移：

- 数据库：`better-sqlite3` 或 PostgreSQL
- 上传文件：对象存储 / 图床
- 鉴权：微信登录 / 短信登录

## GitHub 自动部署到 ECS（推荐）

如果你希望以后本地改完代码后，只要 push 到 GitHub 就自动更新服务器，建议改成 Git 驱动的部署，而不是继续手工上传 `/root/web`。

### 1. 先在服务器上把项目目录改成 Git 仓库

当前 `/root/web` 如果不是 `git clone` 下来的，GitHub Actions 无法直接远程执行 `git pull`。建议先：

1. 备份当前目录
2. 用仓库重新 clone 到服务器
3. 把现有 `.env`、上传目录、数据文件按需迁回

例如：

```bash
mv /root/web /root/web.backup.$(date +%Y%m%d%H%M%S)
git clone https://github.com/jamdoing-collab/ai-ad-generator.git /root/web
```

然后把生产环境的：

- `server/.env`
- `data/`
- `uploads/`

从备份目录迁回。

### 2. 在服务器上放置部署脚本

把仓库里的脚本上传/复制到：

```bash
/root/deploy-ai-ad-generator.sh
```

并赋予执行权限：

```bash
chmod +x /root/deploy-ai-ad-generator.sh
```

脚本内容来自仓库：

```bash
scripts/deploy-server.sh
```

### 3. 在 GitHub 仓库里配置 Secrets

进入 GitHub 仓库：

```text
Settings -> Secrets and variables -> Actions
```

新增以下 Secrets：

- `ECS_HOST`：服务器公网 IP，例如 `47.106.106.166`
- `ECS_USER`：登录用户，例如 `root`
- `ECS_SSH_KEY`：用于登录服务器的私钥内容（推荐单独部署用 SSH key）

### 4. 工作流生效方式

仓库已包含：

```text
.github/workflows/deploy.yml
```

作用：当 `main` 分支有新提交时，GitHub Actions 会通过 SSH 登录 ECS，并执行：

```bash
bash /root/deploy-ai-ad-generator.sh
```

### 5. 自动部署完成后会做什么

部署脚本默认会：

1. `git fetch` / `reset --hard origin/main`
2. `npm install --omit=dev`
3. `pm2 restart ai-ad-generator --update-env`
4. `pm2 save`
5. 如已安装 Nginx，则 `nginx -t && systemctl reload nginx`
6. 本机 `curl http://127.0.0.1:3003` 健康检查

### 6. 注意事项

- 服务器必须已安装：`git`、`node`、`npm`、`pm2`
- `/root/web` 必须是真正的 Git 仓库，而不是手工上传目录
- `server/.env` 不建议提交到 GitHub，应保留在服务器本地
- 如果使用 `SQL.js + data/ + uploads/`，部署时要注意这些目录的持久化和备份
