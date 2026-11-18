// What the bots' own Pobots tools cost on every step, measured the way docs/build/speed-result.md
// measured a session: Claude Code is started with the tools of a main bot (or another bot) and asked
// for its own breakdown (getContextUsage). No message is sent, so no model is called, and nothing is
// saved (persistSession false). The session runs in a temporary folder with none of the person's own
// settings, skills, plugins or services (settingSources empty), so the number is Pobots' alone.
//
//   node scripts/dev/tool-cost.mjs            main bot and another bot, on Claude
//   node scripts/dev/tool-cost.mjs --json     the same as JSON
import { registerHooks } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if ((specifier.startsWith(".") || specifier.startsWith("/")) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context);
      throw err;
    }
  },
});

const { query, createSdkMcpServer, tool } = await import("@anthropic-ai/claude-agent-sdk");
const { buildTools } = await import("../../engine/team.ts");
const { detectClaude } = await import("../../engine/claude/detect.ts");
const { FALLBACK_MODELS } = await import("../../engine/claude/models.ts").catch(() => ({ FALLBACK_MODELS: [] }));

const asJson = process.argv.includes("--json");
const setup = await detectClaude({});
if (!setup.ready) {
  console.error(`Claude Code is not ready: ${setup.problem ?? "unknown"}`);
  process.exit(1);
}

// A host whose every method would only be called by a model: none is, since no message is sent.
const host = new Proxy({}, { get: () => () => "" });
const models = FALLBACK_MODELS.length ? FALLBACK_MODELS : [{ id: "claude-haiku-5-5", label: "Haiku 5.5", harness: "claude" }];

async function measure(role) {
  const tools = buildTools(role, host, { harness: "claude", models, kinds: [] });
  const dir = mkdtempSync(join(tmpdir(), "pobots-tool-cost-"));
  const abort = new AbortController();
  try {
    const server = createSdkMcpServer({ name: "pobots", alwaysLoad: true, tools: tools.map((t) => tool(t.name, t.description, t.shape, async () => ({ content: [] }))) });
    const prompt = (async function* () {
      await new Promise((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
    })();
    const q = query({
      prompt,
      options: {
        cwd: dir,
        pathToClaudeCodeExecutable: setup.executable,
        env: setup.env,
        model: "claude-haiku-5-5",
        abortController: abort,
        persistSession: false,
        settingSources: [],
        systemPrompt: { type: "preset", preset: "claude_code" },
        mcpServers: { pobots: server },
        stderr: () => {},
      },
    });
    await q.initializationResult();
    const usage = await q.getContextUsage();
    const mcp = (usage.mcpTools ?? []).filter((t) => t.serverName === "pobots");
    const tokens = mcp.reduce((n, t) => n + (t.tokens ?? 0), 0);
    return { role, tools: tools.length, tokens, perTool: Object.fromEntries(mcp.map((t) => [t.name.replace(/^mcp__pobots__/, ""), t.tokens])) };
  } finally {
    abort.abort();
    rmSync(dir, { recursive: true, force: true });
  }
}

const out = [await measure("main"), await measure("bot")];
if (asJson) console.log(JSON.stringify(out, null, 2));
else for (const r of out) console.log(`${r.role === "main" ? "Main bot" : "Other bot"}: ${r.tools} tools, ${r.tokens} tokens\n${Object.entries(r.perTool).map(([k, v]) => `  ${k} ${v}`).join("\n")}`);
process.exit(0);
