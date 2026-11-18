// A stand-in for the bots' browser, for the model-free tests (docs/build/step-2g.md, A7).
//
// It runs the engine's real helper script (engine/browser-script.ts) in this process against a fake
// of the ego-browser API, so the script's own logic, the local link and the hub are all tested
// without the real browser. The only change to the script is its first import: `node:net` is wrapped
// so a test can make a helper "die" (its link closes, as when the real one ends).
import * as realNet from "node:net";
import type { Socket } from "node:net";
import type { BrowserDriver, HelperChild } from "../browser.js";

export interface FakeTab {
  targetId: string;
  label?: string;
  title: string;
  url: string;
  active: boolean;
  /** Goes up when the page changes; a picture shows it. */
  frame: number;
  w: number;
  h: number;
  dialog?: { type: string; message: string; defaultPrompt?: string };
  selection?: string;
  editable?: boolean;
  typed: string;
  /** Extra bytes in each picture, to stand for a real one's size. */
  pad?: number;
  /** Extra bytes in a sharp PNG picture only (a page full of photos). */
  pngPad?: number;
  /** A drop-down list on the page: its box, its options, the chosen one, and what the page heard. */
  select?: FakeSelect;
}

export interface FakeSelect {
  x: number;
  y: number;
  w: number;
  h: number;
  options: { label: string; disabled?: boolean; group?: string }[];
  index: number;
  focused: boolean;
  /** Events the page heard, in order ("input", "change"). */
  heard: string[];
}

export interface FakeSpace {
  id: number;
  name: string;
  ownership: "user" | "agent" | "agentDelegatedToUser";
  tabs: FakeTab[];
}

export interface CdpCall {
  space: number;
  page: string;
  method: string;
  params: Record<string, unknown>;
}

interface Running {
  role: string;
  spaceId?: number;
  sockets: Socket[];
  done: boolean;
}

const AsyncFunction = (async () => undefined).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

export class FakeBrowser {
  installed = true;
  running = true;
  /** When true, a started helper never connects (the browser cannot be reached). */
  unreachable = false;
  spaces: FakeSpace[] = [];
  calls: CdpCall[] = [];
  /** Every `taskSpace(...)` the scripts made, by id or name. */
  attached: (number | string)[] = [];
  spawns = 0;
  scripts: string[] = [];
  runs: Running[] = [];
  private nextId = 10;
  private nextTarget = 1;

  constructor() {
    // The person's everyday window, and one of their own: never listed, watched or touched.
    this.spaces.push({ id: 0, name: "", ownership: "user", tabs: [this.tab("Private mail", "https://mail.example.com/", "p1")] });
    this.spaces.push({ id: 3, name: "My research", ownership: "user", tabs: [this.tab("Private notes", "https://notes.example.com/", "p1")] });
  }

  tab(title: string, url: string, label?: string, active = true): FakeTab {
    return { targetId: `T${this.nextTarget++}`, ...(label ? { label } : {}), title, url, active, frame: 1, w: 1000, h: 700, typed: "" };
  }

  /** A workspace made by someone (a bot's script, or another program's agent). */
  addSpace(name: string, ownership: FakeSpace["ownership"] = "agent", tabs?: FakeTab[]): FakeSpace {
    const s: FakeSpace = { id: this.nextId++, name, ownership, tabs: tabs ?? [this.tab("New Tab", "about:blank", "p1")] };
    this.spaces.push(s);
    return s;
  }

  space(id: number): FakeSpace | undefined {
    return this.spaces.find((s) => s.id === id);
  }

  close(id: number): void {
    this.spaces = this.spaces.filter((s) => s.id !== id);
  }

  /** A bot's page moves somewhere. */
  navigate(spaceId: number, url: string, title: string, targetId?: string): void {
    const s = this.space(spaceId)!;
    const t = targetId ? s.tabs.find((x) => x.targetId === targetId)! : s.tabs.find((x) => x.active)!;
    t.url = url;
    t.title = title;
    t.frame++;
  }

  /** A new page opens in front. */
  openPage(spaceId: number, title: string, url: string, label?: string): FakeTab {
    const s = this.space(spaceId)!;
    for (const t of s.tabs) t.active = false;
    const t = this.tab(title, url, label ?? `p${s.tabs.length + 1}`, true);
    s.tabs.push(t);
    return t;
  }

  closePage(spaceId: number, targetId: string): void {
    const s = this.space(spaceId)!;
    const wasActive = s.tabs.find((t) => t.targetId === targetId)?.active;
    s.tabs = s.tabs.filter((t) => t.targetId !== targetId);
    if (wasActive && s.tabs[0]) s.tabs[0].active = true;
  }

  /** Makes every live helper of a role end, as when the real script dies. */
  kill(role: string, spaceId?: number): number {
    let n = 0;
    for (const r of this.runs) {
      if (r.done || r.role !== role || (spaceId !== undefined && r.spaceId !== spaceId)) continue;
      for (const s of r.sockets) s.destroy();
      n++;
    }
    return n;
  }

  live(role?: string): Running[] {
    return this.runs.filter((r) => !r.done && (!role || r.role === role));
  }

