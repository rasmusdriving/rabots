// Where a bot's chat was when the bot's page opened over it on a phone.
//
// On a phone the bot's page is a sheet over the chat, and the chat is taken away while it shows.
// Its place is kept here, so the way back shows it exactly as it was left: the same line at the
// top, nothing arriving anew. It is forgotten as soon as the phone shows anything but that bot's
// page (another bot, Bots, Needs you), and when a notification is opened on that chat, so a chat
// opened for what is new starts at its newest message. The laptop never keeps one.
import { isPhone } from "../lib/phone";
import { store } from "./store";

export interface ChatPlace {
  top: number;
  pinned: boolean;
}

let kept: { threadId: string; place: ChatPlace; forget(): void } | null = null;

/** The chat of `botId` is taken away for the bot's page: keeps where it was. */
export function keepChatPlace(threadId: string, botId: string, place: ChatPlace): void {
  forgetChatPlace();
  const off = store.subscribe(() => {
    const s = store.get();
    if (s.openBotId === botId && s.phoneScreen === "bot" && !s.openChannelId) return;
    if (kept?.threadId === threadId) forgetChatPlace();
  });
  kept = { threadId, place: { ...place }, forget: off };
}

/** The place kept for this chat, once. Nothing on the laptop, for another chat, or when none was kept. */
export function takeChatPlace(threadId: string): ChatPlace | undefined {
  const k = kept;
  if (!k) return undefined;
  forgetChatPlace();
  return k.threadId === threadId && isPhone() ? k.place : undefined;
}

/** Forgets the place: the chat opens at its newest message. */
export function forgetChatPlace(): void {
  kept?.forget();
  kept = null;
}
