// A task manager's thread (docs/build/step-task-managers.md), in the place of its bot's chat, as a
// helper's thread opens. The same calm line on top says where you are and takes you back, with its
// model and its state; under it one quiet line with its settings (workers at once, tools, whom it may
// message). At the foot a message box writes to it, "Stop" while it works and "End task manager"
// while it is there. After T3 Code, where a delegated task is a thread the person can write in
// (apps/server/src/mcp/OrchestratorMcpService.ts).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Bot, HelperItem } from "../../shared/protocol";
import { messageOf } from "../engine/types";
import { helperModelLabel } from "../lib/models";
import { usePhone } from "../lib/phone";
import { carried, useCarry } from "../lib/carry";
import { TM_STATE_WORD, TM_TOOL_WORD, TM_WORDS, type ManagerState } from "../lib/task-managers";
import { plural } from "../lib/words";
import { endManager, ensureThread, helperBack, sendToManager, stopManager } from "../state/actions";
import { useAppState, type HelperFrame } from "../state/store";
import { BackIcon, ForwardIcon, Mark, SendIcon } from "./bits";
import { Confirm } from "./Dialog";
import { QuietLines } from "./ChatPanel";
import { Thread } from "./Thread";

const LINE = 24;
const MAX_LINES = 6;
const MAX_LINES_PHONE = 5;

