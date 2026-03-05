// server.js  —  JAR/dist.zip 构建推送服务
// 依赖：npm install express multer cors express-session
// 启动示例：
//   BASE_PATH=/docker-builder \
//   LOGIN_USER=admin \
//   LOGIN_PASS=yourpassword \
//   SESSION_SECRET=random-secret-string \
//   SCAN_ROOTS=/opt/apps,/data/deploy \
//   PORT=8080 \
//   node server.js

const express      = require('express');
const multer       = require('multer');
const cors         = require('cors');
const session      = require('express-session');
const path         = require('path');
const fs           = require('fs');
const { spawn }    = require('child_process');

// ── 配置 ──────────────────────────────────────────────────────────────────────
const PORT          = process.env.PORT           || 8080;
const BASE_PATH     = (process.env.BASE_PATH     || '/docker-builder').replace(/\/$/, '');
const LOGIN_USER    = process.env.LOGIN_USER     || 'admin';
const LOGIN_PASS    = process.env.LOGIN_PASS     || 'admin123';
const SESSION_SECRET= process.env.SESSION_SECRET || 'change-me-please';
const SCAN_ROOTS    = (process.env.SCAN_ROOTS    || '/opt/apps,/data/deploy')
                        .split(',').map(s => s.trim()).filter(Boolean);

const app = express();

// ── 中间件 ────────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000   // 8小时过期
  }
}));

// ── 静态文件（前端页面）放在 BASE_PATH 下 ────────────────────────────────────
app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

// ── 登录认证中间件（禁止任何服务端 redirect，全返回 JSON）──────────────────
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ error: '未登录或会话已过期', loginUrl: BASE_PATH + '/login' });
}

// ── 路由前缀 router ────────────────────────────────────────────────────────────
const router = express.Router();

// ── 登录页 GET ────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.loggedIn) {
    // 已登录：返回登录页但带标记，前端检测后跳转
    return res.send(loginPageHtml('', true));
  }
  res.send(loginPageHtml());
});

// ── 登录提交 POST ─────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  // JSON 登录（前端 fetch 调用）
  if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
    if (username === LOGIN_USER && password === LOGIN_PASS) {
      req.session.loggedIn  = true;
      req.session.username  = username;
      req.session.loginTime = Date.now();
      return res.json({ ok: true });
    }
    return res.status(401).json({ ok: false, error: '用户名或密码错误' });
  }
  // 表单登录（直接 POST form）
  if (username === LOGIN_USER && password === LOGIN_PASS) {
    req.session.loggedIn  = true;
    req.session.username  = username;
    req.session.loginTime = Date.now();
    return res.json({ ok: true });
  }
  res.send(loginPageHtml('用户名或密码错误'));
});

// ── 登出 ──────────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// 新增 /api/logout，供前端 JS 调用
router.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── 主页（前端 SPA）─────────────────────────────────────────────────────────
router.get('/', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── API: Health ───────────────────────────────────────────────────────────────
router.get('/api/health', (req, res) =>
  res.json({ status: 'ok', time: new Date().toISOString() })
);

// ── API: 当前用户信息 ─────────────────────────────────────────────────────────
router.get('/api/me', requireLogin, (req, res) => {
  res.json({
    username: req.session.username,
    loginTime: req.session.loginTime
  });
});

// ── API: 路径列表 ──────────────────────────────────────────────────────────────
router.get('/api/paths', requireLogin, (req, res) => {
  const result = [];
  for (const root of SCAN_ROOTS) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const full = path.join(root, e.name);
        result.push({
          path:  full,
          hasDF: fs.existsSync(path.join(full, 'Dockerfile')),
          label: e.name
        });
      }
    } catch { /* skip */ }
  }
  res.json(result);
});

