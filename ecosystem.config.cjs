'use strict';

const path = require('node:path');
const { DROP_ALL_GLOBAL_ENV } = require('./pm2Policy.cjs');

module.exports = {
  apps: [{
    name: 'wst-academy-qabul-bot',
    cwd: path.resolve(__dirname),
    script: 'dist/index.js',
    interpreter: '/usr/bin/node',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    restart_delay: 3_000,
    min_uptime: '10s',
    max_restarts: 10,
    kill_timeout: 10_000,
    watch: false,
    merge_logs: true,
    time: true,
    filter_env: DROP_ALL_GLOBAL_ENV,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
