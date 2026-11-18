// The page's icon and web manifest, made from the design system's tokens so no colour is typed twice.
//
// The icon is a stand-in: the bot face from the design system (a `pebble` soft square with
// `radius-pebble` corners and two round `ink` eyes, sized as in bundle.css: eyes 0.15em, gap 0.2em),
// in the dark theme. The 192 and 512 px PNGs in ui/icons/ are made from this SVG by
// scripts/make-icons.mjs; run it again after changing the face or the tokens.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tokens = JSON.parse(readFileSync(join(root, "design-system", "project", "tokens.json"), "utf8"));

const color = (name, theme = "dark") => {
  const t = tokens.color.tokens.find((x) => x.name === name);
  if (!t) throw new Error(`No colour token "${name}"`);
  return typeof t.value === "string" ? t.value : t.value[theme];
};
const radius = (name) => tokens.radius.tokens.find((x) => x.name === name).value;

export const groundDark = color("ground", "dark");
export const groundLight = color("ground", "light");

/** The bot face as an SVG, `size` px square. */
export function iconSvg(size = 512) {
  const pct = parseFloat(radius("radius-pebble")) / 100;
  const r = (size * pct).toFixed(2);
  const eye = size * 0.15;
  const gap = size * 0.2;
  const cx1 = (size / 2 - gap / 2 - eye / 2).toFixed(2);
  const cx2 = (size / 2 + gap / 2 + eye / 2).toFixed(2);
  const cy = (size / 2).toFixed(2);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${color("pebble")}"/>`,
    `<circle cx="${cx1}" cy="${cy}" r="${(eye / 2).toFixed(2)}" fill="${color("ink")}"/>`,
    `<circle cx="${cx2}" cy="${cy}" r="${(eye / 2).toFixed(2)}" fill="${color("ink")}"/>`,
    `</svg>`,
    "",
  ].join("\n");
}

/**
 * The bot face on the dark ground, filling the whole square with no see-through part, the face
 * `share` of the side. For a phone's home screen, which rounds or masks the corners itself: the
 * Apple icon (180 px; iOS fills see-through parts with black) and the maskable icon (Android keeps
 * the middle circle, 80 % across, so the face must stay well inside it).
 */
export function iconOnGroundSvg(size, share) {
  const face = size * share;
  const at = ((size - face) / 2).toFixed(2);
  const inner = iconSvg(face)
    .replace(/<svg[^>]*>/, "")
    .replace("</svg>", "");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="${groundDark}"/>`,
    `<g transform="translate(${at} ${at})">${inner}</g>`,
    `</svg>`,
    "",
  ].join("\n");
}

/** The phone icons: file name, size and the face's share of the side. */
export const PHONE_ICONS = [
  { file: "apple-touch-icon.png", size: 180, share: 0.62 },
  { file: "icon-maskable-512.png", size: 512, share: 0.5 },
];

/**
 * The badge Android draws in its status bar beside a notification. Only its shape counts: Android
 * uses the picture's see-through parts as a mask. The pebble filled, the two eyes cut out of it (an
 * even-odd path), in one light token colour, `size` px square.
 */
export function badgeSvg(size = 96) {
  const pct = parseFloat(radius("radius-pebble")) / 100;
  const r = size * pct;
  const eye = (size * 0.15) / 2;
  const gap = size * 0.2;
  const cy = size / 2;
  const cx1 = size / 2 - gap / 2 - eye;
  const cx2 = size / 2 + gap / 2 + eye;
  const f = (n) => n.toFixed(2);
  const rect = `M${f(r)} 0H${f(size - r)}A${f(r)} ${f(r)} 0 0 1 ${size} ${f(r)}V${f(size - r)}A${f(r)} ${f(r)} 0 0 1 ${f(size - r)} ${size}H${f(r)}A${f(r)} ${f(r)} 0 0 1 0 ${f(size - r)}V${f(r)}A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0Z`;
  const circle = (cx) => `M${f(cx - eye)} ${f(cy)}A${f(eye)} ${f(eye)} 0 1 0 ${f(cx + eye)} ${f(cy)}A${f(eye)} ${f(eye)} 0 1 0 ${f(cx - eye)} ${f(cy)}Z`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<path fill-rule="evenodd" fill="${color("ink", "dark")}" d="${rect}${circle(cx1)}${circle(cx2)}"/>`,
    `</svg>`,
    "",
  ].join("\n");
}

/** The badge's file and size. */
export const BADGE_ICON = { file: "badge-96.png", size: 96 };

/** The web manifest, so the page can be installed as its own window from Edge or Chrome, or put on a phone's home screen. */
export function manifest() {
  return JSON.stringify(
    {
      name: "Pobots",
      short_name: "Pobots",
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: groundDark,
      background_color: groundDark,
      icons: [
        { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
        { src: "icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    null,
    2,
  );
}
