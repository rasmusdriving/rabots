// Artifacts: the pages and files a bot shows, their page keys, and what a finished tool call makes of them (docs/build/step-2f.md).
import type { ArtifactRow } from "../store.js";
import type { Artifact, ArtifactItem, Methods } from "../../shared/protocol.js";
import type { Engine } from "../engine.js";
import { EngineError } from "../errors.js";
import { posix } from "node:path";
import { log } from "../log.js";
import { checkShowPath, claudeMade, cleanTitle, filesSignature, PAGE_KEY_MS, PAGE_KEY_REUSE_MS, pageFile, type PageFile, pickTitle, resultLink, resultTitle } from "../artifacts.js";
import type { BotRuntime, Helper, RunningTool } from "./runtime.js";
import { now } from "./words.js";
import { randomBytes, randomUUID } from "node:crypto";
import { toolId, type ToolResult } from "../claude/session.js";
import { ok, problem, TOOL_NAMES } from "../team.js";
import { helperHome } from "./helpers.js";

/** An artifact as the protocol has it, without what only the engine keeps. */
export function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    botId: row.botId,
    kind: row.kind,
    title: row.title,
    ...(row.path !== undefined ? { path: row.path } : {}),
    ...(row.url !== undefined ? { url: row.url } : {}),
    rev: row.rev,
    available: row.available,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ------------------------------------------------------------ artifacts (docs/build/step-2f.md)

/** A bot's artifacts, newest change first. */
export function listArtifacts(eng: Engine, botId: string): Artifact[] {
  eng.bot(botId);
  return eng.store.listArtifacts(botId).map(toArtifact);
}

/**
 * Where a "page" can be shown now: a path under /page/<key>/ (the server makes it a full URL for
 * the desktop window). The key is the same while it has more than an hour left.
 */
export function openArtifact(eng: Engine, params: Methods["artifact.open"]["params"]): { path: string; rev: number } {
  const rt = eng.bot(params.botId);
  let row = liveArtifact(eng, params.botId, params.artifactId);
  if (row.kind === "link" || !row.path) throw new EngineError("conflict", "This artifact lives on Claude. Open its link instead.");
  row = checkArtifact(eng, rt, row);
  if (!row.available) throw new EngineError("conflict", "The file of this artifact is gone.");
  const key = pageKeyFor(eng, row);
  return { path: `/page/${key}/${encodeURIComponent(posix.basename(row.path!))}?r=${row.rev}`, rev: row.rev };
}

/** Takes an artifact off its bot's list. Its file and anything on Claude stay; old lines in the chat stay as they are. */
export function removeArtifact(eng: Engine, params: Methods["artifact.remove"]["params"]): void {
  eng.bot(params.botId);
  const row = liveArtifact(eng, params.botId, params.artifactId);
  eng.store.removeArtifact(row.id);
  for (const [key, k] of [...eng.pageKeys]) if (k.artifactId === row.id) eng.pageKeys.delete(key);
  eng.opts.emit("artifact.changed", { botId: row.botId, removedId: row.id });
  log.info(`Bot ${row.botId}: an artifact was taken off the list`);
}

/**
 * The file an address under /page/<key>/ names, or nothing. An unknown or expired key, an artifact
 * taken off the list or of a retired bot, a link, and a file that is gone all give nothing.
 */
export function pageRequest(eng: Engine, key: string, rest: string): PageFile {
  const no = { ok: false } as const;
  const k = eng.pageKeys.get(key);
  if (!k) return no;
  if (k.expires <= eng.clock()) {
    eng.pageKeys.delete(key);
    return no;
  }
  const rt = eng.bots.get(k.botId);
  const row = eng.store.getArtifact(k.artifactId);
  if (!rt || !row || row.removed || row.retired || row.kind !== "page" || !row.path) return no;
  return pageFile(rt.folder.dir, row.path, rest);
}

/**
 * Looks whether the files of a bot's page artifacts (or of every bot's) changed: a change raises
 * `rev`, a file that is gone makes the artifact unavailable, and one that comes back makes it
 * available again. Each change is sent as "artifact.changed"; nothing is added to the chat.
 */
export function checkArtifacts(eng: Engine, botId?: string): void {
  if (!eng.store.isOpen) return;
  for (const row of eng.store.listArtifacts(botId)) {
    if (row.kind !== "page" || !row.path) continue;
    const rt = eng.bots.get(row.botId);
    if (rt) checkArtifact(eng, rt, row);
  }
}

