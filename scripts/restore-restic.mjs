// The restic format reader for restore.mjs. Keep the format 1 reader independent.
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { cleanPasswordRef, REF_PROBLEM, RESTIC_MISSING } from "../shared/backup-settings.ts";
import { findRestic, parseSnapshots, restic, STAGE_NAME } from "../engine/core/restic-cli.ts";
import { opRead } from "../engine/op-read.ts";

export async function openRepository(args) {
  const executable = findRestic(args.restic);
  if (!executable) throw new Error(RESTIC_MISSING);
  if (!existsSync(join(args.file, "config"))) throw new Error("That folder is not a restic repository.");
  const ref = args.passwordRef;
  if (ref !== undefined && !cleanPasswordRef(ref)) throw new Error(REF_PROBLEM);
  const password = ref ? await opRead(cleanPasswordRef(ref)) : process.env.RESTIC_PASSWORD;
  if (!password) throw new Error("Could not read the backup password. Give a 1Password reference with --password-ref=.");
  const run = (commands) => restic({ executable, folder: args.file, password, args: commands });
  const list = parseSnapshots(await run(["snapshots", "--no-lock", "--json", "--tag", "pobots"]))
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return { run, list };
}

export function chooseSnapshot(list, id = "latest") {
  if (id === "latest") {
    if (!list.length) throw new Error("The repository has no completed Pobots snapshots.");
    return list[0];
  }
  if (!/^[a-f0-9]{8,64}$/.test(id)) throw new Error("Use a snapshot id from --check, or latest.");
  const matches = list.filter((s) => s.id.startsWith(id));
  if (matches.length !== 1) throw new Error("That completed snapshot was not found or its id is not unique.");
  return matches[0];
}

const plainParts = (root, source) => {
  let current = root;
  for (const part of source.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!lstatSync(current).isDirectory()) throw new Error("A backup source folder was not restored as a plain folder.");
  }
  return current;
};

function validateBots(path, depth = 0) {
  for (const name of readdirSync(path)) {
    const file = join(path, name);
    const st = lstatSync(file);
    if (st.isDirectory()) validateBots(file, depth + 1);
    else if (st.isFile() || (depth > 0 && st.isSymbolicLink())) continue;
    else throw new Error("The backup has an unexpected item in its bots folder.");
  }
}

/** Restores to private scratch space, then exposes only the two source trees to putInPlace. */
export async function unpackSnapshot(repo, snapshot, into) {
  const [one, two] = snapshot.paths;
  if (snapshot.paths.length !== 2 || ![one, two].every((p) => typeof p === "string" && isAbsolute(p) && normalize(p) === p && p !== sep)) {
    throw new Error("The snapshot does not contain the expected Pobots folders.");
  }
  const stages = [one, two].filter((p) => basename(p) === STAGE_NAME);
  if (stages.length !== 1 || one.startsWith(two + sep) || two.startsWith(one + sep)) {
    throw new Error("The snapshot does not contain two separate Pobots folders.");
  }
  const stage = stages[0];
  const bots = stage === one ? two : one;
  const scratch = join(into, "restic");
  const ready = join(into, "ready");
  mkdirSync(scratch, { mode: 0o700 });
  mkdirSync(ready, { mode: 0o700 });
  await repo.run(["restore", snapshot.id, "--target", resolve(scratch), "--verify"]);
  const staged = plainParts(scratch, stage);
  const botRoot = plainParts(scratch, bots);
  for (const name of readdirSync(staged)) {
    if (!["manifest.json", "pobots.db", "config.json"].includes(name) || !lstatSync(join(staged, name)).isFile()) {
      throw new Error("The snapshot's data folder does not contain only plain Pobots files.");
    }
    renameSync(join(staged, name), join(ready, name));
  }
  validateBots(botRoot);
  renameSync(botRoot, join(ready, "bots"));
  return ready;
}
