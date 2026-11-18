// The tools every bot has for its helpers (15 Nov 2026, docs/build/step-bot-reach.md): read one
// (or list them), steer one, stop one. This file only says what each tool is; the engine does the
// work behind them (engine/core/helper-control.ts, engine/core/helper-read.ts).
import { z } from "zod";
import type { BotTool, ToolResult } from "./claude/session.js";
import { TOOL_NAMES } from "./tool-names.js";

export type ReadHelperArgs = { id?: string; view?: "latest" | "overview"; from?: number; to?: number; bot?: string };
export type SteerHelperArgs = { id: string; text: string };
export type StopHelperArgs = { id: string; bot?: string };

export interface HelperHost {
  readHelper(args: ReadHelperArgs): ToolResult;
  steerHelper(args: SteerHelperArgs): Promise<ToolResult>;
  stopHelper(args: StopHelperArgs): Promise<ToolResult>;
}

const helperId = z.string().min(1).max(60);

export function helperTools(host: HelperHost, main: boolean): BotTool[] {
  const bot: Record<string, z.ZodType> = main ? { bot: z.string().max(200).optional().describe("Another bot's id or name, to reach its helpers. Leave out for your own.") } : {};
  return [
    {
      name: TOOL_NAMES.readHelper,
      description:
        "See your helpers. Without id: the list, newest first, with id, status and last line. With id: its latest steps in full (what it said, its tool calls with short inputs and results, errors, what it works on now); view overview shows its whole thread from the start, one short line a step; from and to show any steps in full by those numbers." +
        (main ? " With bot, another bot's helpers." : ""),
      shape: {
        id: helperId.optional().describe("The helper's id, from start_helper or the list."),
        view: z.enum(["latest", "overview"]).optional().describe("latest (the default) or overview."),
        from: z.number().int().min(1).optional().describe("First step to show in full, by the overview's numbers."),
        to: z.number().int().min(1).optional().describe("Last step to show in full."),
        ...bot,
      },
      handler: async (args) => host.readHelper(args as ReadHelperArgs),
    },
    {
      name: TOOL_NAMES.steerHelper,
      description:
        "Send a message into one of your own helpers while it works, such as a correction or more to do. It reads it at its next step and goes on. Only for a helper started with start_helper that is still working; one that ended is not started again.",
      shape: { id: helperId.describe("The helper's id."), text: z.string().min(1).max(8000).describe("What to tell it.") },
      handler: (args) => host.steerHelper(args as SteerHelperArgs),
    },
    {
      name: TOOL_NAMES.stopHelper,
      description: "Stop a helper that is working, at once, for example when helpers get in each other's way. Answers with its last state." + (main ? " With bot, another bot's helper; the person and that bot are told." : ""),
      shape: { id: helperId.describe("The helper's id."), ...bot },
      handler: (args) => host.stopHelper(args as StopHelperArgs),
    },
  ];
}