export function scheduleArtifactCheck(eng: Engine, rt: BotRuntime): void {
  eng.artifactChecks.add(rt.folder.id);
  if (eng.artifactTimer || eng.stopping) return;
  eng.artifactTimer = setTimeout(() => {
    eng.artifactTimer = undefined;
    const ids = [...eng.artifactChecks];
    eng.artifactChecks.clear();
    try {
      for (const id of ids) if (eng.bots.has(id)) eng.checkArtifacts(id);
    } catch (err) {
      log.error("Could not look at the bots' artifacts", err);
    }
  }, eng.artifactCheckMs);
  eng.artifactTimer.unref?.();
}

export function liveArtifact(eng: Engine, botId: string, artifactId: string): ArtifactRow {
  const row = eng.store.getArtifact(artifactId);
  if (!row || row.botId !== botId || row.removed || row.retired) throw new EngineError("not_found", "There is no such artifact.");
  return row;
}

export function checkArtifact(eng: Engine, rt: BotRuntime, row: ArtifactRow): ArtifactRow {
  if (row.kind !== "page" || !row.path) return row;
  const { exists, sig } = filesSignature(rt.folder.dir, row.path);
  let next: ArtifactRow;
  if (!exists) {
    if (!row.available) return row;
    next = { ...row, available: false, updatedAt: now() };
  } else if (!row.available) {
    next = { ...row, available: true, sig, rev: row.rev + 1, updatedAt: now() };
  } else if (sig !== row.sig) {
    next = { ...row, sig, rev: row.rev + 1, updatedAt: now() };
  } else return row;
  eng.store.updateArtifact(next);
  eng.opts.emit("artifact.changed", { botId: row.botId, artifact: toArtifact(next) });
  return next;
}

export function pageKeyFor(eng: Engine, row: ArtifactRow): string {
  const at = eng.clock();
  for (const [key, k] of [...eng.pageKeys]) if (k.expires <= at) eng.pageKeys.delete(key);
  for (const [key, k] of eng.pageKeys) if (k.artifactId === row.id && k.expires - at > PAGE_KEY_REUSE_MS) return key;
  const key = randomBytes(32).toString("base64url");
  eng.pageKeys.set(key, { artifactId: row.id, botId: row.botId, expires: at + PAGE_KEY_MS });
  return key;
}

/**
 * show_artifact: the first time for a path a "page" and a "made" line; later an "updated" line
 * (and a new title when one is given). Never a card. The line goes where the call was made: the
 * thread of the turn, or for a helper the thread where its row stands.
 */
export async function showArtifactFor(eng: Engine, rt: BotRuntime, args: { path: string; title?: string }): Promise<ToolResult> {
  const threadId = await toolPlace(eng, rt, TOOL_NAMES.showArtifact, (input) => input.path === args.path);
  const check = checkShowPath(rt.folder.dir, String(args.path ?? ""));
  if (!check.ok) return problem(check.why);
  if (!eng.bots.has(rt.folder.id) || !eng.store.isOpen) return problem("Pobots is stopping, so the artifact was not shown.");
  const { row, made } = pageArtifact(eng, rt, check.rel, check.full, args.title);
  artifactLine(eng, rt, row, made ? "made" : "updated", threadId);
  log.info(`Bot ${rt.folder.id}: ${made ? "showed a new artifact" : "showed an artifact again"}`);
  return ok(`The person can now open "${row.title}" beside the chat.`);
}

/** The page artifact for an HTML file in the bot's folder: made when new, else its files looked at, its title and link changed when given. */
export function pageArtifact(eng: Engine, rt: BotRuntime, rel: string, full: string, title?: string, url?: string): { row: ArtifactRow; made: boolean } {
  const existing = eng.store.artifactByPath(rt.folder.id, rel);
  if (existing) {
    const looked = checkArtifact(eng, rt, existing);
    const t = cleanTitle(title);
    const next: ArtifactRow = { ...looked, ...(t ? { title: t } : {}), ...(url ? { url } : {}), updatedAt: now() };
    eng.store.updateArtifact(next);
    return { row: next, made: false };
  }
  const at = now();
  const { sig } = filesSignature(rt.folder.dir, rel);
  const row: ArtifactRow = {
    id: randomUUID(),
    botId: rt.folder.id,
    kind: "page",
    title: pickTitle(title, full, rel),
    path: rel,
    ...(url ? { url } : {}),
    rev: 1,
    available: true,
    sig,
    createdAt: at,
    updatedAt: at,
    removed: false,
    retired: false,
  };
  eng.store.addArtifact(row);
  return { row, made: true };
}

