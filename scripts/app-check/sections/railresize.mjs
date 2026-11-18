// The app check, section "railresize": a wider rail, and nothing in it runs past its edge (17 Nov
// 2026, docs/build/step-rail-resize.md). Run it alone: node scripts/app-check.mjs --only=railresize
// A real Claude bot tells the person something with a long address and a long word (notify_human)
// and asks a question that takes a typed answer (ask_human); in the real window nothing in the rail
// reaches past its edge, the handle drags the rail wider, a reload keeps the width from the first
// frame, a double-click puts it back, and the typed answer still reaches the bot.
import { sleep, check, sideChannel, js, shot, until, openWindow, run, cmd } from "../lib.mjs";

const LONG_URL = "https://example.com/workspace/onboardings/Nordvik-kickoff-notes-and-every-decision-of-the-week-2b9c1f0e7a8d4c3b9e6f5a2d1c0b8e7f?pvs=4";
const LONG_WORD = "Onboardingstatusrapporteringsverktygskonfigurationsdokumentationen";
const railW = `Math.round(document.querySelector(".app-rail").getBoundingClientRect().width)`;
const handle = `document.querySelector(".pb-rail-handle")`;

/** Nothing in the rail past what it shows, text included (as far as a clipping box lets it show). */
const fits = `(() => {
  const r = document.querySelector(".app-rail");
  const edge = r.getBoundingClientRect().left + r.clientLeft + r.clientWidth + 0.5;
  const past = [...r.querySelectorAll("*")].filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.right > edge && !el.closest("[data-leaving]"); }).map((el) => String(el.className).split(" ")[0]);
  const shown = (node) => { const range = document.createRange(); range.selectNodeContents(node); let right = range.getBoundingClientRect().right;
    for (let a = node.parentElement; a && a !== r; a = a.parentElement) { if (getComputedStyle(a).overflowX !== "visible") { right = Math.min(right, a.getBoundingClientRect().right); break; } }
    return right; };
  const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
  const text = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.trim() && !n.parentElement.closest("[data-leaving]") && shown(n) > edge) text.push(n.textContent.trim().slice(0, 30));
  return JSON.stringify({ past: past.slice(0, 5), text: text.slice(0, 5), scroll: r.scrollWidth - r.clientWidth });
})()`;
const fitsOk = (f) => !!f && f.past.length === 0 && f.text.length === 0 && f.scroll <= 0;

