import { check, ev, open, shot, until } from "../lib.mjs";

const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
const fill = (sel, text) => ev(`(() => {
  const input = document.querySelector(${JSON.stringify(sel)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,${JSON.stringify(text)});
  input.dispatchEvent(new Event("input",{ bubbles:true }));
})()`);
const go = async dimensions => {
  await open("publicBase=0", dimensions);
  await click(".pb-foot-settings");
  await until('!!document.querySelector("#setwin-tab-connections")');
  await click("#setwin-tab-connections");
  await until('!!document.querySelector(".pb-links")');
};
const row = ".pb-link-row";

export default async function section() {
  for (const [width, height] of [[1280, 820], [390, 844], [360, 780]]) {
    for (const theme of ["light", "dark"]) {
      const where = `${width} ${theme}`;
      await go({ width, height, theme });
      check(`connections: no public address note fits at ${where}`, await ev('document.querySelector(".pb-links").innerText.includes("when the other Pobots has one") && document.documentElement.scrollWidth <= innerWidth'));
      await click(".pb-links > .pb-link-actions button");
      await until('!!document.querySelector(".pb-link-form input")');
      await fill(".pb-link-form input", "Sam");
      await click('.pb-link-form [type="submit"]');
      check(`connections: shows both code fields at ${where}`, !!(await until('document.querySelectorAll(".pb-link-form input").length === 2')));
      await fill(".pb-link-form label:last-of-type input:not([readonly])", "a cut-off code");
      await click('.pb-link-form [type="submit"]');
      check(`connections: a typo leaves the dialog open at ${where}`, !!(await until('document.querySelector(".pb-link-form [role=alert]")?.textContent.includes("typo")')));
      await fill(".pb-link-form label:last-of-type input:not([readonly])", "pobots-link-1.example-peer-public-code");
      await click('.pb-link-form [type="submit"]');
      check(`connections: waiting for the other side at ${where}`, !!(await until('document.querySelector(".pb-link-row[data-state=waiting] [data-show]")?.textContent.includes("Waiting for Sam")')));
      const rect = '(() => { const r = document.querySelector(".pb-link-row").getBoundingClientRect(); return [r.y,r.height]; })()';
      const waiting = await ev(rect);
      await ev('window.pobotsMockConnection("connected")');
      await until('!!document.querySelector(".pb-link-row[data-state=connected]")');
      check(`connections: pairing keeps the row in place at ${where}`, JSON.stringify(waiting) === JSON.stringify(await ev(rect)));
      await shot(`connections-${width}-${theme}`);
      await click(`${row} button:first-child`);
      check(`connections: pause at ${where}`, !!(await until('!!document.querySelector(".pb-link-row[data-state=paused]")')));
      await click(`${row} button:first-child`);
      check(`connections: resume at ${where}`, !!(await until('!!document.querySelector(".pb-link-row[data-state=connected]")')));
      await ev('window.pobotsMockConnection("unreached")');
      check(`connections: unreachable shows last contact at ${where}`, !!(await until('document.querySelector(".pb-link-row[data-state=unreached] [data-show]")?.textContent.includes("Not reached since")')));
      await click(`${row} button:nth-child(2)`);
      await until('!!document.querySelector(".pb-link-form input")');
      await fill(".pb-link-form input", "Kim");
      await click('.pb-link-form [type="submit"]');
      check(`connections: rename at ${where}`, !!(await until('document.querySelector(".pb-link-row h3")?.textContent === "Kim"')));
      await click(`${row} button:last-child`);
      check(`connections: asks before removal at ${where}`, !!(await until('document.querySelector("[role=alertdialog]")?.textContent.includes("Remove Kim?")')));
      await click('.pb-link-form [type="submit"]');
      check(`connections: removes the row at ${where}`, !!(await until('!document.querySelector(".pb-link-row")')));
    }
  }
}
