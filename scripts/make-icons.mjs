// Makes ui/icons/icon-192.png and icon-512.png from the SVG face in scripts/icon.mjs, with headless
// Chromium, and the phone's home screen icons: apple-touch-icon.png (180 px) and
// icon-maskable-512.png, the face on the dark ground with no see-through part; and badge-96.png, the
// shape Android draws in its status bar beside a notification (job 4).
// Run after changing the face or the colour tokens: node scripts/make-icons.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";
import { BADGE_ICON, badgeSvg, iconOnGroundSvg, iconSvg, PHONE_ICONS } from "./icon.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "ui", "icons");
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "pobots-icons-"));

const browser = await launch({ profile, width: 600, height: 600 });
try {
  await browser.cmd("Page.enable");
  await browser.cmd("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const icons = [
    ...[192, 512].map((size) => ({ file: `icon-${size}.png`, size, svg: iconSvg(size) })),
    ...PHONE_ICONS.map((i) => ({ file: i.file, size: i.size, svg: iconOnGroundSvg(i.size, i.share) })),
    { file: BADGE_ICON.file, size: BADGE_ICON.size, svg: badgeSvg(BADGE_ICON.size) },
  ];
  for (const { file, size, svg } of icons) {
    const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`;
    await browser.cmd("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
    await browser.until(`document.readyState === "complete" && !!document.querySelector("svg")`, 5000, 50);
    const shot = await browser.cmd("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
    writeFileSync(join(out, file), Buffer.from(shot.result.data, "base64"));
    console.log(`Made ui/icons/${file}`);
  }
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
