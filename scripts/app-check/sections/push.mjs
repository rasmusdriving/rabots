// The app check, section "push": step 17, notifications through the check's own stand-in push service.
// Run it alone: node scripts/app-check.mjs --only=push
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  sleep,
  dataDir,
  check,
  relay,
  decryptAsBrowser,
  engineLog,
  cmd,
  js,
  shot,
  until,
  type,
  page,
  openWindow,
  run,
} from "../lib.mjs";

// 17. Notifications when Pobots is not open (docs/build/step-push.md), with a real bot on the
//     cheapest model and no real push service: the engine sends to the check's own relay. The check
//     plays a device (its own key pair and secret, a Google-looking address) and opens what the
//     relay got with its own keys.
//
//     Who is looking decides whether a push goes, so the check decides it itself: the real window
//     is taken to about:blank first, which closes its connection, and the engine drops a closed
//     window's presence at once. The check waits until the engine's log shows that no app is
//     connected but the check's own socket. From then on the only presence the engine has is what
//     that socket says (or nothing), so whether a headless page counts as focused plays no part.
//     The window comes back only after the last push, for the settings page.
export default async function section() {
  const { endpoint, cheap } = run;
  const p = await (async () => {
    const ws = new WebSocket(`${endpoint.url}?token=${endpoint.token}`);
    await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
    let n = 0;
    const waiting = new Map();
    const events = [];
    ws.on("message", (raw) => {
      const f = JSON.parse(String(raw));
      if (f.t === "res" && waiting.has(f.id)) (waiting.get(f.id)(f), waiting.delete(f.id));
      else if (f.t === "evt") events.push({ event: f.event, data: f.data });
    });
    const request = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = `p${++n}`;
        waiting.set(id, (f) => (f.ok ? resolve(f.result) : reject(Object.assign(new Error(f.error.message), { code: f.error.code }))));
        ws.send(JSON.stringify({ t: "req", id, method, params }));
      });
    await request("hello", { protocol: PROTOCOL_VERSION, client: "app-check push" });
    return { request, events, close: () => ws.close() };
  })();
  const waitFor = async (fn, ms, every = 200) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) return undefined;
      await sleep(every);
    }
  };
  const sleepUntil = (t) => sleep(Math.max(0, t - Date.now()));
  const httpBase17 = `http://127.0.0.1:${new URL(endpoint.url.replace(/^ws/, "http")).port}`;
  const cheapEffort = cheap.efforts.includes("low") ? "low" : cheap.defaultEffort;
  const botNow = async (id) => (await p.request("snapshot")).bots.find((b) => b.id === id);
  const resting = (b) => !!b && (b.state === "done" || b.state === "idle") && !b.helpers;
  // A turn the check started: first it must be seen working (unless it was, with a card), then at rest.
  const turnEnds = async (id, seenWorking = false) => {
    if (!seenWorking) await waitFor(async () => !resting(await botNow(id)), 20_000, 150);
    return waitFor(async () => resting(await botNow(id)) && Date.now(), 180_000, 250);
  };
  const nextCard = (from, botId, kind) => waitFor(() => p.events.slice(from).find((e) => e.event === "card.added" && e.data.card.botId === botId && e.data.card.kind === kind)?.data.card, 180_000, 100);
  const answerCard = (card) =>
    p.request("card.resolve", { cardId: card.id, decision: card.kind === "question" ? (card.choices?.length ? { type: "choice", choiceId: card.choices[0].id } : { type: "text", text: "Yes" }) : { type: "dismiss" } });
  const say = (botId, text) => p.request("message.send", { botId, text });
  // What "the person's window" says over the check's own socket. No deviceId: like the desktop
  // window, so only the rule "a window in front and used within 2 minutes" can hold a push back.
  const looking = () => p.request("notify.presence", { visible: true, focused: true, idleMs: 0 });
  const away = () => p.request("notify.presence", { visible: false, focused: false, idleMs: null });

  // The device: a P-256 key pair and a 16-byte secret made now, never written anywhere.
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const authSecret = randomBytes(16);
  const address = `https://fcm.googleapis.com/fcm/send/check-${randomBytes(12).toString("hex")}`;
  const keys = { p256dh: ua.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") };
  const LABEL = "Check browser on Mac";
  const plainOf = (got) => {
    try {
      return decryptAsBrowser(got.body, ua.getPrivateKey(), authSecret).toString("utf8");
    } catch (err) {
      return JSON.stringify({ unopened: err.message });
    }
  };
  const open = (got) => JSON.parse(plainOf(got));
  const toDevice = (from) => relay.got.slice(from).filter((g) => g.headers["x-push-address"] === address);

  const start = (await p.request("snapshot")).notify;
  check("push: the engine starts with needs and notes on, finished off, and no device", start?.kinds?.needs === true && start.kinds.note === true && start.kinds.finished === false && start.devices.length === 0 && /^[A-Za-z0-9_-]{80,90}$/.test(start.publicKey ?? ""), JSON.stringify(start?.kinds));
  const turnedOn = await p.request("notify.subscribe", { subscription: { endpoint: address, keys }, label: LABEL, asked: true });
  const deviceId = turnedOn.deviceId;
  const row = turnedOn.notify.devices.find((d) => d.id === deviceId);
  check("push: a Google address is turned on over the socket; the answer has the device's id, never its address or keys", !!row && row.service === "Google" && row.label === LABEL && !row.goneAt && ![address, keys.p256dh, keys.auth].some((s) => JSON.stringify(turnedOn).includes(s)), JSON.stringify(row));

  const pushBot = (await p.request("bot.create", { name: "Ping", purpose: "Asks short questions for the notification check", job: "Answer briefly. When you are asked to use one of your tools, use it exactly as asked.", model: cheap.id, effort: cheapEffort })).bot;
  const botId = pushBot.id;

  // The real window goes away: only the check's own socket is left connected.
  await cmd("Page.navigate", { url: "about:blank" });
  const sinceStart = () => {
    const all = engineLog.join("");
    return all.slice(all.lastIndexOf("Notifications go to a test relay"));
  };
  const connected = () => (sinceStart().match(/An app connected/g) ?? []).length - (sinceStart().match(/An app disconnected/g) ?? []).length;
  const alone = await waitFor(() => connected() === 1, 15_000, 100);
  check("push: the check's window is closed, so the engine hears about who is looking only from the check", !!alone, `${connected()} apps connected`);

  // 1. A window in front and just used: the bot asks, and nothing is sent.
  await looking();
  let from = p.events.length;
  let relayAt = relay.got.length;
  await say(botId, "Use your ask_human tool once to ask me exactly this question: Is the plovermint ready? Give the choices Yes and No. Wait for my answer, then reply with one short sentence.");
  const card1 = await nextCard(from, botId, "question");
  check("push: the bot asks with its ask_human tool and the question is a card", !!card1, card1 ? card1.title : "no card");
  if (card1) {
    await looking();
    await sleepUntil(Date.parse(card1.at) + 5_000 + 4_000);
    check("push: while a window is in front and was just used, nothing is sent (the 5 s wait plus 4 s)", relay.got.length === relayAt, `${relay.got.length - relayAt} sent`);
    await answerCard(card1);
  }
  await turnEnds(botId, !!card1);

  // 3 (run before 2, so that check 2's push and the two quiet minutes after it cannot hide it).
  //    Nobody looking, the card answered within the wait: nothing is sent.
  await away();
  from = p.events.length;
  relayAt = relay.got.length;
  await say(botId, "Use your ask_human tool once to ask me exactly this question: Shall I fetch the brindlecap? Give the choices Yes and No. Wait for my answer, then reply with one short sentence.");
  const card3 = await nextCard(from, botId, "question");
  if (card3) {
    await answerCard(card3);
    const answeredAfter = Date.now() - Date.parse(card3.at);
    await sleepUntil(Date.parse(card3.at) + 5_000 + 4_000);
    check("push: nobody looking, a card answered within the wait sends nothing", answeredAfter < 4_000 && relay.got.length === relayAt, `answered after ${answeredAfter} ms, ${relay.got.length - relayAt} sent`);
  } else check("push: the bot asks a second question on a card", false, "no card");
  await turnEnds(botId, !!card3);

  // 2. Nobody looking: the bot asks with a made-up word in its question; one push comes, and
  //    opened it holds the fixed words and not one word of the question.
  const RARE = "quorvantine";
  from = p.events.length;
  relayAt = relay.got.length;
  await say(botId, `Use your ask_human tool once to ask me exactly this question: Is the ${RARE} glimmering today? Give the choices Yes and No. Wait for my answer, then reply with one short sentence.`);
  const card2 = await nextCard(from, botId, "question");
  const question = card2 ? `${card2.title} ${card2.text ?? ""}` : "";
  check("push: the question on the card carries the made-up word", new RegExp(RARE, "i").test(question), question);
  if (card2) {
    const first = await waitFor(() => toDevice(relayAt)[0], Date.parse(card2.at) + 15_000 - Date.now(), 100);
    await sleep(3_000);
    const sent = toDevice(relayAt);
    const after = first ? first.at - Date.parse(card2.at) : -1;
    check("push: nobody looking, exactly one push reaches the relay for the device, after the 5 s wait and within 15 s", sent.length === 1 && relay.got.length === relayAt + 1 && after >= 4_900 && after <= 15_000, `${sent.length} to the device, ${relay.got.length - relayAt} in all, ${after} ms after the card`);
    if (first) {
      const h = first.headers;
      check("push: it is a POST with TTL, Urgency, Topic, Content-Encoding aes128gcm and a VAPID token", first.method === "POST" && h.ttl === "43200" && h.urgency === "high" && /^[A-Za-z0-9_-]{1,32}$/.test(h.topic ?? "") && h["content-encoding"] === "aes128gcm" && /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(h.authorization ?? ""), JSON.stringify({ ttl: h.ttl, urgency: h.urgency, topic: h.topic, encoding: h["content-encoding"] }));
      const msg = open(first);
      check(
        "push: opened with the device's own keys it says the bot needs an answer, in the fixed words, and leads to the bot",
        msg.v === 1 && msg.kind === "needs" && msg.title === "Ping needs your answer" && msg.body === "Open Pobots to answer." && msg.url === `/?bot=${botId}&open=needs` && msg.tag === `pobots-${botId}-needs`,
        JSON.stringify(msg),
      );
      // The whole opened message is searched: the made-up word, and every other word of four letters
      // or more of the question that the expected message does not hold by itself.
      const text = plainOf(first).toLowerCase();
      const expected = `v kind title body tag url botid needs ping needs your answer open pobots to answer. pobots-${botId}-needs /?bot=${botId}&open=needs`.toLowerCase();
      const words = [...new Set(question.toLowerCase().match(/[a-z]{4,}/g) ?? [])].filter((w) => !expected.includes(w));
      const leaked = words.filter((w) => text.includes(w));
      const extraFields = Object.keys(msg).filter((k) => !["v", "kind", "title", "body", "tag", "url", "botId"].includes(k));
      check("push: not one word of the question is in it", !text.includes(RARE) && words.includes(RARE) && leaked.length === 0 && extraFields.length === 0, leaked.length || extraFields.length ? `found: ${[...leaked, ...extraFields].join(", ")}` : `${words.length} words looked for: ${words.join(", ")}`);
    }
    await answerCard(card2);
  }
  await turnEnds(botId, !!card2);

  // 4. "Finished" on: a turn the person did not start (a webhook) sends nothing; a turn the person
  //    started sends one push, 15 s after the bot came to rest.
  const kindsNow = (await p.request("notify.setKinds", { kinds: { finished: true } })).notify.kinds;
  check("push: Finished is switched on, the other two stay on", kindsNow.finished === true && kindsNow.needs === true && kindsNow.note === true, JSON.stringify(kindsNow));
  const hook17 = (await p.request("trigger.save", { botId, trigger: { kind: "webhook", name: "Push check", prompt: "Reply with only the word ok.", where: "main", enabled: true } })).trigger;
  const { hookPath: hookPath17 } = await p.request("trigger.address", { triggerId: hook17.id });
  relayAt = relay.got.length;
  const woke = await fetch(`${httpBase17}${hookPath17}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: 1 }) });
  const run17 = await waitFor(async () => {
    const r = (await p.request("trigger.runs", { triggerId: hook17.id })).runs[0];
    return r && r.status !== "running" ? r : undefined;
  }, 180_000, 500);
  await waitFor(async () => resting(await botNow(botId)), 30_000, 250);
  await sleep(15_000 + 5_000);
  check("push: a turn the person did not start (a webhook) sends no Finished", woke.status === 202 && run17?.status === "done" && relay.got.length === relayAt, `${woke.status}, run ${run17?.status}, ${relay.got.length - relayAt} sent`);

  relayAt = relay.got.length;
  await say(botId, "Reply with the single word ok.");
  const restAt = await turnEnds(botId);
  const done = restAt ? await waitFor(() => toDevice(relayAt)[0], 15_000 + 10_000, 100) : undefined;
  await sleep(3_000);
  const doneAfter = done && restAt ? done.at - restAt : -1;
  check("push: a turn the person started ends, and exactly one push comes, 15 s after the bot came to rest", !!done && toDevice(relayAt).length === 1 && relay.got.length === relayAt + 1 && doneAfter >= 14_000, `${toDevice(relayAt).length} sent, ${doneAfter} ms after rest`);
  if (done) {
    const msg = open(done);
    check(
      "push: it says the bot finished, in the fixed words, and leads to its chat",
      msg.kind === "finished" && msg.title === "Ping finished" && msg.body === "Open Pobots to read the answer." && msg.url === `/?bot=${botId}&open=chat` && msg.tag === `pobots-${botId}-finished` && done.headers.ttl === "3600" && done.headers.urgency === "normal",
      JSON.stringify(msg),
    );
  }

  // 5. The relay answers 410 once: the device is gone, keeps its row, and gets nothing more.
  relay.answers.push(410);
  from = p.events.length;
  relayAt = relay.got.length;
  await say(botId, "Use your notify_human tool once with the title Check note and the text Nothing to do here. Then reply with one short sentence.");
  const note = await nextCard(from, botId, "note");
  check("push: the bot sends a note with its notify_human tool", !!note, note ? note.title : "no note");
  const refused = note ? await waitFor(() => toDevice(relayAt)[0], Date.parse(note.at) + 15_000 - Date.now(), 100) : undefined;
  const goneEvent = await waitFor(() => p.events.slice(from).find((e) => e.event === "notify.changed" && e.data.notify.devices.some((d) => d.id === deviceId && d.goneAt)), 10_000, 100);
  const goneRow = goneEvent?.data.notify.devices.find((d) => d.id === deviceId);
  check(
    "push: the note's push is answered 410, and notify.changed shows the device gone, its row kept, without address or keys",
    !!refused && open(refused).kind === "note" && open(refused).title === "Ping sent you a note" && !!goneRow?.goneAt && goneRow.label === LABEL && ![address, keys.p256dh, keys.auth].some((s) => JSON.stringify(goneEvent).includes(s)),
    JSON.stringify(goneRow ?? null),
  );
  if (note) await answerCard(note);
  await turnEnds(botId, !!note);
  relayAt = relay.got.length;
  const tried = await p.request("notify.test", { deviceId }).then(
    () => "sent",
    (e) => e.code,
  );
  const stillHere = await p.request("notify.subscribe", { subscription: { endpoint: address, keys }, label: LABEL, asked: false }).then(
    () => "kept",
    (e) => e.code,
  );
  const rowNow = (await p.request("snapshot")).notify.devices.find((d) => d.id === deviceId);
  check("push: a test to the gone device is refused, and the page saying still here does not bring it back", tried === "conflict" && stillHere === "conflict" && !!rowNow?.goneAt && relay.got.length === relayAt, `test: ${tried}, still here: ${stillHere}, gone: ${!!rowNow?.goneAt}`);
  // A note and a finished turn of another bot, which has no two quiet minutes running: nothing goes.
  from = p.events.length;
  await say("kaja", "Use your notify_human tool once with the title Second check note and the text Nothing to do here. Then reply with one short sentence.");
  const note2 = await nextCard(from, "kaja", "note");
  await turnEnds("kaja", !!note2);
  await sleep(15_000 + 5_000);
  check("push: after that nothing more is sent to it, not for another bot's note nor for its finished turn", !!note2 && relay.got.length === relayAt, `${note2 ? "note seen" : "no note"}, ${relay.got.length - relayAt} sent`);
  if (note2) await answerCard(note2);

  // 6. The real window: Pobots settings starts with Notifications, which shows the device's row and
  //    the switches as the engine has them.
  const engineNotify = (await p.request("snapshot")).notify;
  await openWindow(endpoint);
  await until(`!!document.querySelector(".pb-foot-settings")`, 20_000);
  await js(`document.querySelector(".pb-foot-settings").click()`);
  const shownPage = await until(
    `(() => {
      const first = document.querySelector(".app-appsettings .pb-appsettings-section");
      const row = document.querySelector('.pb-notify-device[data-id=${JSON.stringify(deviceId)}]');
      if (!first || !row) return null;
      return {
        first: first.dataset.section,
        title: first.querySelector(".pb-section-title")?.textContent.trim(),
        label: row.querySelector(".pb-notify-device-label")?.textContent,
        gone: row.hasAttribute("data-gone"),
        line: row.querySelector(".pb-notify-device-line")?.textContent ?? "",
        kinds: Object.fromEntries([...document.querySelectorAll(".pb-notify .pb-switch")].map((s) => [s.dataset.kind, s.checked])),
      };
    })()`,
    15_000,
  );
  check("push: Pobots settings opens with Notifications as its first section", shownPage?.first === "notify" && shownPage.title === "Notifications", JSON.stringify(shownPage && { first: shownPage.first, title: shownPage.title }));
  check(
    "push: it shows the device's row as stopped and the switches as the engine has them",
    !!shownPage && shownPage.label === LABEL && shownPage.gone && /^Stopped working/.test(shownPage.line) && JSON.stringify(shownPage.kinds) === JSON.stringify({ needs: engineNotify.kinds.needs, note: engineNotify.kinds.note, finished: engineNotify.kinds.finished }),
    JSON.stringify(shownPage && { line: shownPage.line, kinds: shownPage.kinds }),
  );
  await shot("54-push-settings");

  // 7. Nowhere in the engine's log, the events, the snapshot or the page is the device's address or a key.
  let vapidPrivate = "";
  try {
    vapidPrivate = JSON.parse(readFileSync(join(dataDir, "push", "vapid.json"), "utf8")).privateKey ?? "";
  } catch {}
  const secrets = { address, "address path": address.split("/").pop(), p256dh: keys.p256dh, "part of p256dh": keys.p256dh.slice(20, 50), auth: keys.auth, "engine's private key": vapidPrivate };
  const places = { log: engineLog.join(""), events: JSON.stringify(p.events), snapshot: JSON.stringify(await p.request("snapshot")), page: String(await js(`document.documentElement.outerHTML`)) };
  const found = Object.entries(secrets).flatMap(([what, s]) => (s ? Object.entries(places).filter(([, text]) => text.includes(s)).map(([where]) => `${what} in ${where}`) : [`${what} missing`]));
  check("push: nowhere in the engine's log, the events, the snapshot or the page is the device's address, its keys or the engine's private key", found.length === 0, found.join("; ") || `${p.events.length} events, ${places.log.length} characters of log`);
  check("push: everything the relay got was a POST for the check's device, three in all", relay.got.length === 3 && relay.got.every((g) => g.method === "POST" && g.headers["x-push-address"] === address), `${relay.got.length} requests`);
  p.close();
}
