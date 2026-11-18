import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ModelInfo as SdkModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { labelFor, mapModels } from "../claude/models.js";

const row = (value: string, resolvedModel?: string, efforts?: SdkModelInfo["supportedEffortLevels"]): SdkModelInfo => ({
  value,
  resolvedModel,
  displayName: value,
  description: "",
  supportsEffort: efforts ? true : undefined,
  supportedEffortLevels: efforts,
});

describe("models", () => {
  test("labels", () => {
    assert.equal(labelFor("claude-opus-5-5"), "Opus 5.5");
    assert.equal(labelFor("claude-fable-5"), "Fable 5");
    assert.equal(labelFor("claude-haiku-5-5"), "Haiku 5.5");
    assert.equal(labelFor("something-else"), "something-else");
  });

  test("offers the newest plain Claude model of each family, resolves aliases, drops the rest", () => {
    // Shaped like what the installed harness reported behind the local gateway (Nov 2026).
    const rows = [
      row("default", "claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]),
      row("opus", "claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]),
      row("claude-fable-5", "claude-fable-5", ["low", "medium", "high"]),
      row("claude-fable-5-dd-anul-6-tpg", "claude-fable-5-dd-anul-6-tpg", ["low"]),
      row("claude-fable-5-dd-tsaf-b72-8.3-newq", "claude-fable-5-dd-tsaf-b72-8.3-newq", ["low"]),
      row("sonnet", "claude-sonnet-5-5", ["low", "medium", "high", "xhigh", "max"]),
      row("haiku", "claude-haiku-5-5", ["low", "medium", "high"]),
      row("claude-sonnet-4-20250514", "claude-sonnet-4-20250514"),
      row("claude-opus-4-6", "claude-opus-4-6", ["low", "medium", "high", "max"]),
      row("claude-opus-5", "claude-opus-5"),
    ];
    const models = mapModels(rows);
    assert.deepEqual(
      models.map((m) => m.id),
      ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    );
    assert.deepEqual(models.find((m) => m.id === "claude-haiku-5-5")?.efforts, ["low", "medium", "high"]);
    assert.equal(models.find((m) => m.id === "claude-opus-5-5")?.defaultEffort, "medium");
  });
});
