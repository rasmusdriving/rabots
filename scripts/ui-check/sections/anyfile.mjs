// The window check, section "anyfile". Run it alone: node scripts/ui-check.mjs --only=anyfile
// What it shares with the other sections is in ../lib.mjs; a helper used by one section only stays here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { root, arg, shots, keep, SECTIONS, only, skip, page, sleep, work, b, clock, check, ev, HELPERS, until, open, key, type, shot, goTo, houseRules, focusRings, rowLine, memory } from "../lib.mjs";

export default async function section() {
  step7cAnyfile: {
  const A = (name) => `any file: ${name}`;
  for (const theme of ["dark", "light"]) {
    await open("notkept=1", { theme });
    const chips = await until(`(() => { const y = $$(".app-main .app-you").at(-1); if (!y) return null; return { files: $$(".pb-msg-file", y).map((f) => [f.querySelector(".pb-chip-name").textContent, f.querySelector(".pb-chip-meta").textContent, f.tagName, f.getAttribute("title")]), pictures: $$(".pb-msg-pictures img, .pb-msg-picture", y).length }; })()`);
    check(A(`${theme}: an attachment removed after 14 days shows its name with No longer kept, no picture and no download`),
      chips?.pictures === 0 && JSON.stringify(chips.files.map((f) => f.slice(0, 3))) === JSON.stringify([["TIM möten att följa upp.zip", "No longer kept", "DIV"], ["Whiteboard.png", "No longer kept", "DIV"]]) && chips.files[0][3] === "TIM möten att följa upp.zip. No longer kept", chips);
  }
  // A helper's card says which helper asks.
  await open("helpercard=1");
  const card = await until(`(() => { const c = $$(".app-rail .pb-card").find((x) => x.querySelector(".pb-card-helper")); return c && { head: c.querySelector(".pb-card-head").textContent, helper: c.querySelector(".pb-card-helper").textContent, title: c.querySelector(".pb-card-title").textContent }; })()`);
  check(A("a card a helper raised names the helper under the head"), card?.helper === "For its helper Fix notifications review findings" && card.head === "Kaja asks for permission" && card.title === "Run this command?", card);
  const plain = await ev(`$$(".app-rail .pb-card").filter((x) => !x.querySelector(".pb-card-helper")).length > 0`);
  check(A("cards the bot itself raised have no such line"), plain === true);
  }
}