// ── API: 读取 Dockerfile ──────────────────────────────────────────────────────
router.get('/api/dockerfile', requireLogin, (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: '缺少 path 参数' });
  if (!SCAN_ROOTS.some(r => p.startsWith(r)))
    return res.status(403).json({ error: '路径不在允许范围内' });
  const dfPath = path.join(p, 'Dockerfile');
  if (!fs.existsSync(dfPath))
    return res.status(404).json({ error: '该目录下没有 Dockerfile' });
  try {
    res.json({ path: dfPath, content: fs.readFileSync(dfPath, 'utf-8') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── API: 分片上传 ──────────────────────────────────────────────────────────────
// POST /api/upload/chunk  — 上传单个分片
// POST /api/upload/merge  — 所有分片合并成完整文件
const chunkUpload = multer({
  dest: '/tmp/docker-chunks/',
  limits: { fileSize: 20 * 1024 * 1024 }, // 每片最大 20MB
});

router.post('/api/upload/chunk', requireLogin, chunkUpload.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex, totalChunks, filename } = req.body;
  if (!uploadId || chunkIndex === undefined || !req.file) {
    return res.status(400).json({ error: '参数不完整' });
  }
  // 将分片移动到以 uploadId 命名的目录
  const chunkDir = `/tmp/docker-chunks/${uploadId}`;
  fs.mkdirSync(chunkDir, { recursive: true });
  const dest = path.join(chunkDir, `chunk_${String(chunkIndex).padStart(6,'0')}`);
  fs.renameSync(req.file.path, dest);
  res.json({ ok: true, chunkIndex: Number(chunkIndex), totalChunks: Number(totalChunks) });
});

router.post('/api/upload/merge', requireLogin, async (req, res) => {
  const { uploadId, filename, totalChunks } = req.body;
  if (!uploadId || !filename || !totalChunks) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const chunkDir  = `/tmp/docker-chunks/${uploadId}`;
  const finalPath = `/tmp/docker-uploads/${uploadId}_${filename}`;
  try {
    const chunks = [];
    for (let i = 0; i < totalChunks; i++) {
      const p = path.join(chunkDir, `chunk_${String(i).padStart(6,'0')}`);
      if (!fs.existsSync(p)) return res.status(400).json({ error: `分片 ${i} 缺失` });
      chunks.push(p);
    }
    // 串行合并写入
    const out = fs.createWriteStream(finalPath);
    for (const cp of chunks) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(cp);
        rs.pipe(out, { end: false });
        rs.on('end', resolve);
        rs.on('error', reject);
      });
    }
    out.end();
    await new Promise(r => out.on('finish', r));
    // 清理分片目录
    fs.rmSync(chunkDir, { recursive: true, force: true });
    const stat = fs.statSync(finalPath);
    res.json({ ok: true, path: finalPath, size: stat.size });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: 构建 & 推送 ───────────────────────────────────────────────────────────
const upload = multer({
  dest: '/tmp/docker-uploads/',
  limits: {
    fileSize:  600 * 1024 * 1024,   // 600 MB 文件大小上限
    fieldSize: 10  * 1024 * 1024,   // 10 MB 表单字段大小
    files: 1,
  },
  fileFilter: (_, f, cb) => {
    const ok = f.originalname.endsWith('.jar') || f.originalname.endsWith('.zip');
    ok ? cb(null, true) : cb(new Error('只允许 .jar 或 .zip 文件'));
  }
});

// ── API: 镜像列表 ─────────────────────────────────────────────────────────────
router.get('/api/images', requireLogin, (req, res) => {
  const { execSync } = require('child_process');
  try {
    const out = execSync(
      `docker images --format '{"id":"{{.ID}}","repo":"{{.Repository}}","tag":"{{.Tag}}","size":"{{.Size}}","created":"{{.CreatedSince}}","createdAt":"{{.CreatedAt}}"}'`,
      { encoding: 'utf-8' }
    );
    const images = out.trim().split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    res.json(images);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: 删除镜像 ─────────────────────────────────────────────────────────────
router.post('/api/images/delete', requireLogin, (req, res) => {
  const { ids } = req.body; // ids: string[]  镜像 ID 或 repo:tag
  if (!ids || !Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: '请传入要删除的镜像 ID 列表' });

  const results = [];
  for (const id of ids) {
    try {
      const { execSync } = require('child_process');
      execSync(`docker rmi -f ${id}`, { encoding: 'utf-8' });
      results.push({ id, success: true });
    } catch (e) {
      results.push({ id, success: false, error: e.message });
    }
  }
  res.json({ results });
});

// build 路由：JSON 请求（分片上传后）直接走，multipart 请求才用 multer
router.post('/api/build', requireLogin, (req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) {
    // JSON 模式：body 已由全局 express.json() 解析，直接 next
    return next();
  }
  // multipart 模式：用 multer 解析
  upload.single('file')(req, res, next);
}, async (req, res) => {
  // 强制流式输出：立即刷出响应头，让网关/代理不缓冲
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');   // 关闭 nginx 缓冲
  res.flushHeaders();                           // 立即发出响应头

  const logs = [];  // 同时保存日志，供调试
  const send = (type, msg, extra = {}) => {
    const line = JSON.stringify({ type, msg, ...extra });
    logs.push(line);
    res.write(line + '\n');
    // 尝试强制刷新缓冲区
    if (res.flush) res.flush();
  };

  const {
    fileType      = 'jar',
    path: deployPath,
    imageName     = 'my-app',
    imageTag      = 'latest',
    buildArgs     = '',
    swrRegistry   = '',
    swrNamespace  = '',
    swrUser       = '',
    swrPassword   = '',
  } = req.body;

  // 支持两种模式：
  // 1. 直接上传（req.file）—— 小文件走单次上传
  // 2. 分片合并后（mergedFilePath）—— 大文件走分片上传
  const uploadedFile  = req.file;
  const mergedFilePath = req.body.mergedFilePath || '';  // 分片合并后的路径
  const origFilename   = req.body.origFilename   || (uploadedFile && uploadedFile.originalname) || '';

  if (!uploadedFile && !mergedFilePath) { send('err', '未收到文件'); return res.end(); }
  if (!deployPath)    { send('err', '未指定部署路径'); return res.end(); }
  if (!SCAN_ROOTS.some(r => deployPath.startsWith(r))) {
    send('err', '路径不在允许的目录范围内'); return res.end();
  }
  if (!fs.existsSync(path.join(deployPath, 'Dockerfile'))) {
    send('err', `${deployPath} 下不存在 Dockerfile`); return res.end();
  }

  // 统一文件来源
  const srcPath = mergedFilePath || uploadedFile.path;
  const srcSize = fs.statSync(srcPath).size;

  const localImg  = `${imageName}:${imageTag}`;
  const remoteImg = `${swrRegistry}/${swrNamespace}/${imageName}:${imageTag}`;

  try {
    // 1. 处理上传文件
    if (fileType === 'jar') {
      send('step', `▶ 复制 JAR 到 ${deployPath}`, { progress: 8 });
      fs.copyFileSync(srcPath, path.join(deployPath, origFilename));
      fs.unlinkSync(srcPath);
      send('ok', `✔ 已复制: ${origFilename} (${(srcSize/1024/1024).toFixed(2)} MB)`, { progress: 20 });
    } else {
      send('step', `▶ 复制 dist.zip 到 ${deployPath}`, { progress: 8 });
      const zipDest = path.join(deployPath, origFilename);
      fs.copyFileSync(srcPath, zipDest);
      fs.unlinkSync(srcPath);
      send('ok', `✔ 已复制 (${(srcSize/1024/1024).toFixed(2)} MB)`, { progress: 14 });
      send('step', '▶ 解压 dist.zip', { progress: 16 });
      send('cmd',  `$ cd ${deployPath} && unzip -o ${origFilename} -d dist/`);
      const distDir = path.join(deployPath, 'dist');
      if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
      await runCmd('unzip', ['-o', origFilename, '-d', 'dist'], deployPath,
        l => send('info', l), l => send('warn', l));
      send('ok', '✔ 解压完成', { progress: 22 });
    }

    // 2. docker build
    send('step', '▶ 使用已有 Dockerfile 构建镜像', { progress: 25 });
    const extra    = buildArgs.trim().split(/\s+/).filter(Boolean);
    const buildCmd = ['build', ...extra, '-t', localImg, '.'];
    send('cmd', `$ cd ${deployPath} && docker ${buildCmd.join(' ')}`, { progress: 28 });
    await runCmd('docker', buildCmd, deployPath, l => send('info', l), l => send('warn', l));
    send('ok', `✔ 镜像构建成功: ${localImg}`, { progress: 68 });

    // 3. docker login
    send('step', `▶ 登录 SWR Registry: ${swrRegistry}`, { progress: 72 });
    send('cmd',  `$ docker login -u ${swrUser} --password-stdin ${swrRegistry}`);
    await runCmdStdin('docker', ['login', '-u', swrUser, '--password-stdin', swrRegistry],
      deployPath, swrPassword,
      l => send('info', l),
      l => { if (!l.toLowerCase().includes('warning')) send('warn', l); });
    send('ok', '✔ Login Succeeded', { progress: 78 });

    // 4. docker tag
    send('step', '▶ 设置远端 Tag', { progress: 80 });
    send('cmd',  `$ docker tag ${localImg} ${remoteImg}`);
    await runCmd('docker', ['tag', localImg, remoteImg], deployPath,
      l => send('info', l), l => send('warn', l));
    send('ok', `✔ ${remoteImg}`, { progress: 84 });

    // 5. docker push
    send('step', '▶ 推送镜像到 SWR', { progress: 86 });
    send('cmd',  `$ docker push ${remoteImg}`);
    await runCmd('docker', ['push', remoteImg], deployPath,
      l => send('info', l), l => send('warn', l));
    send('ok', `✔ 推送成功: ${remoteImg}`, { progress: 98 });

    send('ok', '🎉 全部完成！', {
      progress: 100, done: true,
      imageName, imageTag, swrRegistry, swrNamespace, fullTag: remoteImg
    });
  } catch (e) {
    send('err', '❌ 失败: ' + e.message);
  } finally {
    res.end();
  }
});

// ── 挂载 router 到 BASE_PATH ──────────────────────────────────────────────────
app.use(BASE_PATH, router);

// ── 根路径跳转 ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send(loginPageHtml()));

// ── BASE_PATH 不带斜杠时跳转（如 /docker-builder → /docker-builder/）─────────
// BASE_PATH 不带/或带/ → 均走 router，router 里有 '/' 处理


// ── 工具函数 ──────────────────────────────────────────────────────────────────
function runCmd(cmd, args, cwd, onOut, onErr) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    p.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(onOut));
    p.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(onErr));
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`)));
    p.on('error', reject);
  });
}
function runCmdStdin(cmd, args, cwd, stdin, onOut, onErr) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    p.stdin.write(stdin); p.stdin.end();
    p.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(onOut));
    p.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(onErr));
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`)));
    p.on('error', reject);
  });
}

