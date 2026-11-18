import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Worker } from "node:worker_threads";
import { USAGE_RANGES, type UsageOverview, type UsageOverviewRead, type UsageRange } from "../../../shared/protocol.js";
import type { Engine } from "../../engine.js";
import { EngineError } from "../../errors.js";
import type { Source } from "./types.js";

const FRESH_MS = 60_000;
const SCAN_BUDGET_MS = 180_000;
const REFRESH_FLOOR_MS = 2_000;

interface Reading {
  worker?: Worker;
  attempted?: number;
  reading: boolean;
  overviews?: Record<UsageRange, UsageOverview>;
  problem?: string;
}

const history = new WeakMap<Engine, Reading>();
const home = (value: string | undefined, fallback: string) => {
  if (value?.startsWith("~/")) return join(homedir(), value.slice(2));
  return value && isAbsolute(value) ? value : fallback;
};

function sourcesFor(eng: Engine): Source[] {
  const claude = join(homedir(), ".claude");
  const codex = join(homedir(), ".codex");
  const out: Source[] = [];
  for (const root of new Set([claude, home(process.env.CLAUDE_CONFIG_DIR, claude), home(eng.opts.claude.env.CLAUDE_CONFIG_DIR, claude)])) {
    out.push({ provider: "claude", dir: join(root, "projects") });
  }
  for (const root of new Set([codex, home(process.env.CODEX_HOME, codex), home(eng.codex.env.CODEX_HOME, codex)])) {
    out.push({ provider: "codex", dir: join(root, "sessions") }, { provider: "codex", dir: join(root, "archived_sessions") });
  }
  return out;
}

function start(eng: Engine, state: Reading) {
  state.attempted = Date.now();
  state.reading = true;
  delete state.problem;
  const fail = () => {
    state.problem = "Usage history could not be read. Try refreshing.";
    state.reading = false;
  };
  let worker: Worker;
  try {
    worker = new Worker(new URL("./usage-history-worker.mjs", import.meta.url), {
      workerData: {
        sources: sourcesFor(eng), cache: join(eng.opts.config.dataDir, "usage-history.json"),
        timeZone: eng.tz, now: eng.clock(), warm: !state.overviews,
      },
      stdout: true, stderr: true, execArgv: [],
    });
  } catch {
    fail();
    return;
  }
  state.worker = worker;
  const timer = setTimeout(() => { void worker.terminate(); }, SCAN_BUDGET_MS);
  timer.unref();
  worker.on("message", (m: { overviews?: Record<UsageRange, UsageOverview>; finished: boolean }) => {
    if (m.overviews) state.overviews = m.overviews;
    if (m.finished) {
      state.reading = false;
      if (!m.overviews) fail();
    }
  });
  worker.once("error", fail);
  worker.once("exit", () => {
    clearTimeout(timer);
    delete state.worker;
    if (state.reading) fail();
  });
  worker.unref();
}

export function readUsageOverview(eng: Engine, params: { range: UsageRange; refresh?: boolean }): UsageOverviewRead {
  if (!USAGE_RANGES.includes(params.range)) throw new EngineError("bad_request", "Choose a usage range.");
  let state = history.get(eng);
  if (!state) history.set(eng, state = { reading: false });
  const elapsed = Date.now() - (state.attempted ?? 0);
  if (!state.worker && elapsed >= (params.refresh === true ? REFRESH_FLOOR_MS : FRESH_MS)) start(eng, state);
  return { overview: state.overviews?.[params.range], reading: state.reading, problem: state.problem };
}
