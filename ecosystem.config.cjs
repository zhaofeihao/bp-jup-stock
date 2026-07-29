const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "bp-jup-stock",
      cwd: __dirname,
      script: path.join(__dirname, "dist/cli.js"),
      args: "monitor",
      interpreter: process.execPath,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      restart_delay: 5_000,
      kill_timeout: 10_000,
      max_memory_restart: "500M",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
