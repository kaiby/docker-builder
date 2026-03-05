# Docker Builder

> 基于 Web 的 Docker 镜像构建 & 推送工具，支持 JAR 包 / Vue dist.zip 上传，使用服务器已有 Dockerfile 构建镜像，并一键推送到华为云 SWR 镜像仓库。

---

## 功能特性

- **登录鉴权** — 用户名 + 密码登录，Session 有效期 8 小时
- **基础路径隔离** — 通过 `BASE_PATH` 配置访问前缀，不暴露裸端口直接访问
- **多文件类型支持** — JAR 包（后端服务）/ Vue dist.zip（前端产物，自动解压）
- **并行分片上传** — 大文件切成 5MB 分片，4 路并发上传，支持取消
- **实时构建日志** — 流式输出 docker build / tag / push 全过程日志
- **SWR 登录指令解析** — 直接粘贴华为云完整登录指令，自动提取 Registry / 用户名 / 密码
- **镜像列表管理** — 列出本地所有 Docker 镜像，支持勾选批量删除

---

## 目录结构

```
/opt/docker-builder/
├── server.js          # Node.js 后端
├── ecosystem.config.js  # PM2 启动配置
├── package.json
├── node_modules/
└── public/
    └── index.html     # 前端单页应用
```

---

## 环境要求

| 依赖 | 版本要求 |
|---|---|
| Node.js | >= 18.x |
| npm | >= 9.x |
| Docker | 已安装并运行 |
| unzip | 系统已安装（解压 dist.zip 用） |

---

## 安装部署

### 有网络环境

```bash
# 1. 安装 Node.js（CentOS/RHEL）
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs unzip

# 2. 创建目录
mkdir -p /opt/docker-builder/public

# 3. 上传文件
cp server.js      /opt/docker-builder/
cp index.html     /opt/docker-builder/public/
cp ecosystem.config.js /opt/docker-builder/

# 4. 安装依赖
cd /opt/docker-builder
npm init -y
npm install express multer cors express-session

# 5. 安装 PM2
npm install -g pm2
```

### 离线内网环境

在**有网络的机器**上打包依赖：

```bash
# 打包 Node.js（以 18.20.4 为例）
wget https://nodejs.org/dist/v18.20.4/node-v18.20.4-linux-x64.tar.xz

# 打包项目依赖
mkdir docker-builder && cd docker-builder
npm init -y
npm install express multer cors express-session
cd .. && tar -czf docker-builder.tar.gz docker-builder/

# 打包 PM2（含依赖）
mkdir pm2-offline && cd pm2-offline
npm init -y && npm install pm2
cd .. && tar -czf pm2-offline.tar.gz pm2-offline/
```

在**内网服务器**上安装：

```bash
# 安装 Node.js
tar -xf node-v18.20.4-linux-x64.tar.xz -C /opt
mv /opt/node-v18.20.4-linux-x64 /opt/nodejs
ln -sf /opt/nodejs/bin/{node,npm,npx} /usr/local/bin/

# 部署项目
tar -xf docker-builder.tar.gz -C /opt
cp server.js /opt/docker-builder/
mkdir -p /opt/docker-builder/public
cp index.html /opt/docker-builder/public/

# 安装 PM2（软链接方式，无需联网）
tar -xf pm2-offline.tar.gz -C /opt
ln -sf /opt/pm2-offline/node_modules/.bin/pm2 /usr/local/bin/pm2
```

---

## 配置说明

编辑 `ecosystem.config.js`，按需修改以下环境变量：

```js
module.exports = {
  apps: [{
    name: 'docker-builder',
    script: 'server.js',
    cwd: '/opt/docker-builder',
    env: {
      PORT:           8080,
      BASE_PATH:      '/docker-builder',   // 访问路径前缀
      LOGIN_USER:     'admin',             // 登录用户名
      LOGIN_PASS:     'Admin@2024!',       // 登录密码（务必修改）
      SESSION_SECRET: 'your-random-string', // 随机字符串（务必修改）
      SCAN_ROOTS:     '/opt/apps,/data/deploy'  // 允许扫描的目录（逗号分隔）
    }
  }]
}
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `BASE_PATH` | `/docker-builder` | URL 访问前缀，不能以 `/` 结尾 |
| `LOGIN_USER` | `admin` | Web 登录用户名 |
| `LOGIN_PASS` | `admin123` | Web 登录密码，**生产环境必须修改** |
| `SESSION_SECRET` | `change-me-please` | Session 加密密钥，**生产环境必须修改** |
| `SCAN_ROOTS` | `/opt/apps,/data/deploy` | 服务器目录扫描根路径，逗号分隔 |

---

## 启动 & 管理

```bash
cd /opt/docker-builder

