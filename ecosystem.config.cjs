'use strict';

const path = require('node:path');
const { DROP_ALL_GLOBAL_ENV } = require('./pm2Policy.cjs');

module.exports = {
  apps: [{
    name: 'wst-academy-qabul-bot',
    cwd: path.resolve(__dirname),
    script: 'scripts/preflight-startup.mjs',
    interpreter: '/usr/bin/node',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    restart_delay: 5_000,
    exp_backoff_restart_delay: 1_000,
    min_uptime: '15s',
    max_restarts: 5,
    kill_timeout: 10_000,
    watch: false,
    merge_logs: true,
    time: true,
    filter_env: DROP_ALL_GLOBAL_ENV,
    env: {
      NODE_ENV: 'production',
    },
    env_production: {
      NODE_ENV: 'production',
    },
  }],
};
