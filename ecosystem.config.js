module.exports = {
  apps: [{
    name: 'docker-builder',
    script: 'server.js',
    cwd: '/opt/docker-builder',
    env: {
      PORT:           8080,
      BASE_PATH:      '/docker-builder',   // 访问路径前缀，改成你想要的
      LOGIN_USER:     'admin',             // 登录用户名
      LOGIN_PASS:     'Admin@2024!',       // 登录密码，务必修改
      SESSION_SECRET: 'please-change-this-random-string-abc123', // 随机字符串，务必修改
      SCAN_ROOTS:     '/opt/apps,/data/deploy'
    }
  }]
}
