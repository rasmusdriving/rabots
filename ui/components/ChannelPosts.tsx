// A channel's "Posts" section (15 Nov 2026, docs/build/step-channel-posts.md): which bots may write
// new posts here on their own, not only answer. A row per bot with its face, its name and a switch,
// off by default, as the rows of switches in T3 Code's settings
// (apps/web/src/components/settings/BackgroundActivitySettings.tsx) and Pobots' own "May message".
// The switch shows the new place at once and goes back only if the change could not be saved.
import { useState } from "react";
import type { Bot, Channel } from "../../shared/protocol";
import { saveChannel } from "../state/actions";
import { useAppState } from "../state/store";
import { useSaver } from "../lib/hooks";
import { Face } from "./bits";
import { SectionHead } from "./SettingsView";

/** The most posts a bot may write in a channel in an hour, as the engine counts them. */
export const POSTS_PER_HOUR = 6;

export function ChannelPosts({ channel, id }: { channel: Channel; id: string }) {
  const bots = useAppState((s) => s.bots);
  const [state, save] = useSaver();
  /** What a switch was just set to, until the engine's change arrives or the save fails. */
  const [want, setWant] = useState<Record<string, boolean>>({});
  const head = `${id}-posts`;
  const on = (bot: Bot) => want[bot.id] ?? channel.mayPost.includes(bot.id);

  const toggle = async (bot: Bot, value: boolean) => {
    setWant((w) => ({ ...w, [bot.id]: value }));
    // From what the switches show, so a second switch set before the first change arrived keeps the first.
    const next = bots.filter((b) => (b.id === bot.id ? value : on(b))).map((b) => b.id);
    await save(() => saveChannel({ id: channel.id, mayPost: next }));
    setWant((w) => {
      const { [bot.id]: _done, ...rest } = w;
      return rest;
    });
  };

  return (
    <section className="pb-section" aria-labelledby={head}>
      <SectionHead id={head} title="Posts" state={state} />
      <p className="pb-section-text" id={`${head}-text`}>
        A bot with the switch on may write new posts here on its own, not only answer, through the address for answers. At most {POSTS_PER_HOUR} an hour each.
      </p>
      {bots.length === 0 ? (
        <p className="pb-section-text">There are no bots yet.</p>
      ) : (
        <ul className="pb-peers" aria-labelledby={head}>
          {bots.map((bot) => (
            <li key={bot.id} className="pb-peer">
              <Face look={bot.look} size="sm" />
              <span className="pb-peer-text">
                <span className="pb-peer-name">{bot.name}</span>
              </span>
              <input
                className="pb-switch"
                type="checkbox"
                role="switch"
                checked={on(bot)}
                aria-label={`${bot.name} may post`}
                onChange={(e) => void toggle(bot, e.target.checked)}
              />
            </li>
          ))}
        </ul>
      )}
      {!channel.hasReplyUrl && <span className="pb-hint">No address for answers is set yet, so posts cannot go out. Set it under Answers.</span>}
    </section>
  );
}
