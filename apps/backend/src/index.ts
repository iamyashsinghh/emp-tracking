import express from "express";
import cors from "cors";
import { env } from "./env";
import { ensureBucket } from "./storage";
import { authRouter } from "./routes/auth";
import { tenantsRouter } from "./routes/tenants";
import { usersRouter } from "./routes/users";
import { agentRouter } from "./routes/agent";
import { activityRouter } from "./routes/activity";
import { mediaRouter, mediaAdminRouter } from "./routes/media";
import { reportsRouter } from "./routes/reports";

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Dashboard / admin API
app.use("/api/auth", authRouter);
app.use("/api/tenants", tenantsRouter);
app.use("/api/users", usersRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/media", mediaAdminRouter);

// Desktop agent API
app.use("/api/agent", agentRouter);
app.use("/api/agent/activity", activityRouter);
app.use("/api/agent/media", mediaRouter);

async function main() {
  await ensureBucket().catch((e) => console.warn("[storage] bucket init skipped:", e.message));
  app.listen(env.port, () => {
    console.log(`[backend] listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
