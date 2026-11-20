// Protocol 35: a connection belongs to a bot. The choice when pairing and in Edit, the "Belongs to"
// line on the row (and its vacation words), and the outside message in the owner's chat saying whose
// connection it came on. Laptop and both phones, light and dark.
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
const owner = 'document.querySelector(".pb-link-row .pb-link-owner")?.textContent';
const rect = '(() => { const r = document.querySelector(".pb-link-row").getBoundingClientRect(); return [Math.round(r.y), Math.round(r.height)]; })()';
const fits = "document.documentElement.scrollWidth <= innerWidth";
const edit = async () => {
  await ev('[...document.querySelectorAll(".pb-link-row button")].find(b => b.textContent === "Edit").click()');
  await until('!!document.querySelector("#edit-owner")');
};

async function openChat(name) {
  const phone = await ev('!!document.querySelector(".app-shell")?.dataset.phoneScreen');
  if (!phone) return goTo(name, "chat");
  for (let i = 0; i < 6 && !(await ev('[...document.querySelectorAll(".app-row")].some((r) => r.checkVisibility())')); i++) {
    await ev("(history.back(), true)");
    await sleep(250);
  }
  await ev(`[...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name").textContent === ${JSON.stringify(name)}).click()`);
  return until(`document.querySelector(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)}`);
}

export default async function section() {
  for (const [width, height] of [[1280, 820], [390, 844], [360, 780]]) {
    for (const theme of ["light", "dark"]) {
      const where = `${width} ${theme}`;
      const M = name => `link-owner: ${name} at ${where}`;
      await settings({ width, height, theme });
      check(M("the section says each connection belongs to one bot"), await ev('document.querySelector(".pb-links .pb-section-text").textContent.includes("belongs to one of your bots")'));
      await click(".pb-links > .pb-link-actions button");
      await until('!!document.querySelector("#pair-owner")');
      check(M("Belongs to lists the bots, the main bot first and chosen"),
        await ev('(() => { const s = document.querySelector("#pair-owner"); return s.options[0].textContent === "Kaja" && s.value === "kaja" && [...s.options].some(o => o.value === "inbox"); })()'));
      check(M("the pairing sheet fits"), await ev(fits));
      await shot(`link-owner-pair-${width}-${theme}`);
      await fill(".pb-link-form input", "Ted");
      await choose("#pair-owner", "inbox");
      await click('.pb-link-form [type="submit"]');
      await until('document.querySelectorAll(".pb-link-form input").length === 2');
      await fill(".pb-link-form label:last-of-type input:not([readonly])", "pobots-link-1.example-peer-public-code");
      await click('.pb-link-form [type="submit"]');
      await until('!!document.querySelector(".pb-link-row") && !document.querySelector(".pb-link-form")');
      check(M("the row says which bot it belongs to"), !!(await until(`${owner} === "Belongs to Inbox"`)), await ev(owner));
      check(M("the row shows that bot's face"), await ev('!!document.querySelector(".pb-link-row .pb-link-owner .pb-avatar")'));
      const before = await ev(rect);
      await ev('window.pobotsMockConnection("connected")');
      await until('!!document.querySelector(".pb-link-row[data-state=connected]")');

      await edit();
      check(M("Edit shows the owner"), await ev('document.querySelector("#edit-owner").value === "inbox"'));
      check(M("the Edit sheet fits"), await ev(fits));
      await shot(`link-owner-edit-${width}-${theme}`);
      await choose("#edit-owner", "kaja");
      await click('.pb-link-form [type="submit"]');
      check(M("a new owner shows on the row"), !!(await until(`${owner} === "Belongs to Kaja"`)), await ev(owner));
      check(M("the row keeps its place when the owner changes"), JSON.stringify(before) === JSON.stringify(await ev(rect)));
      await edit();
      await choose("#edit-owner", "inbox");
      await click('.pb-link-form [type="submit"]');
      await until(`${owner} === "Belongs to Inbox"`);

      await ev('window.pobotsMock.vacation("inbox", true)');
      check(M("while its bot is on vacation the row says messages wait"),
        !!(await until(`${owner} === "Belongs to Inbox, on vacation. Messages wait until it is back"`)), await ev(owner));
      check(M("nothing sideways with the vacation words"), await ev(fits));
      await shot(`link-owner-vacation-${width}-${theme}`);
      await ev('window.pobotsMock.vacation("inbox", false)');
      await until(`${owner} === "Belongs to Inbox"`);
      check(M("nothing sideways in Connections"), await ev(fits));
      await shot(`link-owner-row-${width}-${theme}`);

      // The message lands in Inbox's chat and says whose connection it came on.
      await ev('window.pobotsMockConnectionFiles("Could you send the packing list for Saturday?", [])');
      await openChat("Inbox");
      const from = '[...document.querySelectorAll(".pb-msg-connection")].at(-1)?.querySelector(".pb-msg-from")?.textContent';
      check(M("the outside message is in the owner's chat and says whose connection"), !!(await until(`${from} === "From another Pobots, on Inbox's connection"`)), await ev(from));
      check(M("the message head fits"), await ev(`(() => { const m = [...document.querySelectorAll(".pb-msg-connection")].at(-1); return m.getBoundingClientRect().right <= innerWidth + 0.5 && ${fits}; })()`));
      await shot(`link-owner-message-${width}-${theme}`);
      await openChat("Kaja");
      check(M("the main bot's chat does not get it"), !!(await until('!document.querySelector(".pb-msg-connection")')));
    }
  }
}
