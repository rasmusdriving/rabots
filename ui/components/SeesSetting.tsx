// "What Kaja sees" in a bot's settings (docs/sees.md): which of the person's connected services,
// plugins and skills a bot sees. On a GPT model its Codex session follows the choice as far as Codex
// allows (docs/build/step-gpt-bot-sees.md): one more hint says how, and no token figures (they are
// Claude's). Closed, one calm line says what the choice leaves out and
// what it saves. Opened: the ready-made sets, then the three groups, each with "the rest" as its own
// row. What exists is read from the engine when the part opens; the space is held while it reads.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Bot, BotSees, SeesInventory, SeesService } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { useSaver } from "../lib/hooks";
import { FROM_WORD, isOn, keepSeesLine, keptSeesLine, readWhen, restOn, sameSees, seesSummary, tokensWord, withRest, withRow, type SeesPart } from "../lib/sees";
import { readSees, setBotSees } from "../state/actions";
import { CheckIcon } from "./bits";
import { radioKeys, SectionHead } from "./SettingsView";

const STATE_WORD: Record<SeesService["state"], string> = { connected: "Connected", "needs-sign-in": "Not signed in", failed: "Did not connect", off: "Switched off on this Mac" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pluginWord = (id: string) => id.split("@")[0] || id;

export function SeesSetting({ bot }: { bot: Bot }) {
  const id = `set-${bot.id}-sees`;
  const gpt = bot.harness === "codex";
  const [state, save] = useSaver();
  const [open, setOpen] = useState(false);
  const [inv, setInv] = useState<SeesInventory | null>(null);
  const [problem, setProblem] = useState<string>();
  const [reading, setReading] = useState(false);
  const [showIdle, setShowIdle] = useState(false);
  // The choice as last switched here, until its save is back: two quick switches build on each other.
  const [draft, setDraft] = useState<{ sees: BotSees | null; n: number }>();
  const saves = useRef(0);
  const readFor = useRef("");
  const sees = draft ? draft.sees ?? undefined : bot.sees;

  const read = (refresh: boolean) => {
    const token = `${bot.id}:${Math.random()}`;
    readFor.current = token;
    setReading(true);
    readSees(bot.id, refresh).then(
      (r) => {
        if (readFor.current !== token) return;
        if (r.inventory) setInv(r.inventory);
        setProblem(r.problem);
        setReading(false);
      },
      (e: unknown) => {
        if (readFor.current !== token) return;
        setProblem(messageOf(e));
        setReading(false);
      },
    );
  };

  // A bot with a choice reads at once, so the closed line can say what it saves.
  useEffect(() => {
    setInv(null);
    setProblem(undefined);
    setOpen(false);
    setDraft(undefined);
    readFor.current = "";
    if (bot.sees) read(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  // A choice made elsewhere (by the main bot's tool) while nothing is read yet: read now, so the
  // closed line does not stay on "Reading".
  const chosen = !!bot.sees;
  useEffect(() => {
    if (chosen && !inv && !reading && !readFor.current) read(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen]);

  const change = (next: BotSees | null) => {
    const n = ++saves.current;
    setDraft({ sees: next, n });
    void save(() => setBotSees(bot.id, next)).then(() => {
      if (saves.current === n) setDraft(undefined);
    });
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !reading && (!inv || problem)) read(false);
  };

  // The closed line. Until the first read is back it is the line this browser last read for the same
  // choice, or a quiet "Reading" line; never one built from the choice alone, which read wrong (fix 0.26.3).
  const kept = sees && !inv ? keptSeesLine(bot.id, sees, !gpt) : undefined;
  const pending = !!sees && !inv && !kept && !problem;
  const line = pending ? `Reading what ${bot.name} sees` : (kept ?? seesSummary(sees, inv, { tokens: !gpt }));
  useEffect(() => {
    if (sees && inv) keepSeesLine(bot.id, sees, !gpt, line);
  }, [bot.id, sees, inv, gpt, line]);

  const connected = inv?.services.filter((s) => s.state === "connected") ?? [];
  const idle = inv?.services.filter((s) => s.state !== "connected") ?? [];
  const offPlugins = new Set(inv?.plugins.filter((p) => !isOn(sees, "plugins", p.id)).map((p) => p.id) ?? []);
  const sets = inv?.sets ?? [];
  const setAt = sets.findIndex((s) => sameSees(sees, s.sees));
  const pickSet = (i: number) => {
    const s = sets[i];
    if (s && i !== setAt) change(s.sees ? structuredClone(s.sees) : null);
  };

  const serviceRow = (s: SeesService) => {
    const withPlugin = !!s.plugin && offPlugins.has(s.plugin);
    const bits = [s.from === "plugin" && s.plugin ? `Plugin ${pluginWord(s.plugin)}` : FROM_WORD[s.from]];
    if (s.state === "connected") bits.push(plural(s.tools, "tool"), ...(gpt ? [] : [tokensWord(s.tokens)]));
    else bits.push(STATE_WORD[s.state]);
    if (withPlugin) bits.push("off with its plugin");
    return <Row key={s.name} name={s.name} label={s.label} hint={bits.join(" · ")} on={!withPlugin && isOn(sees, "services", s.name)} disabled={withPlugin} onPick={(on) => change(withRow(sees, "services", s.name, on))} />;
  };

  return (
    <section className="pb-section app-sees" aria-labelledby={id}>
      <SectionHead id={id} title={`What ${bot.name} sees`} state={state} />
      <p className="pb-section-text">{`Your connected services, plugins and skills on this Mac. Each one is sent along on every step ${bot.name} takes, used or not, and that uses up your plan a little faster. What ${bot.name} never uses can be left out here.`}</p>
      <div className="app-sees-summary">
        <span className="app-sees-line" data-sees-summary data-pending={pending || undefined}>
          {line}
        </span>
        <button className="pb-btn pb-btn-sm" type="button" aria-expanded={open} aria-controls={`${id}-body`} onClick={toggle}>
          {open ? "Close" : "Choose"}
        </button>
      </div>
      <span className="pb-hint">{`A change holds from ${bot.name}'s next message.`}</span>
      {gpt && <span className="pb-hint" data-sees-gpt>{"On a GPT model, a service Codex also has follows its row here and any other follows The rest. Codex's plugins follow The rest of plugins as a whole. Skills are not changed."}</span>}
      {open && (
        <div className="app-sees-body" id={`${id}-body`} data-empty={!inv || undefined}>
          <div className="app-sees-status">
            <span className={problem && !reading ? "pb-hint app-hint-error" : "pb-hint"} role="status" data-sees-status>
              {reading ? "Reading what this Mac has." : problem ?? (inv ? readWhen(inv.readAt) : "")}
            </span>
            <button className="pb-btn pb-btn-quiet pb-btn-sm" type="button" disabled={reading} onClick={() => read(true)}>
              Read again
            </button>
          </div>
          {inv && (
            <>
              <div className="pb-choices" role="radiogroup" aria-label="Start from" onKeyDown={(e) => radioKeys(e, sets.length, Math.max(0, setAt), pickSet, 1)}>
                {sets.map((s, i) => (
                  <button key={s.id} className="pb-choice" type="button" role="radio" data-sees-set={s.id} aria-checked={i === setAt} tabIndex={i === Math.max(0, setAt) ? 0 : -1} onClick={() => pickSet(i)}>
                    <span className="pb-choice-label">{s.name}</span>
                    <span className="pb-choice-hint">{s.hint}</span>
                    {i === setAt && <CheckIcon />}
                  </button>
                ))}
                {setAt < 0 && <span className="pb-hint app-sees-own">{`${bot.name}'s own choice. Picking a set replaces it.`}</span>}
              </div>

              <Group title="Connected services" part="services">
                <RestRow part="services" sees={sees} hint="Every service not named below, also one you connect later." onPick={(on) => change(withRest(sees, "services", on))} />
                {connected.map(serviceRow)}
                {idle.length > 0 && (
                  <li className="app-sees-fold-row">
                    <button className="pb-btn pb-btn-quiet pb-btn-sm app-sees-fold" type="button" aria-expanded={showIdle} onClick={() => setShowIdle(!showIdle)}>
                      {`${idle.length} not connected, they cost nothing`}
                    </button>
                  </li>
                )}
                {showIdle && idle.map(serviceRow)}
              </Group>

              <Group title="Plugins" part="plugins">
                <RestRow part="plugins" sees={sees} hint="Every plugin not named below, also one you add later. A plugin that is off takes its skills and services with it." onPick={(on) => change(withRest(sees, "plugins", on))} />
                {inv.plugins.map((p) => (
                  <Row
                    key={p.id}
                    name={p.id}
                    label={p.name}
                    hint={[plural(p.skills, "skill"), plural(p.services, "service"), ...(gpt ? [] : [tokensWord(p.tokens)])].join(" · ")}
                    on={isOn(sees, "plugins", p.id)}
                    onPick={(on) => change(withRow(sees, "plugins", p.id, on))}
                  />
                ))}
              </Group>

              <Group title="Skills" part="skills">
                <RestRow part="skills" sees={sees} hint={`Every skill not named below, also one you add later. By name only, ${bot.name} sees the name and can still open the skill.`} onPick={(on) => change(withRest(sees, "skills", on))} />
                {inv.skills.map((k) => (
                  <Row
                    key={k.name}
                    name={k.name}
                    label={k.name}
                    hint={gpt ? FROM_WORD[k.from] : `${FROM_WORD[k.from]} · ${tokensWord(k.tokens)} in full`}
                    on={isOn(sees, "skills", k.name)}
                    words={["In full", "Name only"]}
                    onPick={(on) => change(withRow(sees, "skills", k.name, on))}
                  />
                ))}
              </Group>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Group({ title, part, children }: { title: string; part: SeesPart; children: ReactNode }) {
  const hid = `sees-group-${part}`;
  return (
    <div className="app-sees-group" data-sees-group={part}>
      <h3 className="app-sees-group-title" id={hid}>
        {title}
      </h3>
      <ul className="app-sees-rows" aria-labelledby={hid}>
        {children}
      </ul>
    </div>
  );
}

function RestRow({ part, sees, hint, onPick }: { part: SeesPart; sees: BotSees | undefined; hint: string; onPick: (on: boolean) => void }) {
  return <Row name="" rest label="The rest" hint={hint} on={restOn(sees, part)} words={part === "skills" ? ["In full", "Name only"] : undefined} onPick={onPick} />;
}

function Row({
  name,
  label,
  hint,
  on,
  onPick,
  words = ["On", "Off"],
  rest,
  disabled,
}: {
  name: string;
  label: string;
  hint: string;
  on: boolean;
  onPick: (on: boolean) => void;
  words?: [string, string];
  rest?: boolean;
  disabled?: boolean;
}) {
  return (
    <li className="app-sees-row" data-sees-row={rest ? "rest" : name} data-on={on || undefined}>
      <span className="app-sees-text">
        <span className="app-sees-name">{label}</span>
        <span className="app-sees-hint">{hint}</span>
      </span>
      <span className="pb-seg app-sees-seg" role="group" aria-label={label}>
        <button type="button" aria-pressed={on} disabled={disabled} onClick={() => !on && onPick(true)}>
          {words[0]}
        </button>
        <button type="button" aria-pressed={!on} disabled={disabled} onClick={() => on && onPick(false)}>
          {words[1]}
        </button>
      </span>
    </li>
  );
}