  driver(): BrowserDriver {
    return {
      problem: () => (this.installed ? undefined : "The browser the bots use is not installed on this computer."),
      running: async () => this.running,
      spawn: (script) => this.spawn(script),
    };
  }

  private spawn(script: string): HelperChild {
    this.spawns++;
    this.scripts.push(script);
    const exits: ((code: number | null) => void)[] = [];
    const child: HelperChild = { kill: () => undefined, onExit: (cb) => exits.push(cb) };
    if (this.unreachable || !this.installed) {
      setTimeout(() => exits.forEach((cb) => cb(1)), 5);
      return child;
    }
    this.running = true;
    const config = JSON.parse(script.slice("const CONFIG = ".length, script.indexOf(";\n"))) as { role: string; spaceId?: number };
    const run: Running = { role: config.role, ...(config.spaceId !== undefined ? { spaceId: config.spaceId } : {}), sockets: [], done: false };
    this.runs.push(run);
    const net = {
      createConnection: (opts: realNet.NetConnectOpts) => {
        const s = realNet.createConnection(opts);
        run.sockets.push(s);
        return s;
      },
    };
    const body = script.replace('const net = await import("node:net");', "const net = __net;");
    if (body === script) throw new Error("the helper script no longer starts with the net import the fake replaces");
    const fn = new AsyncFunction("__net", "listTaskSpaces", "taskSpace", "takeOverTaskSpace", "claimTaskSpace", body);
    void fn(net, this.listTaskSpaces, this.taskSpace, this.forbidden, this.forbidden)
      .catch(() => undefined)
      .finally(() => {
        run.done = true;
        exits.forEach((cb) => cb(0));
      });
    return child;
  }

  // ------------------------------------------------------------ the fake API the scripts see

  private forbidden = async (): Promise<never> => {
    throw new Error("a helper must never take over or claim a workspace");
  };

  private listTaskSpaces = async () =>
    this.spaces.map((s) => ({
      id: s.id,
      name: s.name,
      ownership: s.ownership,
      createdBy: s.ownership === "user" ? "user" : "agent",
      taskId: `task-${s.id}`,
      profileId: "default",
      profileName: "Default",
      recentTabTitles: [...s.tabs].sort((a, b) => Number(b.active) - Number(a.active)).map((t) => t.title),
    }));

  private taskSpace = async (ref: number | string) => {
    this.attached.push(ref);
    let s: FakeSpace | undefined;
    if (typeof ref === "number") {
      s = this.space(ref);
      if (!s) throw new Error("no such space");
    } else {
      s = this.spaces.find((x) => x.name === ref && x.ownership === "agent");
      if (!s) {
        if (this.spaces.some((x) => x.name === ref)) throw Object.assign(new Error("EGO_TASK_SPACE_NAME_IN_USE"), { code: "EGO_TASK_SPACE_NAME_IN_USE" });
        s = this.addSpace(ref);
      }
    }
    if (s.ownership === "agentDelegatedToUser") throw new Error("Control of this task space is with the user. This is a hard stop.");
    if (s.ownership === "user") throw new Error("user-owned");
    return this.taskOf(s);
  };

  private taskOf(s: FakeSpace) {
    const fb = this;
    const alive = () => {
      const now = fb.space(s.id);
      if (!now) throw new Error("task space closed");
      if (now.ownership === "agentDelegatedToUser") throw new Error("Control of this task space is with the user. This is a hard stop.");
      return now;
    };
    return {
      spaceId: s.id,
      name: s.name,
      ownership: s.ownership,
      tabs: async () => alive().tabs.map((t) => ({ label: t.label, targetId: t.targetId, title: t.title, url: t.url, active: t.active, openedBy: "agent", page: fb.pageOf(s.id, t.targetId) })),
      page: (label: string) => {
        const t = alive().tabs.find((x) => x.label === label);
        return fb.pageOf(s.id, t ? t.targetId : `missing-${label}`);
      },
      finish: async () => {
        fb.close(s.id);
        return { spaceId: s.id, closedSpace: true };
      },
      cdp: async (method: string, params: Record<string, unknown> = {}) => {
        fb.calls.push({ space: s.id, page: "", method, params });
        if (method === "Target.closeTarget") fb.closePage(s.id, String(params.targetId));
        if (method === "Target.activateTarget") {
          const now = alive();
          if (now.tabs.some((t) => t.targetId === params.targetId)) for (const t of now.tabs) t.active = t.targetId === params.targetId;
        }
        return {};
      },
      // As the real one: a blank page, not brought to the front by itself.
      newPage: async () => {
        const now = alive();
        const used = new Set(now.tabs.map((t) => t.label));
        let n = 1;
        while (used.has(`p${n}`)) n++;
        const t = fb.tab("New Tab", "chrome://newtab/", `p${n}`, false);
        now.tabs.push(t);
        fb.calls.push({ space: s.id, page: t.targetId, method: "newPage", params: {} });
        return fb.pageOf(s.id, t.targetId, t.label);
      },
    };
  }