export function TaskManagerPane({ bot, frame, stack }: { bot: Bot; frame: HelperFrame; stack: HelperFrame[] }) {
  const item = useAppState((s) => s.threads[frame.threadId]?.items.find((i): i is HelperItem => i.id === frame.itemId && i.kind === "helper"));
  const info = bot.taskManagers?.find((t) => t.id === frame.itemId);
  const models = useAppState((s) => s.models);
  const back = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState<"stop" | "end" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const depth = stack.length;
  const parent = stack[depth - 2];
  const backTo = parent ? parent.title || "Helper" : bot.name;
  const title = (info?.title ?? item?.title ?? frame.title).trim() || "Task manager";
  // Live from the bot while it is there; from its row once it has ended.
  const state: ManagerState = info?.state ?? item?.taskManager?.state ?? (item ? "ended" : "resting");
  const ended = !info && (state === "ended" || !!item?.endedAt);
  const working = !ended && state !== "resting";
  const settings = info ?? item?.taskManager;
  const modelLabel = helperModelLabel(models, info ? { model: info.model, ...(info.effort ? { effort: info.effort } : {}) } : (item ?? {}));

  useEffect(() => ensureThread(frame.threadId), [frame.threadId]);
  useEffect(() => {
    if (!document.activeElement?.closest(".pb-helper")) back.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!working && asking === "stop") setAsking(null);
  }, [working, asking]);

  const act = async (what: "stop" | "end") => {
    setBusy(true);
    setError(undefined);
    try {
      await (what === "stop" ? stopManager(bot.id, frame.itemId) : endManager(bot.id, frame.itemId));
      setAsking(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const shownState = ended ? "ended" : state;
  return (
    <>
      <div className="pb-helper-bar" role="navigation" aria-label="Where you are">
        <button ref={back} type="button" className="pb-helper-back" aria-label={`Back to ${backTo}`} onClick={() => helperBack(bot.id)}>
          <BackIcon />
          <span className="pb-helper-back-name">{backTo}</span>
        </button>
        <span className="pb-helper-bar-sep" aria-hidden="true">
          <ForwardIcon />
        </span>
        <h2 className="pb-helper-bar-title" title={title}>
          {title}
        </h2>
        {modelLabel && (
          <span className="pb-helper-model pb-helper-bar-model pb-tm-bar-model" title={`Runs on ${modelLabel}`}>
            {modelLabel}
          </span>
        )}
        <span className="pb-helper-bar-state pb-tm-state" data-state={shownState}>
          {working && <Mark state={state === "waiting" ? "waiting" : "thinking"} />}
          <span className="pb-fade-in" key={shownState}>
            {TM_STATE_WORD[shownState]}
          </span>
        </span>
      </div>
      {settings && (
        <p className="pb-tm-settings">
          {/* Every part starts with a dot; the dot of a part that starts a line is clipped away. */}
          <span className="pb-tm-clip">
            <span className="pb-tm-list">
              {/* On a phone the model stands here instead of in the head, so the title keeps its room. */}
              {modelLabel && <span className="pb-tm-model">{modelLabel}</span>}
              <span>{`${plural(settings.maxWorkers, "worker")} at once${info ? `, ${info.workersNow} now` : ""}`}</span>
              <span>{settings.tools.length ? settings.tools.map((t) => TM_TOOL_WORD[t]).join(", ") : "No tools"}</span>
              <span>{`May message ${[bot.name, ...settings.mayMessage].join(", ")}`}</span>
              {settings.folder && (
                <span className="pb-tm-folder" title={settings.folder}>
                  {settings.folder}
                </span>
              )}
            </span>
          </span>
        </p>
      )}
      <Thread bot={bot} helper={{ frame, item, depth, manager: true }} />
      <div className="pb-main-foot">
        <div className="app-foot">
          <QuietLines bot={bot} />
          {ended ? (
            <div className="pb-helper-foot">
              <p className="pb-helper-note">{`This task manager has ended. ${bot.name} can start a new one.`}</p>
            </div>
          ) : (
            <>
              <ManagerComposer bot={bot} managerId={frame.itemId} onError={setError} />
              <div className="pb-helper-foot pb-tm-foot">
                <p className="pb-helper-note">{error && !asking ? <span role="alert">{error}</span> : `Works for ${bot.name}.`}</p>
                {/* Kept in place, out of sight, while it rests, so the foot keeps its width. */}
                <button
                  type="button"
                  className="pb-btn pb-btn-sm pb-btn-quiet"
                  data-gone={!working || undefined}
                  aria-hidden={!working || undefined}
                  tabIndex={working ? undefined : -1}
                  onClick={() => {
                    if (!working) return;
                    setError(undefined);
                    setAsking("stop");
                  }}
                >
                  {TM_WORDS.stop}
                </button>
                <button
                  type="button"
                  className="pb-btn pb-btn-sm"
                  onClick={() => {
                    setError(undefined);
                    setAsking("end");
                  }}
                >
                  {TM_WORDS.end}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {asking === "stop" && (
        <Confirm
          title="Stop this task manager?"
          text="It stops what it does, and its workers stop too. It stays, resting, and goes on when it gets a message."
          yes="Stop"
          no="Cancel"
          busy={busy}
          error={error}
          onYes={() => void act("stop")}
          onNo={() => setAsking(null)}
        />
      )}
      {asking === "end" && (
        <Confirm
          title="End this task manager?"
          text={`Its workers stop and it leaves the rail. ${bot.name} is told. Its thread stays in the history.`}
          yes={TM_WORDS.end}
          no="Cancel"
          tone="danger"
          busy={busy}
          error={error}
          onYes={() => void act("end")}
          onNo={() => setAsking(null)}
        />
      )}
    </>
  );
}

/** The message box at its foot: Enter sends (on a phone Enter adds a line), it grows to six lines. */
function ManagerComposer({ bot, managerId, onError }: { bot: Bot; managerId: string; onError(e: string | undefined): void }) {
  const phone = usePhone();
  const key = `tm:${managerId}`;
  const [text, setText] = useState(() => carried<string>(key) ?? "");
  useCarry(key, text || undefined);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const maxLines = phone ? MAX_LINES_PHONE : MAX_LINES;
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    el.style.height = `${LINE + pad}px`;
    el.style.height = `${Math.min(el.scrollHeight, LINE * maxLines + pad)}px`;
    el.style.overflowY = el.scrollHeight > LINE * maxLines + pad ? "auto" : "hidden";
  }, [text, maxLines]);
  const empty = !text.trim();
  const send = () => {
    if (empty || sending) return;
    setSending(true);
    onError(undefined);
    const sent = text;
    setText("");
    sendToManager(bot.id, managerId, sent.trim()).then(
      () => setSending(false),
      (e: unknown) => {
        setSending(false);
        setText(sent);
        onError(messageOf(e));
      },
    );
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !phone) {
      e.preventDefault();
      send();
    }
  };
  return (
    <div className="pb-composer app-composer pb-tm-composer" onClick={(e) => e.target === e.currentTarget && field.current?.focus()}>
      <textarea
        ref={field}
        rows={1}
        value={text}
        placeholder="Message the task manager"
        aria-label="Message the task manager"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        enterKeyHint={phone ? "enter" : undefined}
      />
      <div className="pb-composer-bar">
        <button className="pb-send pb-push" type="button" aria-label="Send" aria-disabled={empty || sending || undefined} onClick={send}>
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
