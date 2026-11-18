// The models as the person sees them: one list in two quiet groups, "Claude" and "ChatGPT", in the
// order the engine sends them (step 3a). The groups are the harnesses, but the person never reads
// that word: only the two group names, the model names, and "Codex" where the program itself is
// the subject.
import type { Bot, EngineStatus, Harness, HelperItem, ModelInfo } from "../../shared/protocol";
import { EFFORT_WORD } from "./words";

export const HARNESS_WORD: Record<Harness, string> = { claude: "Claude", codex: "ChatGPT" };

/** What a bot's settings say about who runs a bot on a GPT model. */
export const RUNS_ON_CODEX = "Runs on Codex with your ChatGPT login.";
/** Said under the picker when the chosen model is of the other group than the bot's own. */
export const CHANGE_LINE = "Changing between Claude and ChatGPT starts a fresh session. The bot keeps its memory and gets the end of the chat.";
/** The engine refused a change between the groups because the bot is working ("conflict"). */
export const CHANGE_REFUSED = "Wait until the bot is done, then change its model.";

/**
 * The quiet second part of the heading of the group a bot is not on, where an existing bot's model is
 * chosen: choosing there starts a fresh session (step 3a, after the tester). Said before the choice.
 */
export const FRESH_NOTE = "starts a fresh session";

/** The note for a group's heading: FRESH_NOTE on the other group than `current`, none without a bot. */
export const groupNote = (group: Harness, current: Harness | undefined): string | undefined => (current && group !== current ? FRESH_NOTE : undefined);

export interface ModelGroup {
  harness: Harness;
  label: string;
  models: ModelInfo[];
}

/** True when the engine's Codex can run a GPT model now. An engine that says nothing counts as not ready. */
export const codexReady = (status: EngineStatus | null | undefined): boolean => !!status?.codex?.ready;

/**
 * The models a picker offers: all of them, but no GPT model while Codex is not ready, except the
 * one the bot is on now (`keep`), so its current choice still shows.
 */
export function offeredModels(models: ModelInfo[], status: EngineStatus | null | undefined, keep?: string): ModelInfo[] {
  if (codexReady(status)) return models;
  return models.filter((m) => m.harness !== "codex" || m.id === keep);
}

/** The models in groups by harness, in the order they came. */
export function groupModels(models: ModelInfo[]): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const m of models) {
    const harness: Harness = m.harness ?? "claude";
    let g = groups.find((x) => x.harness === harness);
    if (!g) groups.push((g = { harness, label: HARNESS_WORD[harness], models: [] }));
    g.models.push(m);
  }
  return groups;
}

/** The harness of a model id, from the list; a model not in the list counts as Claude unless it says otherwise. */
export function harnessOf(models: ModelInfo[], id: string, fallback: Harness = "claude"): Harness {
  return models.find((m) => m.id === id)?.harness ?? fallback;
}

/** True when changing `bot` to `modelId` changes between Claude and ChatGPT. */
export function crossesHarness(models: ModelInfo[], bot: Bot, modelId: string): boolean {
  return harnessOf(models, modelId, bot.harness) !== bot.harness;
}

/** The fast mode switch: its name, and the word added after the effort or a helper's label (step 3b). */
export const FAST_WORD = "Fast";
export const FAST_LABEL = "fast";

/** True when the model with this id has a fast mode in the engine's list now. */
export const hasFast = (models: ModelInfo[], id: string): boolean => !!models.find((m) => m.id === id)?.fast;

/** True when the bot runs in fast mode: its model has a fast mode and the bot's choice is on. */
export const runsFast = (models: ModelInfo[], bot: Pick<Bot, "model" | "fast">): boolean => bot.fast !== false && hasFast(models, bot.model);

/**
 * The quiet words after the model's name on the message box: the effort, and ", fast" when the bot
 * runs in fast mode ("Extra high, fast").
 */
export function effortWords(models: ModelInfo[], bot: Pick<Bot, "model" | "effort" | "fast">): string {
  const effort = EFFORT_WORD[bot.effort];
  return runsFast(models, bot) ? `${effort}, ${FAST_LABEL}` : effort;
}

/**
 * The quiet label on a helper's row and above its thread: "GPT-6.1 Terra, high". The model's label
 * from the list (the id itself when it is not in the list), then the effort when set, then "fast"
 * when the helper runs in fast mode (step 3b): "GPT-6.1 Terra, extra high, fast". Empty when the
 * helper runs on the bot's own model and effort.
 */
export function helperModelLabel(models: ModelInfo[], item: Pick<HelperItem, "model" | "effort" | "fast">): string {
  const model = item.model?.trim();
  const name = model ? (models.find((m) => m.id === model)?.label ?? model) : "";
  const effort = item.effort ? EFFORT_WORD[item.effort] : "";
  const parts = name ? [name, ...(effort ? [effort.toLowerCase()] : [])] : effort ? [`${effort} effort`] : [];
  if (item.fast) parts.push(parts.length ? FAST_LABEL : FAST_WORD);
  return parts.join(", ");
}
