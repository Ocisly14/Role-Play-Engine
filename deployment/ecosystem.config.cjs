/**
 * PM2 Process Manager Configuration for Production
 *
 * This file configures how PM2 manages the CoC AI Agent application in production.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 reload ecosystem.config.cjs
 *   pm2 stop coc-agent
 *   pm2 logs coc-agent
 *
 * Documentation: https://pm2.keymetrics.io/docs/usage/application-declaration/
 */

module.exports = {
  apps: [{
    // Application name
    name: 'coc-agent',

    // Main script to run (adjust path if needed)
    script: './dist/src/shared/index.js',

    // Working directory
    cwd: '/home/ubuntu/app',

    // Number of instances (1 for SQLite compatibility)
    instances: 1,
    exec_mode: 'fork',

    // Environment variables
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },

    // Restart behavior
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000,

    // Logging
    error_file: '/home/ubuntu/app/logs/error.log',
    out_file: '/home/ubuntu/app/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,

    // Memory management
    max_memory_restart: '800M',

    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,

    // Process monitoring
    watch: false, // Don't watch files in production
    ignore_watch: ['node_modules', 'logs', 'data'],

    // Advanced features (optional)
    // instance_var: 'INSTANCE_ID',
    // time: true,
  }]
};
