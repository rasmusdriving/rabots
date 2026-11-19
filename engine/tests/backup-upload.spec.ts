import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKUP_TIMINGS, confirmUpload, UPLOAD_ERROR, UPLOAD_PENDING, UPLOAD_UNKNOWN, type UploadState } from "../core/backup-restic-upload.js";

const saved = { exists: true, ubiquitous: true, uploaded: true };
const errored = { ...saved, uploaded: null, uploadError: "example provider error" };
const pending = { ...saved, uploaded: false };

async function checkUpload(reading: (elapsed: number) => UploadState) {
  let elapsed = 0;
  const polls: number[] = [];
  const clock = { now: () => elapsed, wait: async (ms: number) => { elapsed += ms; } };
  const outcome = await confirmUpload("/tmp", ["file"], async () => {
    polls.push(elapsed);
    return [reading(elapsed)];
  }, BACKUP_TIMINGS, new AbortController().signal, clock);
  return { outcome, polls, elapsed };
}

test("a passing iCloud error resets the hold, then a stable upload is confirmed", async () => {
  const { outcome, polls } = await checkUpload((ms) => ms === 5_000 ? errored : saved);
  assert.equal(outcome, undefined);
  assert.deepEqual(polls, [0, 5_000, 10_000, 15_000]);
});

test("an iCloud error that persists through the deadline reports the upload error", async () => {
  const { outcome, polls } = await checkUpload(() => errored);
  assert.equal(outcome, UPLOAD_ERROR);
  assert.ok(polls.length > 1);
  assert.equal(polls.at(-1), 120_000);
});

test("a cleared iCloud error reports an unconfirmed upload if the file stays pending", async () => {
  const { outcome, elapsed } = await checkUpload((ms) => ms < 115_000 ? errored : pending);
  assert.equal(outcome, UPLOAD_PENDING);
  assert.equal(elapsed, 120_000);
});

test("an upload that remains pending through the deadline still reports unconfirmed", async () => {
  const { outcome, elapsed } = await checkUpload(() => pending);
  assert.equal(outcome, UPLOAD_PENDING);
  assert.equal(elapsed, 120_000);
});

test("missing upload metadata still reports that macOS did not report the upload", async () => {
  const { outcome, polls } = await checkUpload(() => ({ exists: true }));
  assert.equal(outcome, UPLOAD_UNKNOWN);
  assert.deepEqual(polls, [0]);
});
