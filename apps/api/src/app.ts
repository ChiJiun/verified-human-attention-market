import Fastify from "fastify";

export function buildApp() {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async () => ({
    status: "ok",
    checks: {
      process: "ok",
    },
  }));

  return app;
}
