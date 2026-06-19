module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || 'mao-kanban-api',
      script: 'web/server.mjs',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      time: true,
      max_memory_restart: process.env.PM2_MAX_MEMORY || '512M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '4173',
        MAO_ENABLE_WEB_WECHAT: process.env.MAO_ENABLE_WEB_WECHAT || 'false',
      },
    },
  ],
};
