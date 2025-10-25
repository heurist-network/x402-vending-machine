module.exports = {
  apps: [
    {
      name: "vending-api",
      script: "bun",
      args: ["run", "api"],
      watch: false,
      env: {
        NODE_ENV: process.env.NODE_ENV || "production"
      }
    },
    {
      name: "vending-worker",
      script: "bun",
      args: ["run", "worker"],
      watch: false,
      env: {
        NODE_ENV: process.env.NODE_ENV || "production",
        WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY || "4"
      }
    }
  ]
};
