module.exports = {
  apps: [
    {
      name: 'unitalks',
      script: './server/dist/index.js',
      cwd: __dirname,
      instances: process.env.PM2_INSTANCES || 1,
      exec_mode: 'cluster',
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
      max_memory_restart: '500M',
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
    },
  ],
};
