// Builds into dist/.
//   dist/engine/main.mjs    the engine (Node, ESM). Dependencies stay in node_modules.
//   dist/engine/upload-state.js   the backup's upload state reader (JavaScript for Automation), run by the engine with osascript
//   dist/engine/guides/     the setup guides for the Power Automate flows (docs/guides/), read by the bots
//   dist/desktop/main.cjs   the Electron main process
//   dist/desktop/preload.cjs
//   dist/ui/                the app window: index.html, app.js, app.css, tokens.css, bundle.css, fonts,
//                           and the web manifest and icons for the page the engine serves (also the
//                           phone's home screen icons: apple-touch-icon.png and icon-maskable-512.png,
//                           and the badge for Android's status bar, badge-96.png)
//   dist/ui/sw.js           the service worker for notifications when the page is not open (ui/sw.ts)
//
// Run: node scripts/build.mjs                 everything
//      node scripts/build.mjs engine          only that part (engine | desktop | ui), leaving the others alone
// POBOTS_BUILD_OUT=PATH builds into PATH instead of dist/: a public install's self-update builds the
// new version beside the running one (engine/self-update.ts).
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BADGE_ICON, groundDark, groundLight, iconSvg, manifest, PHONE_ICONS } from "./icon.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = process.env.POBOTS_BUILD_OUT ? resolve(process.env.POBOTS_BUILD_OUT) : join(root, "dist");
const at = (...parts) => join(root, ...parts);

const all = ["engine", "desktop", "ui"];
const wanted = process.argv.slice(2);
const targets = wanted.length ? wanted : all;
for (const t of targets) {
  if (!all.includes(t)) {
    console.error(`Unknown build target "${t}". Use: ${all.join(", ")}`);
    process.exit(1);
  }
}

const common = { bundle: true, sourcemap: true, logLevel: "info", absWorkingDir: root };

const builders = {
  async engine() {
    rmSync(join(dist, "engine"), { recursive: true, force: true });
    await build({
      ...common,
      entryPoints: [at("engine", "main.ts")],
      outfile: join(dist, "engine", "main.mjs"),
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
    });
    await build({
      ...common,
      entryPoints: [at("engine", "core", "usage-history", "worker.ts")],
      outfile: join(dist, "engine", "usage-history-worker.mjs"),
      platform: "node",
      format: "esm",
      target: "node22",
    });
    // Not bundled: the engine runs it with osascript (engine/core/backup-restic.ts). It ships beside main.mjs, so
    // the service's copy on the internal drive has it too.
    cpSync(at("engine", "upload-state.js"), join(dist, "engine", "upload-state.js"));
    // The setup guides for the Power Automate flows (docs/guides/, engine/core/guides.ts): the bots read them
    // offline, and the service's copy holds only dist/, so they ship beside main.mjs.
    cpSync(at("docs", "guides"), join(dist, "engine", "guides"), { recursive: true });
  },

  async desktop() {
    rmSync(join(dist, "desktop"), { recursive: true, force: true });
    await build({
      ...common,
      entryPoints: [at("desktop", "main.ts")],
      outfile: join(dist, "desktop", "main.cjs"),
      platform: "node",
      format: "cjs",
      target: "node22",
      packages: "external",
    });
    await build({
      ...common,
      entryPoints: [at("desktop", "preload.ts")],
      outfile: join(dist, "desktop", "preload.cjs"),
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
    });
  },

  async ui() {
    rmSync(join(dist, "ui"), { recursive: true, force: true });
    mkdirSync(join(dist, "ui"), { recursive: true });
    // The design system is the source of the app's tokens and component styles.
    const ds = spawnSync(process.execPath, [at("design-system", "build.mjs")], { stdio: "inherit" });
    if (ds.status !== 0) process.exit(ds.status ?? 1);
    // Safari 16 too, so a phone's Safari can run everything that is left in (the phone layout).
    const browserTargets = ["chrome130", "safari16"];
    await build({
      ...common,
      entryPoints: [at("ui", "main.tsx")],
      outfile: join(dist, "ui", "app.js"),
      platform: "browser",
      format: "iife",
      target: browserTargets,
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".woff2": "file", ".woff": "file" },
      assetNames: "fonts/[name]",
    });
    // The service worker: a classic script at the app's root, so its scope is the whole page. It only
    // shows notifications; it never handles the page's requests (ui/sw.ts).
    await build({
      ...common,
      entryPoints: [at("ui", "sw.ts")],
      outfile: join(dist, "ui", "sw.js"),
      platform: "browser",
      format: "iife",
      target: browserTargets,
    });
    writeFileSync(join(dist, "ui", "index.html"), readFileSync(at("ui", "index.html"), "utf8").replaceAll("{{ground-dark}}", groundDark).replaceAll("{{ground-light}}", groundLight));
    writeFileSync(join(dist, "ui", "manifest.webmanifest"), manifest());
    writeFileSync(join(dist, "ui", "icon.svg"), iconSvg());
    for (const size of [192, 512]) cpSync(at("ui", "icons", `icon-${size}.png`), join(dist, "ui", `icon-${size}.png`));
    for (const { file } of PHONE_ICONS) cpSync(at("ui", "icons", file), join(dist, "ui", file));
    cpSync(at("ui", "icons", BADGE_ICON.file), join(dist, "ui", BADGE_ICON.file));
    cpSync(at("design-system", "dist", "tokens.css"), join(dist, "ui", "tokens.css"));
    cpSync(at("design-system", "dist", "bundle.css"), join(dist, "ui", "bundle.css"));
  },
};

for (const t of targets) await builders[t]();
console.log(`Built ${targets.join(", ")} into ${process.env.POBOTS_BUILD_OUT ? dist : "dist/"}`);
