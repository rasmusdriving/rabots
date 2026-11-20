// Engine 0.42.1 (docs/build/step-fix-0.42.1.md): no method's schema may drop a key its protocol params
// declare. zod drops unknown keys without a word, so "ahead.settings.set" lost `todoBlocks` and
// `scheduling` from the window and the engine saved nothing. Two guards:
// - at type-check time (`npm run typecheck`), for every method, the top-level keys of the protocol's
//   params against the keys the method's schema gives back;
// - at run time, the Ahead settings the way the window sends them, through parseParams (what the
//   server does) into setAheadByPerson, read back from the snapshot.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { z } from "zod";
import type { MethodName, Methods } from "../../shared/protocol.js";
import { AHEAD_SCHEDULING_DEFAULT, AHEAD_SCHEDULING_MAX } from "../../shared/protocol.js";
import { type ParamSchemas, parseParams } from "../schemas.js";
import { setAheadByPerson } from "../core/ahead-setup.js";
import { setAheadSettings, todoBlocksOn } from "../core/ahead-settings.js";
import { setCalendar } from "../core/calendar-settings.js";
import { makeCalendarStandin } from "../../scripts/calendar-standin.mjs";
import { setup } from "./fake.js";

// ---- Type-level: every protocol key survives its schema ----

/** Every key of every member of a union (keyof a union gives only the shared ones). */
type AllKeys<T> = T extends unknown ? keyof T : never;
type Params<M extends MethodName> = NonNullable<Methods[M]["params"]>;
type Parsed<M extends MethodName> = NonNullable<z.output<ParamSchemas[M]>>;
/** The protocol's keys for M that its schema drops. `string` keys (records) are left out. */
type Dropped<M extends MethodName> = string extends AllKeys<Params<M>> ? never : Exclude<AllKeys<Params<M>>, AllKeys<Parsed<M>>>;
/** The methods whose schema drops a key, with the keys: must be empty. */
type Offenders = { [M in MethodName as [Dropped<M>] extends [never] ? never : M]: Dropped<M> };
// A method listed here fails the type check with "Property '<method>' is missing in type '{}'".
export const schemaDropsNothing: Offenders = {};
// Nested too, for the one patch the window sends inside a method.
type PatchDropped = Exclude<AllKeys<Methods["bot.update"]["params"]["patch"]>, AllKeys<Parsed<"bot.update">["patch"]>>;
export const botPatchDropsNothing: [PatchDropped] extends [never] ? true : PatchDropped = true;

// ---- Run time: the Ahead settings as the window sends them ----

/** What the server does with a request's params before the engine sees them. */
function asServer<M extends MethodName>(method: M, params: unknown): Methods[M]["params"] {
  const p = parseParams(method, params);
  assert.ok(p, `${method} refused ${JSON.stringify(params)}`);
  return p;
}

describe("engine 0.42.1: no schema drops what the window sends", () => {
  test("ahead.settings.set keeps todoBlocks and scheduling, and the engine saves them", async () => {
    const flow = makeCalendarStandin({});
    const url = await flow.listen();
    const w = setup(undefined, undefined, { calendarTimeoutMs: 2000 });
    try {
      w.engine.createBot("Po");
      await setCalendar(w.engine, { address: url });
      setAheadSettings(w.engine, { enabled: true });

      // The switch (TodoBlocksSettings.tsx: put({ todoBlocks: checked })).
      assert.deepEqual(parseParams("ahead.settings.set", { todoBlocks: true }), { todoBlocks: true });
      let s = setAheadByPerson(w.engine, asServer("ahead.settings.set", { todoBlocks: true }));
      assert.equal(s.todoBlocks, true);
      assert.equal(w.engine.snapshot().ahead.todoBlocks, true);
      assert.equal(todoBlocksOn(w.engine), true);

      // Save on "How to schedule me" (put({ scheduling: draft.trim() })).
      const mine = "Mornings are for deep work. Small things after lunch.";
      s = setAheadByPerson(w.engine, asServer("ahead.settings.set", { scheduling: mine }));
      assert.equal(s.scheduling, mine);
      assert.equal(w.engine.snapshot().ahead.scheduling, mine);
      assert.equal(w.engine.snapshot().ahead.todoBlocks, true, "the switch is kept");

      // Spaces around are trimmed by the engine, not refused by the schema.
      s = setAheadByPerson(w.engine, asServer("ahead.settings.set", { scheduling: `  ${mine}\r\n` }));
      assert.equal(s.scheduling, mine);

      // Back to the default: empty, or the default text itself, leaves no text of their own.
      s = setAheadByPerson(w.engine, asServer("ahead.settings.set", { scheduling: "" }));
      assert.equal(s.scheduling, undefined);
      setAheadByPerson(w.engine, asServer("ahead.settings.set", { scheduling: mine }));
      s = setAheadByPerson(w.engine, asServer("ahead.settings.set", { scheduling: AHEAD_SCHEDULING_DEFAULT }));
      assert.equal(s.scheduling, undefined);

      // Too long: the engine's plain words, not the schema's silent no.
      const long = "x".repeat(AHEAD_SCHEDULING_MAX + 1);
      assert.throws(() => setAheadByPerson(w.engine, asServer("ahead.settings.set", { scheduling: long })), /under 600 characters/);
      assert.equal(parseParams("ahead.settings.set", { scheduling: "x".repeat(AHEAD_SCHEDULING_MAX * 4 + 1) }), undefined);
      assert.equal(parseParams("ahead.settings.set", { todoBlocks: "yes" }), undefined);

      // The switch off again.
      s = setAheadByPerson(w.engine, asServer("ahead.settings.set", { todoBlocks: false }));
      assert.equal(s.todoBlocks, false);
      assert.equal(todoBlocksOn(w.engine), false);

      // The rest of the window's Ahead settings, together with the new keys.
      const all = { enabled: true, workStart: "07:30", workEnd: "16:00", workDays: ["mon", "tue"], minutesPerDay: 90, todoBlocks: true, scheduling: mine };
      assert.deepEqual(parseParams("ahead.settings.set", all), all);
    } finally {
      w.engine.shutdown();
      await flow.close();
      w.store.close();
    }
  });
});
