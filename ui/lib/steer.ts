// Steering (protocol 14): the words for what a message sent while a bot works does, in Pobots settings
// and on the send button. Follows T3 Code's "Follow-up behavior" (apps/web/src/components/settings/
// SettingsPanels.tsx, apps/web/src/components/chat/ComposerPrimaryActions.tsx, docs/user/composer.md):
// a default in settings, and the other one for a single message with a modifier and Enter on a
// computer, or by holding the send button on a phone.
import type { FollowUp } from "../../shared/protocol";
import { isMac } from "./env";

/** The keys that do the other for one message on a computer. */
export const OTHER_KEYS = isMac ? "⌘+Enter" : "Ctrl+Enter";

/** The section in Pobots settings. */
export const FOLLOW_UP_TITLE = "When a bot is working";
export const FOLLOW_UP_INTRO = "What happens to a message you send while a bot is in the middle of something.";
export const FOLLOW_UPS: { id: FollowUp; label: string; hint: string }[] = [
  { id: "steer", label: "Steer", hint: "Your message goes into what it is doing now. It reads it at its next step." },
  { id: "queue", label: "Queue", hint: "Your message waits until it is done." },
];
/** How to do the other for one message, on a computer and on a phone. */
export const FOLLOW_UP_OTHER = `For one message, do the other: press ${OTHER_KEYS} on a computer, or hold the send button on a phone.`;

export const other = (f: FollowUp): FollowUp => (f === "steer" ? "queue" : "steer");

/** The send button's name while the bot works. */
export const sendName = (f: FollowUp): string => (f === "steer" ? "Steer message" : "Queue message");

/** The send button's tooltip on a computer while the bot works. */
export const sendHint = (f: FollowUp): string => `${sendName(f)} · ${OTHER_KEYS} to ${other(f)}`;

/** The note under a message from the person that went into the bot's running turn. */
export const STEERED = "Steered";
/** The button beside "Queued" that steers a queued message now. */
export const STEER_NOW = "Steer now";
