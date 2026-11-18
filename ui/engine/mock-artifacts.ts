// The mock engine's artifacts (step 2f): each bot's list, the page handed out for one, the scene's
// artifacts, and the turns that make, update and publish one. Free functions of the mock: `mock` is
// the MockEngine, and each keeps a one-line method there. Moved out of mock.ts unchanged on
// 15 Nov 2026 (docs/build/step-split.md).
import type { ActivityItem, Artifact, ArtifactItem, BotItem, NoticeItem, UserItem } from "../../shared/protocol";
import { EngineError } from "./types";
import { at, today, later, type Turn, PUBLISH_ASK, CLAUDE_LINK, publicArtifact } from "./mock-data";
import type { MockEngine } from "./mock";

export function listArtifacts(mock: MockEngine, botId: string): Artifact[] {
  mock.bot(botId);
  return (mock.artifactLists.get(botId) ?? []).map(publicArtifact).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function artifact(mock: MockEngine, botId: string, artifactId: string): Artifact & { chart?: number[] } {
  const a = (mock.artifactLists.get(botId) ?? []).find((x) => x.id === artifactId);
  if (!a) throw new EngineError({ code: "not_found", message: "That artifact is gone." });
  return a;
}

export function putArtifact(mock: MockEngine, a: Artifact & { chart?: number[] }): void {
  const list = mock.artifactLists.get(a.botId) ?? [];
  mock.artifactLists.set(a.botId, [...list.filter((x) => x.id !== a.id), a]);
}

export function artifactChanged(mock: MockEngine, a: Artifact): void {
  mock.emit({ event: "artifact.changed", data: { botId: a.botId, artifact: publicArtifact(a) } });
}

/** The line in the chat where the bot showed, changed or published an artifact. */
export function artifactItem(mock: MockEngine, threadId: string, a: Artifact, what: ArtifactItem["what"], turnId?: string, time?: string): ArtifactItem {
  return mock.add<ArtifactItem>(threadId, { kind: "artifact", botId: a.botId, turnId, artifact: publicArtifact(a), what }, time);
}

/**
 * A small real page for a rev of an artifact, as a blob: document. It carries its own policy: no
 * scripts, nothing from the network. The frame around it is sealed by the window's sandbox.
 */
export function pageAddress(mock: MockEngine, a: Artifact & { chart?: number[] }): string {
  const key = `${a.id}:${a.rev}`;
  const known = mock.artifactPages.get(key);
  if (known) return known;
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const chart = a.chart ?? [];
  const top = Math.max(1, ...chart);
  const bars = chart
    .map((n, i) => `<rect x="${i * 44 + 8}" y="${120 - (n / top) * 100}" width="28" height="${(n / top) * 100}" rx="4"></rect><text x="${i * 44 + 22}" y="138">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i % 7]}</text>`)
    .join("");
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(a.title)}</title>`,
    "<style>",
    ":root { color-scheme: light dark; --bg: #fbfaf7; --ink: #1d1c1a; --muted: #6b6862; --bar: #3a6ea5; --card: #ffffff; }",
    "@media (prefers-color-scheme: dark) { :root { --bg: #17181b; --ink: #ecebe8; --muted: #a19e98; --bar: #7aa7d9; --card: #202226; } }",
    "body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, sans-serif; }",
    "main { max-width: 720px; margin: 0 auto; padding: 28px 20px 40px; }",
    "h1 { font-size: 22px; line-height: 1.25; margin: 0 0 4px; } p { margin: 0 0 12px; } .muted { color: var(--muted); font-size: 13px; }",
    ".card { background: var(--card); border-radius: 12px; padding: 16px; margin: 16px 0; box-shadow: 0 1px 3px rgba(0,0,0,.12); }",
    "svg { display: block; width: 100%; height: auto; max-height: 240px; } rect { fill: var(--bar); } text { fill: var(--muted); font-size: 11px; text-anchor: middle; }",
    "</style></head><body><main>",
    `<h1>${esc(a.title)}</h1>`,
    `<p class="muted" data-rev="${a.rev}">Version ${a.rev}</p>`,
    "<p>Three onboardings are on track. Nordvik imports on Thursday at 10:00; the other two wait for a kickoff date.</p>",
    chart.length ? `<div class="card"><svg viewBox="0 0 ${chart.length * 44 + 16} 146" role="img" aria-label="People added per day">${bars}</svg></div>` : "",
    '<p class="muted">Made by Kaja for you. The numbers are in this page.</p>',
    "</main></body></html>",
  ].join("\n");
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  mock.artifactPages.set(key, url);
  return url;
}

/**
 * The artifacts scene: Kaja's chat with a page made (and later updated), a page published to Claude
 * in the same turn it was made, a document that lives only on Claude, and a page whose file is gone.
 * Each finished turn folds its work; the rows stay with the answers.
 */
export function seedArtifacts(mock: MockEngine): void {
  const t = "kaja-main";
  const page = (id: string, title: string, made: string, extra: Partial<Artifact & { chart: number[] }> = {}) => {
    const a: Artifact & { chart?: number[] } = { id, botId: "kaja", kind: "page", title, path: `artifacts/${id}/index.html`, rev: 1, available: true, createdAt: made, updatedAt: made, ...extra };
    mock.putArtifact(a);
    return a;
  };
  const step = (label: string, turnId: string, time: string, ms = 4_000) =>
    mock.add<ActivityItem>(t, { kind: "activity", botId: "kaja", turnId, label, status: "done", durationMs: ms }, time);
  const say = (text: string, turnId: string, time: string) => mock.add<BotItem>(t, { kind: "bot", botId: "kaja", streaming: false, turnId, text }, time);
  const ask = (text: string, turnId: string, time: string) => mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, turnId, text }, time);

  // A page whose file was deleted later.
  const pricing = page("pricing-mockup", "Pricing mock-up", today(9, 14));
  ask("Mock up the new pricing page so I can look at it.", "ta-pricing", today(9, 13));
  step("Wrote artifacts/pricing-mockup/index.html", "ta-pricing", today(9, 13));
  mock.artifactItem(t, { ...pricing }, "made", "ta-pricing", today(9, 14));
  say("Here is a first mock-up of the pricing page.", "ta-pricing", today(9, 14));
  pricing.available = false;
  pricing.updatedAt = today(9, 30);

  // A page with a chart, made here and updated further down.
  const status = page("onboarding-status", "Onboarding status", today(9, 20), { chart: [4, 7, 5, 9, 6] });
  ask("Make me a status page for the onboardings, with a chart.", "ta-status", today(9, 18));
  step("Read state/onboardings.md", "ta-status", today(9, 18));
  step("Wrote artifacts/onboarding-status/index.html", "ta-status", today(9, 19));
  mock.artifactItem(t, { ...status }, "made", "ta-status", today(9, 20));
  say("It is open beside the chat when you want it. Three onboardings are on track; Nordvik imports on Thursday.", "ta-status", today(9, 20));

  // A page made and published to Claude in one turn: one row, the newest.
  const report = page("customer-report", "Customer report", today(9, 24));
  ask("Write a short customer report I can share, and publish it to Claude.", "ta-report", today(9, 22));
  step("Wrote artifacts/customer-report/index.html", "ta-report", today(9, 23));
  mock.artifactItem(t, { ...report }, "made", "ta-report", today(9, 24));
  step("Published it to Claude", "ta-report", today(9, 24), 6_000);
  report.url = CLAUDE_LINK("customer-report");
  report.rev = 2;
  report.updatedAt = today(9, 25);
  mock.artifactItem(t, { ...report }, "published", "ta-report", today(9, 25));
  say("Done. The report is on Claude, private until you share it.", "ta-report", today(9, 25));

  // A document that lives only on Claude.
  const agenda: Artifact = { id: "kickoff-agenda", botId: "kaja", kind: "link", title: "Kickoff agenda", url: CLAUDE_LINK("kickoff-agenda"), rev: 0, available: true, createdAt: today(9, 33), updatedAt: today(9, 33) };
  mock.putArtifact(agenda);
  ask("Draft the Lindgren kickoff agenda as a document on Claude.", "ta-agenda", today(9, 32));
  step("Made a document on Claude", "ta-agenda", today(9, 33), 9_000);
  mock.artifactItem(t, agenda, "made", "ta-agenda", today(9, 33));
  say("The agenda is a document on Claude. It opens in a window of its own.", "ta-agenda", today(9, 33));

  // The status page updated.
  ask("Add last week's numbers to the status page.", "ta-update", today(9, 40));
  step("Edited artifacts/onboarding-status/index.html", "ta-update", today(9, 40));
  status.rev = 3;
  status.updatedAt = today(9, 41);
  status.chart = [4, 7, 5, 9, 6, 8, 3];
  mock.artifactItem(t, { ...status }, "updated", "ta-update", today(9, 41));
  say("Updated. Last week is in the chart now.", "ta-update", today(9, 41));

  mock.bots = mock.bots.map((b) => (b.id === "kaja" ? { ...b, state: "done", activity: "Answered at 09:41" } : b));
  mock.cards = mock.cards.filter((c) => c.id === "c1" || c.id === "c2");
}

/**
 * A turn that makes an artifact and shows it: a moment of thinking, a step writing the page, the
 * artifact's row, then a short answer. Held at every moment with `holdSteps`.
 */
export async function runArtifactTurn(mock: MockEngine, botId: string, message: UserItem): Promise<void> {
  const threadId = mock.bot(botId).mainThreadId;
  const turn: Turn = { botId, threadId, stopped: false };
  const turnId = `turn${mock.nextId++}`;
  mock.turns.set(botId, turn);
  mock.replace({ ...message, queued: false, turnId });
  const think = async (before: string) => {
    mock.setState(botId, "thinking", "Thinking");
    await later(400);
    await mock.stepGate(`thinking before ${before}`);
  };
  const id = `status-check-${mock.nextId++}`;
  const path = `artifacts/${id}/index.html`;
  await think("writing the page");
  if (!turn.stopped) {
    mock.setState(botId, "working", `Writing ${path}`);
    const tool = mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId, label: `Writing ${path}`, status: "running" });
    mock.upsert(tool);
    await later(500);
    await mock.stepGate("writing the page");
    mock.replace({ ...tool, label: `Wrote ${path}`, status: "done", durationMs: 500 });
  }
  if (!turn.stopped) {
    const now = new Date().toISOString();
    const a: Artifact & { chart?: number[] } = { id, botId, kind: "page", title: "Status check", path, rev: 1, available: true, createdAt: now, updatedAt: now, chart: [3, 5, 4, 6] };
    mock.putArtifact(a);
    mock.artifactChanged(a);
    mock.upsert(mock.artifactItem(threadId, a, "made", turnId));
    await mock.stepGate("after the artifact");
  }
  if (!turn.stopped) {
    await think("the answer");
    mock.setState(botId, "thinking", "Writing a reply");
    await mock.stream(threadId, botId, turnId, "It is open beside the chat when you want to look at it.", turn);
  }
  mock.stepAt = "";
  mock.turns.delete(botId);
  if (!mock.bots.some((b) => b.id === botId)) return;
  if (turn.stopped) {
    mock.upsert(mock.add<NoticeItem>(threadId, { kind: "notice", tone: "info", text: "Stopped. The answer above is not finished." }));
    mock.settle(botId, "idle", "Stopped by you");
  } else mock.settle(botId, "done", `Answered at ${new Date().toTimeString().slice(0, 5)}`);
  mock.afterTurn(botId);
}

/** The message "Publish to Claude" sends: the bot publishes the page, and the artifact gets its link. */
export async function runPublishTurn(mock: MockEngine, botId: string, message: UserItem): Promise<void> {
  const threadId = mock.bot(botId).mainThreadId;
  const turn: Turn = { botId, threadId, stopped: false };
  const turnId = `turn${mock.nextId++}`;
  mock.turns.set(botId, turn);
  mock.replace({ ...message, queued: false, turnId });
  const title = PUBLISH_ASK.exec(message.text)?.[1] ?? "";
  const a = (mock.artifactLists.get(botId) ?? []).find((x) => x.title === title && x.kind === "page");
  mock.setState(botId, "thinking", "Thinking");
  await later(400);
  if (!turn.stopped && a) {
    mock.setState(botId, "working", "Publishing it to Claude");
    const tool = mock.add<ActivityItem>(threadId, { kind: "activity", botId, turnId, label: "Publishing it to Claude", status: "running" });
    mock.upsert(tool);
    await later(600);
    mock.replace({ ...tool, label: "Published it to Claude", status: "done", durationMs: 600 });
    a.url = CLAUDE_LINK(a.id);
    a.updatedAt = new Date().toISOString();
    mock.artifactChanged(a);
    mock.upsert(mock.artifactItem(threadId, a, "published", turnId));
  }
  if (!turn.stopped) {
    mock.setState(botId, "thinking", "Writing a reply");
    await mock.stream(threadId, botId, turnId, a ? "Done. It is on Claude now, private until you share it." : "I could not find that artifact.", turn);
  }
  mock.turns.delete(botId);
  if (!mock.bots.some((b) => b.id === botId)) return;
  mock.settle(botId, turn.stopped ? "idle" : "done", turn.stopped ? "Stopped by you" : `Answered at ${new Date().toTimeString().slice(0, 5)}`);
  mock.afterTurn(botId);
}
