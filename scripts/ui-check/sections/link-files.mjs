// Protocol 35: how long a connection lasts (Ends after, the line on the row, Edit, Ended) and files
// from another Pobots under its message. Laptop and both phones, light and dark.
import { check, ev, goTo, open, shot, sleep, until } from "../lib.mjs";

const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const fill = (sel, text) => ev(`(() => {
  const input = document.querySelector(${JSON.stringify(sel)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,${JSON.stringify(text)});
  input.dispatchEvent(new Event("input",{ bubbles:true }));
})()`);
const choose = (sel, value) => ev(`(() => {
  const select = document.querySelector(${JSON.stringify(sel)});
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(select,${JSON.stringify(value)});
  select.dispatchEvent(new Event("change",{ bubbles:true }));
})()`);
const settings = async dimensions => {
  await open("publicBase=0", dimensions);
  await click(".pb-foot-settings");
  await until('!!document.querySelector("#setwin-tab-connections")');
  await click("#setwin-tab-connections");
  await until('!!document.querySelector(".pb-links")');
};
const lasts = 'document.querySelector(".pb-link-row .pb-link-lasts")?.textContent';
const rect = '(() => { const r = document.querySelector(".pb-link-row").getBoundingClientRect(); return [Math.round(r.y), Math.round(r.height)]; })()';
const fits = "document.documentElement.scrollWidth <= innerWidth";

async function openMain() {
  const phone = await ev('!!document.querySelector(".app-shell")?.dataset.phoneScreen');
  if (!phone) return goTo("Kaja", "chat");
  for (let i = 0; i < 6 && !(await ev('[...document.querySelectorAll(".app-row")].some((r) => r.checkVisibility())')); i++) {
    await ev("(history.back(), true)");
    await sleep(250);
  }
  await ev('[...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name").textContent === "Kaja").click()');
  return until('document.querySelector(".app-main")?.getAttribute("aria-label") === "Kaja"');
}

export default async function section() {
  for (const [width, height] of [[1280, 820], [390, 844], [360, 780]]) {
    for (const theme of ["light", "dark"]) {
      const where = `${width} ${theme}`;
      const M = name => `link-files: ${name} at ${where}`;
      await settings({ width, height, theme });
      await click(".pb-links > .pb-link-actions button");
      await until('!!document.querySelector(".pb-link-form select")');
      check(M("Ends after offers 24 hours, 30 days and never, never chosen"),
        await ev('(() => { const s = document.querySelector(".pb-link-form select"); return [...s.options].map(o => o.textContent).join(",") === "24 hours,30 days,Never" && s.value === "never"; })()'));
      await fill(".pb-link-form input", "Sam");
      await choose(".pb-link-form select", "24h");
      await click('.pb-link-form [type="submit"]');
      await until('document.querySelectorAll(".pb-link-form input").length === 2');
      check(M("the code's words say only the code expires"), await ev('document.querySelector(".pb-link-form").textContent.includes("That limit is only for the code, not for the connection.")'));
      await fill(".pb-link-form label:last-of-type input:not([readonly])", "pobots-link-1.example-peer-public-code");
      await click('.pb-link-form [type="submit"]');
      await until('!!document.querySelector(".pb-link-row[data-state=waiting]") && !document.querySelector(".pb-link-form")');
      check(M("before both are connected the row says when it will end"), !!(await until(`${lasts} === "Will end 24 hours after connecting"`)));
      const before = await ev(rect);
      await ev('window.pobotsMockConnection("connected")');
      check(M("connected shows the time left"), !!(await until(`${lasts} === "Ends in 24 hours"`)));
      check(M("the row keeps its place when connected"), JSON.stringify(before) === JSON.stringify(await ev(rect)));
      await ev('[...document.querySelectorAll(".pb-link-row button")].find(b => b.textContent === "Edit").click()');
      await until('!!document.querySelector(".pb-link-form select")');
      check(M("Edit shows name and ends after"), await ev('document.querySelector(".pb-link-form input").value === "Sam" && document.querySelector(".pb-link-form select").value === "24h"'));
      check(M("the Edit dialog fits"), await ev(fits));
      await shot(`link-files-edit-${width}-${theme}`);
      await choose(".pb-link-form select", "30d");
      await click('.pb-link-form [type="submit"]');
      check(M("a new choice counts from now"), !!(await until(`${lasts} === "Ends in 30 days"`)), await ev(lasts));
      check(M("the row keeps its place when the time changes"), JSON.stringify(before) === JSON.stringify(await ev(rect)));
      await shot(`link-files-row-${width}-${theme}`);
      await ev('window.pobotsMockConnection("ended")');
      check(M("an ended connection says so and offers only Remove"), !!(await until('document.querySelector(".pb-link-row[data-state=ended] [data-show]")?.textContent === "Ended" && [...document.querySelectorAll(".pb-link-row button")].map(b => b.textContent).join() === "Remove"')));
      check(M("an ended row says how to connect again"), (await ev(lasts)) === "To connect again, pair with new codes");
      check(M("nothing sideways in Connections"), await ev(fits));
      await shot(`link-files-ended-${width}-${theme}`);
      await ev('[...document.querySelectorAll(".pb-link-row button")].find(b => b.textContent === "Remove").click()');
      await until('!!document.querySelector("[role=alertdialog]")');
      await click('.pb-link-form [type="submit"]');
      check(M("an ended connection can be removed"), !!(await until('!document.querySelector(".pb-link-row")')));

      // Files from another Pobots, under its message in the main chat.
      await open("", { width, height, theme });
      await openMain();
      await ev('window.pobotsMockConnectionFiles("Here are the notes", [{ name: "meeting-notes-for-the-whole-autumn-planning-week.md", size: 2048 }, { name: "plan.pdf", size: 812000 }])');
      const files = '[...document.querySelectorAll(".pb-msg-connection")].at(-1)?.querySelectorAll(".pb-msg-file")';
      check(M("files show under the outside message"), !!(await until(`${files}?.length === 2`)));
      check(M("the files name themselves"), await ev(`[...${files}].map(f => f.textContent).join(" ").includes("plan.pdf")`));
      check(M("the files sit on the left with the message"), await ev(`(() => { const m = [...document.querySelectorAll(".pb-msg-connection")].at(-1); const f = m.querySelector(".pb-msg-file").getBoundingClientRect(); return f.left - m.getBoundingClientRect().left < innerWidth / 2 && f.right <= innerWidth; })()`));
      check(M("a long file name ends inside its chip"), await ev(`[...${files}].every(f => { const n = f.querySelector(".pb-chip-name"); return n.getBoundingClientRect().right <= f.getBoundingClientRect().right + 0.5 && n.getBoundingClientRect().right <= innerWidth; })`));
      check(M("nothing sideways in the chat"), await ev(fits));
      await shot(`link-files-message-${width}-${theme}`);
    }
  }
}
