// Engine entry point.
//   node dist/engine/main.mjs [--port=N] [--data-dir=PATH] [--bots-dir=PATH] [--serve] [--ui-dir=PATH]
//                             [--push-relay=http://127.0.0.1:<port>]   (checks only: see docs/build/step-push.md)
// Without serve mode: a random port, and one announcement line on stdout once listening
// ({"pobotsEngine":{"port","token"}}). In serve mode: a fixed port (47600 unless --port or `port`
// in config.json says otherwise), the app window as a web page on it, and nothing on stdout.
// Either way <dataDir>/engine.json names the running engine, and a second engine on the same data
// folder refuses to start. Everything else goes to stderr.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineAnnouncement } from "../shared/protocol.js";
import { detectClaude } from "./claude/detect.js";
import { detectCodex } from "./codex/detect.js";
import { parseFlags, resolveConfig } from "./config.js";
import { Engine, ENGINE_VERSION } from "./engine.js";
import { removeLock, runningEngine, writeLock } from "./lock.js";
import { log } from "./log.js";
import { EngineServer } from "./server.js";
import { Store } from "./store.js";

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const config = resolveConfig(flags);
  log.info(`Pobots engine ${ENGINE_VERSION} starting. Data in ${config.dataDir}, bots in ${config.botsDir}`);

  // One engine per data folder. Checked before the database is opened.
  const other = await runningEngine(config.dataDir);
  if (other) {
    process.stderr.write(`Pobots is already running on this data folder (process ${other.pid}, port ${other.port}). Not starting a second engine.\n`);
    process.exit(3);
  }

  let uiDir: string | undefined;
  if (config.serve) {
    uiDir = config.uiDir ?? fileURLToPath(new URL("../ui/", import.meta.url));
    if (!existsSync(join(uiDir, "index.html"))) log.warn(`Serve mode, but the app window is not built in ${uiDir}. Run: npm run build`);
    log.info(
      config.remote.allowedLogins.length
        ? `Serve mode. ${config.remote.allowedLogins.length} Tailscale login(s) may open Pobots from other devices.`
        : "Serve mode. Remote access is off (no allowed Tailscale logins).",
    );
  }

  const store = new Store(join(config.dataDir, "pobots.db"));
  const claude = await detectClaude(config.claude);
  if (claude.ready) log.info(`Found Claude ${claude.version ?? ""} at ${claude.executable}`);
  else log.warn(`Claude is not ready: ${claude.problem}`);

  const token = randomBytes(24).toString("base64url");
  const server = new EngineServer(token, { uiDir, allowedLogins: config.remote.allowedLogins });
  // Codex (bots on GPT models) is looked at by the engine itself, without holding the start up.
  // Notifications go to a test relay only with --push-relay (a check's own engine); the engine logs it.
  const engine = new Engine({
    config,
    store,
    claude,
    checkCodex: () => detectCodex(config.codex ?? {}),
    emit: (event, data) => server.broadcast(event, data),
    ...(flags.pushRelay ? { notify: { relay: flags.pushRelay } } : {}),
  });
  engine.init();
  server.attach(engine);
  let port: number;
  try {
    port = await server.listen(config.port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write(`Port ${config.port} is already in use by another program. Choose another with --port or "port" in config.json.\n`);
      engine.shutdown();
      store.close();
      process.exit(4);
    }
    throw err;
  }
  engine.setLocalBase(`http://127.0.0.1:${port}`);
  writeLock(config.dataDir, { pid: process.pid, port, token, serve: config.serve, startedAt: new Date().toISOString() });
  process.on("exit", () => removeLock(config.dataDir));

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`Stopping (${signal})`);
    try {
      engine.shutdown();
      // A running backup is ended before the database closes: its child processes ended and its
      // half-made files removed. Bounded inside (engine/backup.ts, stopMs, then by force), so this
      // never waits past launchd's limit, and never closes the store while the clean-up still runs.
      const clean = await engine.backupStopped();
      if (!clean) log.error("The backup's clean-up could not be finished before the stop; see the lines above");
      await server.close();
    } catch (err) {
      log.error("Error while stopping", err);
    }
    store.close();
    removeLock(config.dataDir);
    log.info("Stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));

  // In serve mode stdout goes to the service's log file, which must never hold the token.
  if (!config.serve) {
    const announcement: EngineAnnouncement = { pobotsEngine: { port, token } };
    process.stdout.write(JSON.stringify(announcement) + "\n");
  }
  log.info(`Listening on 127.0.0.1:${port}${config.serve ? ", serving the app window" : ""}`);
}

// Errors never crash the engine once it runs.
process.on("uncaughtException", (err) => log.error("Uncaught error", err));
process.on("unhandledRejection", (err) => log.error("Unhandled rejection", err));

main().catch((err) => {
  log.error("The engine could not start", err);
  process.exit(1);
});
