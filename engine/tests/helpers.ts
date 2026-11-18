// Temporary folders for tests. Always under the system temp dir, never the real data or bots dirs.
// They go when the tests end, also when the run is stopped (Ctrl-C, SIGTERM); leftovers of runs that
// crashed more than a day ago go when the tests start (scripts/temp-cleanup.mjs).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { onStop, sweepOld } from "../../scripts/temp-cleanup.mjs";

const made: string[] = [];
const removeMade = () => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
};

sweepOld();
onStop(removeMade);

export function tempDir(prefix = "pobots-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

after(removeMade);