  private pageOf(spaceId: number, targetId: string, label?: string) {
    const fb = this;
    const tabNow = () => {
      const s = fb.space(spaceId);
      if (!s) throw new Error("task space closed");
      if (s.ownership === "agentDelegatedToUser") throw new Error("Control of this task space is with the user. This is a hard stop.");
      const t = s.tabs.find((x) => x.targetId === targetId);
      if (!t) throw new Error("page closed");
      return t;
    };
    return {
      targetId,
      label,
      close: async () => {
        tabNow();
        fb.calls.push({ space: spaceId, page: targetId, method: "close", params: {} });
        fb.closePage(spaceId, targetId);
      },
      goto: async (url: string) => {
        const t = tabNow();
        fb.calls.push({ space: spaceId, page: targetId, method: "goto", params: { url } });
        t.url = url;
        t.title = `Page at ${new URL(url).host}`;
        t.frame++;
      },
      info: async () => {
        const t = tabNow();
        return { url: t.url, title: t.title, ...(t.dialog ? { dialog: t.dialog } : {}) };
      },
      evaluate: async (fn: unknown, arg?: unknown) => {
        const t = tabNow();
        const name = typeof fn === "function" ? fn.name : "";
        if (name === "selectionText") return t.selection ?? "";
        if (name === "focusEditable") return t.editable ?? false;
        const sel = t.select;
        const choicesOf = (s: FakeSelect) => ({
          path: [0],
          box: { x: s.x, y: s.y, width: s.w, height: s.h },
          options: s.options.map((o, i) => ({ label: o.label, selected: i === s.index, disabled: !!o.disabled, ...(o.group ? { group: o.group } : {}) })),
        });
        if (name === "dropDownAt") {
          const a = arg as { x?: number; y?: number; focused?: boolean };
          if (!sel) return null;
          if (a.focused) return sel.focused ? choicesOf(sel) : null;
          const x = Number(a.x);
          const y = Number(a.y);
          if (x < sel.x || y < sel.y || x >= sel.x + sel.w || y >= sel.y + sel.h) return null;
          sel.focused = true;
          return choicesOf(sel);
        }
        if (name === "chooseOption") {
          const a = arg as { index: number };
          const o = sel?.options[a.index];
          if (!sel || !o || o.disabled) return false;
          if (sel.index !== a.index) {
            sel.index = a.index;
            sel.heard.push("input", "change");
            t.frame++;
          }
          return true;
        }
        return undefined;
      },
      cdp: async (method: string, params: Record<string, unknown> = {}) => {
        const t = tabNow();
        if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: t.w, clientHeight: t.h } };
        if (method === "Page.captureScreenshot") {
          if (t.dialog) throw new Error(`Page.captureScreenshot cannot run while a JavaScript ${t.dialog.type} dialog is open`);
          fb.calls.push({ space: spaceId, page: targetId, method, params });
          const format = String(params.format ?? "jpeg");
          const scale = (params.clip as { scale?: number } | undefined)?.scale ?? 1;
          // A JPEG while the page changes; a sharp PNG or WebP once it stands still, at its scale.
          if (format !== "jpeg") return { data: Buffer.from(`${format} ${spaceId} ${targetId} ${t.frame} ${scale}${format === "png" && t.pngPad ? " " + "x".repeat(t.pngPad) : ""}`).toString("base64") };
          return { data: Buffer.from(`jpeg ${spaceId} ${targetId} ${t.frame}${scale !== 1 && scale !== Math.min(1, 1600 / t.w, 1200 / t.h) ? ` ${scale}` : ""}${t.pad ? " " + "x".repeat(t.pad) : ""}`).toString("base64") };
        }
        fb.calls.push({ space: spaceId, page: targetId, method, params });
        if (method === "Input.insertText") {
          t.typed += String(params.text);
          t.frame++;
        } else if (method === "Input.dispatchMouseEvent" || method === "Input.dispatchKeyEvent") t.frame++;
        else if (method === "Page.handleJavaScriptDialog") {
          t.dialog = undefined;
          t.frame++;
        } else if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [{ id: 1, url: "https://example.org/" }, { id: 2, url: t.url }, { id: 3, url: "https://example.net/" }] };
        else if (method === "Page.navigateToHistoryEntry") {
          t.url = params.entryId === 1 ? "https://example.org/" : "https://example.net/";
          t.frame++;
        }
        return {};
      },
    };
  }

  /** Pictures sent so far for one page (from the fake's own screenshot log). */
  shots(targetId: string): number {
    return this.calls.filter((c) => c.page === targetId && c.method === "Page.captureScreenshot").length;
  }

  inputs(targetId: string): CdpCall[] {
    return this.calls.filter((c) => c.page === targetId && (c.method.startsWith("Input.") || c.method === "Page.handleJavaScriptDialog" || c.method === "goto" || c.method.startsWith("Page.navigate") || c.method === "Page.reload"));
  }
}

/** Waits until `ok()` is true, checking every 10 ms, at most `ms`. */
export async function until(ok: () => boolean, ms = 4000, what = "a condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The picture data the fake draws for a page at a given change count. */
export function fakeFrame(spaceId: number, targetId: string, frame: number): string {
  return Buffer.from(`jpeg ${spaceId} ${targetId} ${frame}`).toString("base64");
}
