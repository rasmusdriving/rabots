import { readFile, rename, writeFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { aggregate } from "./aggregate.js";
import { CACHE_VERSION, scanHistory, type Index } from "./scan.js";
import type { Source } from "./types.js";

interface Job {
  cache: string;
  sources: Source[];
  timeZone: string;
  now: number;
  warm: boolean;
}

const { cache, sources, timeZone, now, warm } = workerData as Job;
const port = parentPort!;
let index: Index = { files: {}, incomplete: [] };
let savedAt: string | undefined;
try {
  const saved = JSON.parse(await readFile(cache, "utf8")) as { version: number; index: Index; savedAt: string };
  if (saved.version === CACHE_VERSION && saved.index?.files && Number.isFinite(Date.parse(saved.savedAt))) {
    index = saved.index;
    savedAt = saved.savedAt;
  }
  if (warm && savedAt) port.postMessage({ overviews: aggregate(index, now, timeZone, savedAt), finished: false });
} catch {
  // Old or unreadable caches are disposable. Scan the source, without exposing file details.
  index = { files: {}, incomplete: [] };
}

try {
  const next = await scanHistory(sources, index, now);
  const savedAt = new Date(now).toISOString();
  port.postMessage({ overviews: aggregate(next, now, timeZone, savedAt), finished: true });
  try {
    await writeFile(cache + ".next", JSON.stringify({ version: CACHE_VERSION, index: next, savedAt }), { mode: 0o600 });
    await rename(cache + ".next", cache);
  } catch {
    // The live overview remains useful if the optional local cache cannot be saved.
  }
} catch {
  port.postMessage({ finished: true });
}