async function mouse(type, x, y, extra = {}) {
  await cmd("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra });
}
const handleAt = async () => JSON.parse(await js(`(() => { const r = ${handle}.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));

export default async function section() {
  const { endpoint, cheap } = run;
  const side = await sideChannel(endpoint);
  const snap = await side.request("snapshot");
  const haiku = snap.models.find((m) => m.harness !== "codex" && /haiku/.test(m.id)) ?? cheap;
  const bot = (await side.request("bot.create", { name: "Railer", purpose: "Posts long cards for the rail check", job: "Do what you are asked, briefly.", model: haiku.id, effort: haiku.efforts.includes("low") ? "low" : haiku.defaultEffort, access: "asks-first" })).bot;
  await openWindow(endpoint);
  await until(`document.querySelectorAll(".app-row").length > 0`, 20_000);
  await js(`(localStorage.removeItem("pobots.railWidth"), true)`);
  await side.request("message.send", {
    botId: bot.id,
    text: [
      "This is a test inside Pobots only. Use no connectors or MCP servers other than the Pobots tools named here, and change no files outside your own folder.",
      `First use the Pobots tool notify_human (mcp__pobots__notify_human) once, with the title "Notes for ${LONG_WORD}" and the text exactly: I put the kickoff notes at ${LONG_URL}`,
      `Then use the Pobots tool ask_human (mcp__pobots__ask_human) once, with the question "Where should the report go?", the context exactly "Today it lies at ${LONG_URL}", allow_text true and no choices.`,
      "When my answer comes, reply with only the place I named.",
    ].join("\n\n"),
  });
  const cards = await until(`(() => { const t = [...document.querySelectorAll(".app-rail .pb-card-title")].map((x) => x.textContent); return t.some((x) => x.startsWith("Notes for")) && t.includes("Where should the report go?") ? t.join(" | ") : null; })()`, 180_000);
  check("rail: the bot's note with a long word and its typed question are in the rail", !!cards, String(cards));
  await sleep(600);

  // The default width, nothing past the edge.
  check("rail: the rail starts at its default width", (await js(railW)) === 344, String(await js(railW)));
  let f = JSON.parse(await js(fits));
  check("rail: with a long address and a long word nothing in the rail reaches past its edge", fitsOk(f), JSON.stringify(f));
  await js(`(() => { const r = document.querySelector(".app-rail"); const c = [...r.querySelectorAll(".pb-card")].find((x) => x.textContent.includes("Notes for")); r.scrollTop += c.getBoundingClientRect().top - r.getBoundingClientRect().top - 8; return true; })()`);
  await shot("90-rail-long-cards");

  // Drag wider.
  const h = await handleAt();
  await mouse("mouseMoved", h.x, h.y);
  await mouse("mousePressed", h.x, h.y, { clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) {
    await mouse("mouseMoved", h.x - i * 20, h.y, { buttons: 1 });
    await sleep(20);
  }
  await mouse("mouseReleased", h.x - 160, h.y, { clickCount: 1 });
  await sleep(200);
  const wide = await js(railW);
  check("rail: dragging the handle left makes the rail wider", Math.abs(wide - 504) <= 2, String(wide));
  f = JSON.parse(await js(fits));
  check("rail: wider, nothing reaches past its edge", fitsOk(f), JSON.stringify(f));
  await shot("91-rail-wider");

  // Reload: the width from the first frame.
  const { result } = await cmd("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { window.__railWidths = []; const tick = () => { const r = document.querySelector(".app-rail"); if (r) window.__railWidths.push(Math.round(r.getBoundingClientRect().width)); if (window.__railWidths.length < 30) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })();`,
  });
  await cmd("Page.reload");
  await until(`(window.__railWidths ?? []).length >= 30`, 20_000);
  if (result?.identifier) await cmd("Page.removeScriptToEvaluateOnNewDocument", { identifier: result.identifier });
  const frames = await js(`JSON.stringify(window.__railWidths ?? [])`);
  check("rail: after a reload the rail has the chosen width from the first frame", JSON.parse(frames).length > 0 && JSON.parse(frames).every((w) => w === wide), frames.slice(0, 80));

  // Double-click: back to the default.
  const h2 = await handleAt();
  await mouse("mouseMoved", h2.x, h2.y);
  await mouse("mousePressed", h2.x, h2.y, { clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", h2.x, h2.y, { clickCount: 1 });
  await mouse("mousePressed", h2.x, h2.y, { clickCount: 2, buttons: 1 });
  await mouse("mouseReleased", h2.x, h2.y, { clickCount: 2 });
  await sleep(200);
  check("rail: a double-click on the handle puts it back to the default", (await js(railW)) === 344 && (await js(`localStorage.getItem("pobots.railWidth")`)) === null, String(await js(railW)));

  // The typed answer still reaches the bot.
  await until(`!!document.querySelector(".app-rail .app-card-answer .pb-input")`, 20_000);
  await js(`document.querySelector(".app-rail .app-card-answer .pb-input").focus()`);
  await cmd("Input.insertText", { text: "Lisbon" });
  await sleep(100);
  await js(`[...document.querySelectorAll(".app-rail .app-card-answer button")].find((b) => b.textContent.trim() === "Send answer").click()`);
  const end = Date.now() + 180_000;
  let items = [];
  while (Date.now() < end) {
    items = (await side.request("thread.read", { threadId: bot.mainThreadId, limit: 100 })).items;
    const b = (await side.request("snapshot")).bots.find((x) => x.id === bot.id);
    if (items.some((i) => i.kind === "bot" && !i.streaming && /lisbon/i.test(i.text ?? "")) && b && (b.state === "done" || b.state === "idle")) break;
    await sleep(1000);
  }
  check("rail: the typed answer reaches the bot", items.some((i) => i.kind === "bot" && /lisbon/i.test(i.text ?? "")), items.filter((i) => i.kind === "bot").map((i) => i.text).join(" ").slice(-120));
  // Test bots see the person's own connectors and MCP servers: none may be used.
  const outside = items.filter((i) => i.kind === "activity" && ((/^(Used|Using) .+ in /.test(i.label ?? "") && !/ in pobots$/i.test(i.label ?? "")) || /workbot/i.test(`${i.label} ${i.detail ?? ""}`)));
  check("rail: no connector or MCP server outside Pobots was used", outside.length === 0, outside.map((i) => i.label).join("; "));
  side.close();
}
