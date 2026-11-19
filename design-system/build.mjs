// Builds design-system/dist from design-system/project, with no dependencies.
//   dist/tokens.css          CSS variables for both themes, for the app to load
//   dist/preview/<Name>.<theme>.html  each component preview as a stand-alone page, for looking at locally
// Run: node design-system/build.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "project");
const out = join(here, "dist");
const tokens = JSON.parse(readFileSync(join(src, "tokens.json"), "utf8"));

const themes = tokens.color.themes.map((t) => t.id);
const first = themes[0];
const perTheme = (value, theme) => {
  const v = typeof value === "string" ? value : value[theme] ?? value[first];
  const alias = /^\{(.+)\}$/.exec(v);
  return alias ? `var(--${alias[1]})` : v;
};
const themed = [...tokens.color.tokens, ...(tokens.shadow?.tokens ?? [])];
const block = (theme) =>
  [...themed.map((t) => `  --${t.name}: ${perTheme(t.value, theme)};`), `  color-scheme: ${theme === "dark" ? "dark" : "light"};`].join("\n");

const plainFamilies = Object.entries(tokens).filter(
  ([key, family]) => !["color", "type", "shadow"].includes(key) && Array.isArray(family?.tokens),
);
const plain = plainFamilies.flatMap(([, family]) => family.tokens.map((t) => `  --${t.name}: ${t.value};`));
const fonts = Object.entries(tokens.type.families).map(([key, stack]) => `  --font-${key}: ${stack};`);

const px = (v) => (typeof v === "number" ? `${v}px` : v);
const styles = tokens.type.groups.flatMap((group) =>
  group.styles.map((s) => {
    const lines = [
      `font-family: var(--font-${s.family ?? group.family})`,
      `font-size: ${px(s.fontSize)}`,
      s.lineHeight !== undefined && `line-height: ${s.lineHeight}`,
      s.fontWeight !== undefined && `font-weight: ${s.fontWeight}`,
      s.letterSpacing !== undefined && `letter-spacing: ${s.letterSpacing}`,
    ].filter(Boolean);
    return `.${s.name} { ${lines.join("; ")}; }`;
  }),
);

const css = [
  `/* ${tokens.name} tokens. Generated from tokens.json by build.mjs. Do not edit. */`,
  `:root, [data-theme="${first}"] {\n${block(first)}\n}`,
  ...themes.slice(1).map((theme) => `[data-theme="${theme}"] {\n${block(theme)}\n}`),
  `:root {\n${[...plain, ...fonts].join("\n")}\n}`,
  ...styles,
  "",
].join("\n");

mkdirSync(join(out, "preview"), { recursive: true });
writeFileSync(join(out, "tokens.css"), css);

const components = join(src, "components");
const bundle = ["bundle.css", "PobotsUsage/usage.css", "PobotsConnections/connections.css"].map((file) => readFileSync(join(components, file), "utf8")).join("\n");
writeFileSync(join(out, "bundle.css"), bundle);
const names = readdirSync(join(src, "components"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(src, "components", entry.name, "preview.html")))
  .map((entry) => entry.name);

for (const name of names) {
  const html = readFileSync(join(src, "components", name, "preview.html"), "utf8");
  for (const theme of themes) {
    const page = html
      .replace(/<html([^>]*)>/, `<html$1 data-theme="${theme}">`)
      .replace("</head>", `<style>${css}</style>\n<style>${bundle}</style>\n</head>`);
    writeFileSync(join(out, "preview", `${name}.${theme}.html`), page);
  }
}
console.log(`tokens.css and ${names.length} previews x ${themes.length} themes written to ${out}`);
