// A disappearing row must never be removed and reinserted, even within one paint.
import { b, check, ev, open, until } from "../lib.mjs";

const notes = '$$(".app-card-slot:has(.pb-card-note)")';

export default async function section() {
  await open("", { theme: "light" });
  await ev(`[1, 2, 3].forEach(() => window.pobotsMock.addCard())`);
  await until(`${notes}.length >= 4`);
  const fade = await ev(`(async () => {
    const [a, b, next] = ${notes}.slice(-3);
    const rail = a.parentNode;
    const top = () => next.offsetTop;
    const before = top();
    const removed = [];
    const changes = new MutationObserver((records) => {
      for (const r of records) removed.push(...r.removedNodes);
    });
    changes.observe(rail, { childList: true });
    a.querySelector("button").click();
    b.querySelector("button").click();
    for (let i = 0; i < 20 && !(a.dataset.leaving && b.dataset.leaving); i++) await new Promise(requestAnimationFrame);
    const intact = a.isConnected && b.isConnected && a.nextElementSibling === b &&
      b.nextElementSibling === next && !removed.includes(a) && !removed.includes(b);
    changes.disconnect();
    const animations = [a, b].flatMap((row) => row.getAnimations());
    const opacity = animations.find((animation) => animation.transitionProperty === "opacity");
    const duration = opacity?.effect.getTiming().duration;
    if (!duration) return { intact, transitions: animations.length };
    for (const animation of animations) { animation.pause(); animation.currentTime = duration / 2; }
    const midway = { opacity: Number(getComputedStyle(a).opacity), top: top(), inert: a.inert && b.inert };
    const layout = animations.find((animation) => animation.transitionProperty === "grid-template-rows");
    if (!layout) return { intact, midway };
    for (const animation of animations) animation.currentTime = duration + layout.effect.getTiming().duration / 2;
    const collapsing = top();
    animations.forEach((animation) => animation.finish());
    return { intact, before, midway, collapsing };
  })()`);
  check("rail fade: both departing rows keep their original nodes and order", fade?.intact, fade);
  check("rail fade: halfway through the fade the rows are inert and the next row has not moved",
    fade?.midway?.opacity > 0 && fade.midway.opacity < 1 && fade.midway.inert && fade.midway.top === fade.before, fade);
  const after = await until(`(() => {
    const next = ${notes}.at(-1);
    return ${notes}.length === 2 && next.offsetTop;
  })()`);
  check("rail fade: during collapse the next row is between its old and final positions; the departing rows are gone",
    after < fade?.collapsing && fade.collapsing < fade.before, { fade, after });

  await b.cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await open("");
    await until(`!!${notes}[0]`);
    const result = await ev(`(async () => {
      const row = ${notes}[0];
      row.querySelector("button").click();
      for (let i = 0; i < 30 && row.isConnected && !row.dataset.leaving; i++) await new Promise(requestAnimationFrame);
      return { gone: !row.isConnected, leaving: row.dataset.leaving, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches };
    })()`);
    check("rail fade: reduced motion removes the row without keeping an exit on screen", result?.gone && !result.leaving && result.reduced, result);
  } finally {
    await b.cmd("Emulation.setEmulatedMedia", { features: [] });
  }
}
