// Tables in a bot's answer (&table=1, the window check's section "mdtable"): the table the person saw squeezed
// to two letters a line on 15 Nov 2026 ("Bo / t", "Inb / ox"), and one with a long unbroken address
// that must scroll sideways in its own box, never widen the chat.
import type { Item } from "../../shared/protocol";
import type { MockEngine } from "./mock";

export const TABLE_ANSWER = [
  "All four bots are trimmed; the developer bot is untouched. Every skill not named below is listed by name only.",
  "",
  "| Bot | Services it still sees | Skills in full | Saved per step (about) |",
  "| --- | --- | --- | --- |",
  "| Inbox | Microsoft 365 | none | 17,000 tokens |",
  "| Tia | HubSpot, local HubSpot tickets, Microsoft 365, Zendesk | hubspot-session, support-internal-api, support-public-api, support-help-center, browser-use | 14,400 tokens |",
  "| Ops | HubSpot, local HubSpot tickets, Notion, Microsoft 365, Azure DevOps | hubspot-session, support-help-center, sql-reader, legal-dpa, legal-handbook-reader, browser-use | 12,100 tokens |",
  "| Kaja | Microsoft 365, HubSpot, local HubSpot tickets, Notion | browser-use, artifact-design | 13,500 tokens |",
  "",
  "The savings are my own sums of the per-item token counts.",
].join("\n");

export const TABLE_URL_ANSWER = [
  "Where each report lives:",
  "",
  "| Report | Address |",
  "| --- | --- |",
  "| Weekly | https://example.com/reports/weekly/2026/november/the-whole-team-with-every-customer-and-every-ticket-of-the-week.pdf |",
  "| Monthly | https://example.org/m |",
].join("\n");

export function seedTables(mock: MockEngine): void {
  const t = "kaja-main";
  const list = mock.threads.get(t);
  if (!list) return;
  const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const added: Item[] = [
    { kind: "user", id: "table-ask", threadId: t, seq: 0, at: at(0), from: { type: "you" }, queued: false, text: "Show me in a short table what each bot sees now." },
    { kind: "bot", id: "table-answer", threadId: t, seq: 0, at: at(1), botId: "kaja", streaming: false, text: TABLE_ANSWER },
    { kind: "bot", id: "table-url", threadId: t, seq: 0, at: at(2), botId: "kaja", streaming: false, text: TABLE_URL_ANSWER },
  ];
  const next = [...list, ...added].map((item, i) => ({ ...item, seq: i + 1 }));
  mock.threads.set(t, next);
  mock.seq.set(t, next.length);
}
