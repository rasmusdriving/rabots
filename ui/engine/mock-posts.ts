// Bots post in channels on their own (&posts=1, the window check's section "posts", 15 Nov 2026):
// Kaja may post in Ops - Internal. Its chat has the line of a post that went out, with the post
// behind "Show the post", and the line of one that could not go out, in the error tone.
import type { ActivityItem, BotItem, NoticeItem, UserItem } from "../../shared/protocol";
import type { MockEngine } from "./mock";
import { OPS, minutesAgo } from "./mock-data";

export const POST_TEXT = "**Ops status, week 46**\n\n- Nordvik imports on Thursday.\n- Aalto waits for the report template.\n- Two support tickets are open, none urgent.";
export const POST_FAILED_TEXT = "Reminder: the retro is moved to Friday 10:00.";

export function seedPosts(mock: MockEngine): void {
  const kaja = mock.bots.find((b) => b.id === "kaja");
  const ops = mock.channels.find((c) => c.id === "ch-ops");
  if (!kaja || !ops) return;
  ops.mayPost = ["kaja"];
  const t = kaja.mainThreadId;
  const turnId = "tk-post";
  mock.add<UserItem>(t, { kind: "user", from: { type: "trigger", label: "Monday status" }, queued: false, turnId, text: "Write this week's Ops status and post it in Ops - Internal." }, minutesAgo(30));
  mock.add<ActivityItem>(t, { kind: "activity", botId: "kaja", turnId, label: `Posted in ${OPS}`, status: "done", durationMs: 2_000, detail: POST_TEXT }, minutesAgo(29));
  mock.add<BotItem>(t, { kind: "bot", botId: "kaja", streaming: false, turnId, text: `The status is posted in ${OPS}.` }, minutesAgo(29));
  mock.add<NoticeItem>(t, { kind: "notice", tone: "info", text: `Posted in ${OPS}`, mark: "posted", detail: POST_TEXT }, minutesAgo(29));
  const failed = "tk-post-failed";
  mock.add<UserItem>(t, { kind: "user", from: { type: "you" }, queued: false, turnId: failed, text: "Post a reminder about the retro in Ops - Internal." }, minutesAgo(6));
  mock.add<ActivityItem>(t, { kind: "activity", botId: "kaja", turnId: failed, label: `Could not post in ${OPS}`, status: "failed", durationMs: 15_000, detail: "The flow did not answer in time. The post may still appear; check the channel before posting again." }, minutesAgo(5));
  mock.add<BotItem>(t, { kind: "bot", botId: "kaja", streaming: false, turnId: failed, text: "The post did not go out: the flow did not answer in time. It may still appear, so I will not post it again before you have checked the channel." }, minutesAgo(5));
  mock.add<NoticeItem>(
    t,
    { kind: "notice", tone: "error", text: `Could not post in ${OPS}: no answer in time. Check the channel before posting again`, detail: POST_FAILED_TEXT },
    minutesAgo(5),
  );
}