/** Sends the artifact as it is now, and puts its line in the thread. */
export function artifactLine(eng: Engine, rt: BotRuntime, row: ArtifactRow, what: ArtifactItem["what"], threadId: string): void {
  const artifact = toArtifact(row);
  eng.opts.emit("artifact.changed", { botId: rt.folder.id, artifact });
  eng.addItem(rt, { kind: "artifact", at: now(), botId: rt.folder.id, artifact, what }, threadId);
}

/**
 * The thread a call of one of the bot's own tools stands in: the turn's thread for the bot's own
 * call, or for a helper's call the thread where its (top) row stands, so that the person sees it.
 * The harness sends the call's message before it runs the tool, but the two travel apart; wait a
 * moment for it, then fall back to the thread the bot works in now.
 */
export async function toolPlace(eng: Engine, rt: BotRuntime, name: string, match: (input: Record<string, unknown>) => boolean): Promise<string> {
  const id = toolId(name);
  const find = (): string | undefined => {
    if ([...rt.tools.values()].some((t) => t.name === id && match(t.input))) return eng.liveThread(rt);
    for (const h of rt.helpers.values()) if ([...h.tools.values()].some((t) => t.name === id && match(t.input))) return helperHome(eng, rt, h);
    return undefined;
  };
  for (let i = 0; i < 10; i++) {
    const found = find();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  return eng.liveThread(rt);
}

/**
 * A tool call came back without an error. When it published something on Claude (the harness's
 * Artifact tool) or made a new document there (the Claude Docs connector) and its result names a
 * claude.ai artifact link, the engine records the link. Nothing about the call itself changes.
 */
export function afterClaudeCall(eng: Engine, rt: BotRuntime, tool: RunningTool, e: { result?: unknown; full?: string; text?: string }, helper?: Helper): void {
  const made = claudeMade(tool.name, tool.input);
  if (!made) return;
  const url = resultLink(e.result, e.full ?? e.text);
  if (!url || !eng.store.isOpen || !eng.bots.has(rt.folder.id)) return;
  const botId = rt.folder.id;
  const threadId = helper ? helperHome(eng, rt, helper) : eng.liveThread(rt);
  const turnKey = rt.busy && rt.turn ? rt.turn.id : helper ? `helper:${helper.toolUseId}` : "rest";
  const known = eng.store.artifactByUrl(botId, url);
  if (known) {
    const next: ArtifactRow = { ...known, updatedAt: now() };
    eng.store.updateArtifact(next);
    const seen = `${turnKey}:${known.id}`;
    if (eng.publishSeen.has(seen)) {
      eng.opts.emit("artifact.changed", { botId, artifact: toArtifact(next) });
      return;
    }
    if (eng.publishSeen.size > 2000) eng.publishSeen.clear();
    eng.publishSeen.add(seen);
    artifactLine(eng, rt, next, "updated", threadId);
    log.info(`Bot ${botId}: published an artifact on Claude again`);
    return;
  }
  if (made.kind === "publish" && made.filePath) {
    const check = checkShowPath(rt.folder.dir, made.filePath);
    if (check.ok) {
      const { row } = pageArtifact(eng, rt, check.rel, check.full, made.title, url);
      artifactLine(eng, rt, row, "published", threadId);
      log.info(`Bot ${botId}: published an artifact on Claude`);
      return;
    }
  }
  const at = now();
  const title = made.title ?? resultTitle(e.result) ?? (made.kind === "document" ? "Document on Claude" : "Artifact on Claude");
  const row: ArtifactRow = { id: randomUUID(), botId, kind: "link", title, url, rev: 0, available: true, createdAt: at, updatedAt: at, removed: false, retired: false };
  eng.store.addArtifact(row);
  artifactLine(eng, rt, row, "made", threadId);
  log.info(`Bot ${botId}: ${made.kind === "document" ? "made a document on Claude" : "made an artifact on Claude"}`);
}
