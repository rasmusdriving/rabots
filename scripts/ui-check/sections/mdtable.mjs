// The window check, section "mdtable". Run it alone: node scripts/ui-check.mjs --only=mdtable
// A table in a bot's answer never breaks a word letter by letter: in 0.21.0 the first column of a table
// was squeezed to two letters a line ("Bo / t", "Inb / ox", "TI / M"), because the message's
// overflow-wrap anywhere let the table shrink a column to single letters (fix 0.21.1). A table wider
// than the chat scrolls sideways in its own box; the page never does. The stand-in engine seeds the
// tables with &table=1 (ui/engine/mock-tables.ts).
import { check, ev, until, open, shot, goTo, houseRules } from "../lib.mjs";

export default async function section() {
  const M = (name) => `mdtable: ${name}`;
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1280, 820],
      [390, 844],
      [360, 780],
    ]) {
      const T = (n) => M(`${theme}, ${width} px: ${n}`);
      await open("table=1", { width, height, theme });
      await goTo("Kaja", "chat");
      const ready = await until(`$$(".app-main .app-md-table").length === 2`);
      check(T("both tables are drawn, each in a box of its own"), ready === true);
      const look = await ev(`(() => {
        const [first, second] = $$(".app-main .app-md-table");
        first.scrollIntoView({ block: "center" });
        // Every word in the first table (between spaces, commas and hyphens) stands on one line.
        const broken = [];
        for (const cell of first.querySelectorAll("th, td")) {
          const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const re = /[^\\s,\\-]+/g;
            let m;
            while ((m = re.exec(n.data))) {
              const r = document.createRange();
              r.setStart(n, m.index);
              r.setEnd(n, m.index + m[0].length);
              const tops = new Set([...r.getClientRects()].map((x) => Math.round(x.top)));
              if (tops.size > 1) broken.push(m[0]);
            }
          }
        }
        const body = first.closest(".pb-msg-body").getBoundingClientRect();
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, scrolls: el.scrollWidth > el.clientWidth + 1, overflowX: getComputedStyle(el).overflowX }; };
        const p = $$(".app-main .pb-msg-body p").find((x) => x.closest(".pb-msg-body") === first.closest(".pb-msg-body"));
        return {
          broken,
          firstCol: first.querySelector("tbody td").getBoundingClientRect().width,
          inbox: (() => { const r = document.createRange(); const td = first.querySelector("tbody td"); r.selectNodeContents(td); return r.getBoundingClientRect().width; })(),
          body: { left: body.left, right: body.right },
          first: box(first),
          second: box(second),
          pageWide: document.scrollingElement.scrollWidth - innerWidth,
          prose: p ? getComputedStyle(p).overflowWrap : null,
          cellWrap: getComputedStyle(first.querySelector("td")).overflowWrap,
        };
      })()`);
      check(T("no word in the table is broken across lines"), !!look && look.broken.length === 0, look?.broken);
      check(T("the first column is at least as wide as its words (Inbox on one line)"), !!look && look.firstCol >= look.inbox, look && { firstCol: look.firstCol, inbox: look.inbox });
      check(T("each table's box stays inside the message and scrolls sideways when the table is wider"), !!look && [look.first, look.second].every((x) => x.left >= look.body.left - 0.5 && x.right <= look.body.right + 0.5 && x.overflowX === "auto"), look);
      check(T("the page itself never scrolls sideways"), !!look && look.pageWide <= 0, look?.pageWide);
      check(T("other text in a message still wraps a long word anywhere; table cells wrap between words"), !!look && look.prose === "anywhere" && look.cellWrap === "break-word", look && { prose: look.prose, cell: look.cellWrap });
      if (width === 390) check(T("at phone width the address table is wider than its box and scrolls in it"), !!look && look.second.scrolls === true, look?.second);
      await houseRules(`mdtable, ${theme}, ${width} px`);
      await shot(`mdtable-${theme}-${width}`);
    }
  }
}