# 首次启动
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # 生成开机自启命令，复制输出的命令执行

# 日常管理
pm2 status                    # 查看运行状态
pm2 logs docker-builder       # 查看日志
pm2 restart docker-builder    # 重启服务
pm2 stop docker-builder       # 停止服务

# 临时测试（前台运行，Ctrl+C 退出）
BASE_PATH=/docker-builder \
LOGIN_USER=admin \
LOGIN_PASS=admin123 \
SESSION_SECRET=test-secret \
SCAN_ROOTS=/opt/apps,/data/deploy \
PORT=8080 \
node server.js
```

---

## 访问地址

```
http://<服务器IP>:<PORT><BASE_PATH>/

# 示例
http://192.168.1.100:8080/docker-builder/
```

> 直接访问 `http://IP:PORT` 会自动跳转到登录页。

---

## 使用流程

### 1. 构建 & 推送

```
选择部署路径
  └─ 服务器目录（须含 Dockerfile）

上传文件
  ├─ JAR 包   → 直接复制到部署路径
  └─ dist.zip → 复制后自动解压为 dist/ 目录

镜像配置
  ├─ 镜像名称（自动取文件名）
  └─ 版本标签（默认当天日期，如 20250305）

粘贴 SWR 登录指令
  └─ 华为云控制台 → 容器镜像服务 → 右上角「登录指令」
     示例：docker login -u cn-xxx@XXXXXX -p <token> swr.xxx.com

点击「开始构建并推送」
  1. 分片上传（并发 4 路，每片 5MB）
  2. 服务端合并文件
  3. docker build（使用已有 Dockerfile）
  4. docker login（SWR 临时凭证）
  5. docker tag
  6. docker push
```

### 2. 镜像列表

- 点击左侧「镜像列表」→「刷新」查看本地所有镜像
- 勾选镜像 → 「删除所选」批量删除
- 每行「删除」按钮单独删除

---

## API 接口

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| `POST` | `/login` | 登录（JSON） | 否 |
| `POST` | `/api/logout` | 登出 | 是 |
| `GET` | `/api/me` | 当前用户信息 | 是 |
| `GET` | `/api/paths` | 扫描目录列表 | 是 |
| `GET` | `/api/dockerfile` | 读取 Dockerfile 内容 | 是 |
| `POST` | `/api/upload/chunk` | 上传单个分片 | 是 |
| `POST` | `/api/upload/merge` | 合并所有分片 | 是 |
| `POST` | `/api/build` | 构建并推送镜像（流式响应） | 是 |
| `GET` | `/api/images` | 列出本地镜像 | 是 |
| `POST` | `/api/images/delete` | 删除镜像 | 是 |

---

## 安全说明

| 机制 | 说明 |
|---|---|
| Session 鉴权 | 所有 API 和页面均需登录，未登录返回 401 |
| 路径白名单 | `SCAN_ROOTS` 限制可操作目录，防止目录穿越 |
| 密码 stdin | SWR 密码通过 stdin 传给 docker，不暴露在进程列表 |
| 无服务端跳转 | 所有跳转由前端 JS 完成，避免反向代理拦截 301/302 |
| HttpOnly Cookie | Session Cookie 设置 HttpOnly，防止 XSS 窃取 |

---

## 常见问题

**Q: 上传大文件失败？**

检查服务端超时配置（默认 30 分钟）。如通过 Nginx 代理，需配置：
```nginx
client_max_body_size 700m;
proxy_read_timeout   1800s;
proxy_send_timeout   1800s;
proxy_buffering      off;
```

**Q: docker login 报 `Authenticate Error`？**

华为云 SWR 临时凭证有效期 **24 小时**，需在控制台重新生成登录指令。

**Q: 退出登录后仍能访问？**

确认浏览器未缓存页面，刷新后重试。如仍有问题，检查 `SESSION_SECRET` 是否已修改。

**Q: 通过 Nacos/网关访问出现 301 错误页？**

本项目已将所有跳转改为前端 JS 处理，不产生服务端 301/302，如仍报错请检查网关路由配置是否正确转发到 `BASE_PATH`。

**Q: 镜像列表为空？**

确认运行服务的用户有权执行 `docker images`（通常需要在 `docker` 用户组内）：
```bash
sudo usermod -aG docker $(whoami)
# 重新登录后生效
```

---

## 依赖版本

```json
{
  "express": "^4.18.2",
  "multer": "^1.4.5-lts.1",
  "cors": "^2.8.5",
  "express-session": "^1.17.3"
}
```

---

## License

MIT