// ── 登录页 HTML（内联，无需额外文件）────────────────────────────────────────
function loginPageHtml(errMsg = '', alreadyLoggedIn = false) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 — Docker Builder</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:'IBM Plex Sans',sans-serif;}
  .card{background:#161b27;border:1px solid #242a38;border-radius:14px;padding:40px 36px;width:360px;}
  .logo{width:40px;height:40px;background:#4ade80;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;margin:0 auto 20px;}
  h1{text-align:center;font-size:18px;color:#fff;margin-bottom:6px;}
  .sub{text-align:center;font-size:12px;color:#4b5563;font-family:'IBM Plex Mono',monospace;margin-bottom:28px;}
  .fg{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;}
  label{font-size:11px;color:#4b5563;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.7px;}
  input{background:#0f1117;border:1px solid #2e3750;border-radius:7px;color:#d1d9e0;font-family:'IBM Plex Mono',monospace;font-size:13px;padding:10px 13px;outline:none;transition:border-color .2s;width:100%;}
  input:focus{border-color:#4ade80;}
  .err{display:none;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.3);border-radius:7px;padding:9px 13px;font-size:12px;color:#f87171;font-family:'IBM Plex Mono',monospace;margin-bottom:14px;}
  button{width:100%;padding:12px;background:#4ade80;border:none;border-radius:8px;color:#000;font-family:'IBM Plex Sans',sans-serif;font-size:14px;font-weight:700;cursor:pointer;margin-top:6px;transition:all .2s;}
  button:hover{background:#86efac;}
  button:disabled{opacity:.5;cursor:not-allowed;}
  .tip{text-align:center;font-size:11px;color:#374151;font-family:'IBM Plex Mono',monospace;margin-top:20px;}
</style>
</head>
<body>
<div class="card">
  <div class="logo">🐳</div>
  <h1>Docker Builder</h1>
  <p class="sub">build · tag · push</p>
  <div class="err" id="errBox">⚠ <span id="errMsg"></span></div>
  <div class="fg">
    <label>用户名</label>
    <input type="text" id="username" placeholder="admin" autocomplete="username">
  </div>
  <div class="fg">
    <label>密码</label>
    <input type="password" id="password" placeholder="••••••••" autocomplete="current-password">
  </div>
  <button id="loginBtn" onclick="doLogin()">登录</button>
  <p class="tip">会话有效期 8 小时</p>
</div>
<script>
  // 已登录则直接跳主页
  if (${alreadyLoggedIn}) { window.location.href = '${BASE_PATH}/'; }
  // 支持回车登录
  document.getElementById('password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('username').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('password').focus();
  });

  async function doLogin() {
    const btn  = document.getElementById('loginBtn');
    const user = document.getElementById('username').value.trim();
    const pass = document.getElementById('password').value;
    const errBox = document.getElementById('errBox');
    const errMsg = document.getElementById('errMsg');

    if (!user || !pass) { showErr('请填写用户名和密码'); return; }

    btn.disabled = true;
    btn.textContent = '登录中…';
    errBox.style.display = 'none';

    try {
      const r = await fetch('${BASE_PATH}/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await r.json();
      if (data.ok) {
        window.location.href = '${BASE_PATH}/';
      } else {
        showErr(data.error || '用户名或密码错误');
      }
    } catch(e) {
      showErr('网络请求失败，请重试');
    }

    btn.disabled = false;
    btn.textContent = '登录';
  }

  function showErr(msg) {
    const errBox = document.getElementById('errBox');
    document.getElementById('errMsg').textContent = msg;
    errBox.style.display = 'block';
  }
</script>
</body>
</html>`;
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
fs.mkdirSync('/tmp/docker-uploads', { recursive: true });
fs.mkdirSync('/tmp/docker-chunks',  { recursive: true });
const server = app.listen(PORT, () => {
  console.log(`✅ 服务启动: http://0.0.0.0:${PORT}${BASE_PATH}/`);
  console.log(`   基础路径: ${BASE_PATH}`);
  console.log(`   登录用户: ${LOGIN_USER}`);
  console.log(`   扫描目录: ${SCAN_ROOTS.join(', ')}`);
});

// 大文件上传超时设置：上传 + 构建 + 推送总计最长 30 分钟
server.timeout         = 30 * 60 * 1000;  // 请求总超时
server.keepAliveTimeout = 31 * 60 * 1000;
server.headersTimeout   = 32 * 60 * 1000;
