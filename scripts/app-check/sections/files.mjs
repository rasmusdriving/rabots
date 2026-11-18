// The app check, section "files": step 15, pictures and files in the chat, to a real Claude bot and a real GPT bot.
// Run it alone: node scripts/app-check.mjs --only=files
// What it shares with the other sections is in ../lib.mjs (step 1's bot and model in `run`). Moved
// out of app-check.mjs unchanged on 15 Nov 2026 (docs/build/step-split.md).
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pngSize, textPdf, wordPng } from "../../dev/attach-fixtures.mjs";
import {
  sleep,
  work,
  botsDir,
  check,
  sideChannel,
  cdp,
  cmd,
  js,
  shot,
  until,
  type,
  lastAnswer,
  headStatus,
  run,
} from "../lib.mjs";

// 15. Pictures and files in the chat (docs/build/step-files.md), in the real window through its real
//     file input and a paste event, to a real Claude bot and a real GPT bot on the cheapest models.
//     The window here is the desktop window's file page, so the upload is the cross-origin one with
//     the token (the page in a browser posts to its own origin; that path is not taken here).
export default async function section() {
  const { endpoint, cheap } = run;
  const side3 = await sideChannel(endpoint);
  const httpBase3 = `http://127.0.0.1:${new URL(endpoint.url.replace(/^ws/, "http")).port}`;
  // Codex is looked for while the engine starts: wait for its models (with --only=files this comes early).
  let snap15 = await side3.request("snapshot");
  for (let i = 0; i < 60 && !snap15.models.some((m) => m.harness === "codex") && !snap15.status.codex.problem; i++) {
    await sleep(500);
    snap15 = await side3.request("snapshot");
  }
  const cheap15 = snap15.models.find((m) => /haiku/.test(m.id)) ?? cheap;
  const gpt15 = snap15.models.find((m) => m.harness === "codex" && /luna/.test(m.id)) ?? snap15.models.find((m) => m.harness === "codex");
  check("files: Codex is ready with a GPT model to try", !!gpt15, snap15.status.codex.problem ?? gpt15?.label ?? "no GPT model");
  const low = (m) => (m.efforts.includes("low") ? "low" : m.defaultEffort);
  const fdir = join(work, "files");
  mkdirSync(fdir, { recursive: true });
  // A plain yellow picture with KIWI in black block letters, and a PDF with a code word.
  const kiwi = wordPng("KIWI");
  const kiwiSize = pngSize(kiwi);
  writeFileSync(join(fdir, "kiwi.png"), kiwi);
  writeFileSync(join(fdir, "code.pdf"), textPdf(["Pobots check", "The code word is lantern."]));
  writeFileSync(join(fdir, "big.pdf"), Buffer.alloc(101 * 1024 * 1024, 0x20));
  writeFileSync(join(fdir, "sample.dat"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 8, 7, 0, 0, 0, 1, 2]));
  await side3.request("bot.create", { name: "Pics", purpose: "Looks at pictures", job: "Answer briefly.", model: cheap15.id, effort: low(cheap15), access: "asks-first" });
  if (gpt15) await side3.request("bot.create", { name: "Gpics", purpose: "Looks at pictures on a GPT model", job: "Answer briefly.", model: gpt15.id, effort: low(gpt15), access: "asks-first" });

  const openBot15 = async (name) => {
    await until(`[...document.querySelectorAll(".app-row .pb-row-name")].some((n) => n.textContent === ${JSON.stringify(name)})`, 15_000);
    await js(`[...document.querySelectorAll(".app-row")].find((r) => r.querySelector(".pb-row-name")?.textContent === ${JSON.stringify(name)}).click()`);
    return !!(await until(`document.querySelector(".app-main")?.getAttribute("aria-label") === ${JSON.stringify(name)} && !!document.querySelector(".app-main textarea")`, 15_000));
  };
  // A reload of the page: waits for the new page, so nothing is read from the old one.
  const reload15 = async () => {
    await js(`window.__beforeReload = true`);
    await cmd("Page.reload");
    await until(`!window.__beforeReload && document.querySelectorAll(".app-row").length > 0`, 20_000);
  };
  const chips = `[...document.querySelectorAll(".app-main .pb-chip-file[data-chip]")].map((c) => ({ name: c.querySelector(".pb-chip-name").dataset.name, status: c.dataset.status, problem: c.title }))`;
  const pick = async (paths) => {
    const input = await cmd("Runtime.evaluate", { expression: `document.querySelector(".app-main .pb-attach-input")` });
    await cmd("DOM.setFileInputFiles", { objectId: input.result?.result?.objectId, files: paths });
  };
  const youCount = `document.querySelectorAll(".app-main .app-you").length`;
  const lastYou = `[...document.querySelectorAll(".app-main .app-you")].at(-1)`;
  // Waits for the bot to be done with an answer that passes `test`; a card in the rail ends the wait.
  const answer = async (test, ms = 180_000) => {
    await until(`(${headStatus}) !== "Done" && (${headStatus}) !== "Idle"`, 15_000);
    const r = await until(`(() => { if (document.querySelector(".pb-rail .pb-card")) return "card"; return (${headStatus}) === "Done" && ${test} ? "done" : ""; })()`, ms);
    return { r, text: String(await js(lastAnswer)) };
  };

  // To see the picture's box before the picture loads, its preview is held back until let go.
  const paused = [];
  const onPaused = (m) => {
    const msg = JSON.parse(String(m));
    if (msg.method === "Fetch.requestPaused") paused.push(msg.params.requestId);
  };
  cdp.on("message", onPaused);

  // A picture and a PDF to the Claude bot, picked with the add button (the real file input).
  check("files: the Claude bot opens", await openBot15("Pics"));
  await pick([join(fdir, "kiwi.png"), join(fdir, "code.pdf")]);
  const up1 = await until(`(() => { const c = ${chips}; return c.length === 2 && c.every((x) => x.status === "done") && c; })()`, 30_000);
  check("files: picking a picture and a PDF uploads both to the real engine", !!up1, JSON.stringify(await js(chips)));
  check("files: the chips show the names the engine gave back", up1?.[0]?.name === "kiwi.png" && up1?.[1]?.name === "code.pdf", JSON.stringify(up1));
  await shot("40-files-tray");
  await cmd("Fetch.enable", { patterns: [{ urlPattern: "*/api/attachments/*/preview*", requestStage: "Request" }] });
  await type("Two short lines, nothing else: first the word written in the picture, then the code word in the PDF.");
  const boxBefore = await until(
    `(() => { const p = ${lastYou}?.querySelector(".pb-picture"); const img = p?.querySelector("img"); if (!p || !img) return null; const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), loaded: img.complete && img.naturalWidth > 0, text: Math.round((${lastYou}.querySelector(".pb-msg-you")?.getBoundingClientRect().top ?? -1) - r.top) }; })()`,
    15_000,
  );
  await sleep(1500);
  const expectW = Math.round(kiwiSize.width * Math.min(1, 320 / Math.max(kiwiSize.width, kiwiSize.height)));
  const expectH = Math.round(kiwiSize.height * Math.min(1, 320 / Math.max(kiwiSize.width, kiwiSize.height)));
  check("files: the sent picture stands in a box of its final size before it loads", !!boxBefore && !boxBefore.loaded && paused.length > 0 && Math.abs(boxBefore.w - expectW) <= 1 && Math.abs(boxBefore.h - expectH) <= 1, JSON.stringify({ boxBefore, expectW, expectH, held: paused.length }));
  await shot("41-files-box-before-load");
  for (const requestId of paused.splice(0)) await cmd("Fetch.continueRequest", { requestId });
  await cmd("Fetch.disable");
  const boxAfter = await until(
    `(() => { const p = ${lastYou}?.querySelector(".pb-picture"); const img = p?.querySelector("img"); if (!img?.complete || !img.naturalWidth) return null; const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), loaded: true, text: Math.round((${lastYou}.querySelector(".pb-msg-you")?.getBoundingClientRect().top ?? -1) - r.top) }; })()`,
    15_000,
  );
  check("files: when it loads, neither the box nor the text under it moves", !!boxAfter && !!boxBefore && boxAfter.w === boxBefore.w && boxAfter.h === boxBefore.h && boxAfter.text === boxBefore.text, JSON.stringify({ boxBefore, boxAfter }));
  const claude1 = await answer(`/kiwi/i.test(${lastAnswer}) && /lantern/i.test(${lastAnswer})`);
  check("files: the Claude bot names the word in the picture and the code word in the PDF", claude1.r === "done", JSON.stringify(claude1.text).slice(0, 100));
  check("files: no card was asked for at Asks first", claude1.r !== "card" && !(await js(`!!document.querySelector(".pb-rail .pb-card")`)));
  await shot("42-files-claude-answer");

  // The picture opens large, at its own size, and closes again.
  await js(`${lastYou}.querySelector(".pb-picture").click()`);
  const large = await until(`(() => { const v = document.querySelector(".pb-picture-view"); const img = v?.querySelector(".pb-picture-large-full"); return img?.complete && img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight, name: v.getAttribute("aria-label") } : null; })()`, 15_000);
  check("files: the picture opens large, the full picture from the engine", !!large && large.w === kiwiSize.width && large.h === kiwiSize.height && large.name === "kiwi.png", JSON.stringify(large));
  await shot("43-files-large");
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  check("files: Escape closes it", !!(await until(`!document.querySelector(".pb-picture-view")`, 5_000)));

  // What the engine stored and serves, read with the window's own addresses.
  const pics = (await side3.request("snapshot")).bots.find((b) => b.id === "pics");
  const sent = (await side3.request("thread.read", { threadId: pics.mainThreadId })).items.filter((i) => i.kind === "user" && i.attachments?.length).at(-1);
  const [picA, pdfA] = sent?.attachments ?? [];
  check("files: the message holds both, with their places in the bot's folder", picA?.kind === "picture" && picA.width === kiwiSize.width && /^\.attachments\/\d{4}-\d{2}\/att_[a-z0-9_]+\/kiwi\.png$/.test(picA.path) && pdfA?.kind === "file" && existsSync(join(botsDir, "pics", pdfA.path)), JSON.stringify(sent?.attachments));
  const fileHref = String(await js(`${lastYou}.querySelector("a.pb-msg-file")?.href ?? ""`));
  const fileRes = fileHref ? await fetch(fileHref) : undefined;
  check("files: the PDF is a chip that downloads", /code\.pdf/.test(String(await js(`${lastYou}.querySelector("a.pb-msg-file")?.textContent`))) && fileRes?.status === 200 && /^attachment;/.test(fileRes.headers.get("content-disposition") ?? ""), `${fileRes?.status} ${fileRes?.headers.get("content-disposition")}`);

  // The same picture to the GPT bot, pasted into the message box; the PDF picked.
  if (gpt15) {
    check("files: the GPT bot opens", await openBot15("Gpics"));
    const pasted = await js(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(kiwi.toString("base64"))}), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], "image.png", { type: "image/png" })); const t = document.querySelector(".app-main .pb-composer textarea"); t.focus(); const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }); t.dispatchEvent(e); return e.defaultPrevented; })()`);
    await pick([join(fdir, "code.pdf")]);
    const up2 = await until(`(() => { const c = ${chips}; return c.length === 2 && c.every((x) => x.status === "done") && c; })()`, 30_000);
    check("files: a pasted picture is named as a screenshot and uploads", pasted === true && /^Screenshot \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.png$/.test(up2?.[0]?.name ?? ""), JSON.stringify(await js(chips)));
    await type("Two short lines, nothing else: first the background colour of the picture in one word, then the code word in the PDF.");
    const gpt1 = await answer(`/yellow/i.test(${lastAnswer}) && /lantern/i.test(${lastAnswer})`);
    check("files: the GPT bot names the picture's colour and the code word in the PDF", gpt1.r === "done", JSON.stringify(gpt1.text).slice(0, 100));
    check("files: no card was asked for at Asks first on the GPT bot either", gpt1.r !== "card" && !(await js(`!!document.querySelector(".pb-rail .pb-card")`)));
    await shot("44-files-gpt-answer");
  }

  // After a reload of the page the picture and the file chip are still there.
  await reload15();
  check("files: after a reload the Claude bot opens again", await openBot15("Pics"));
  const reloaded = await until(
    `(() => { const y = [...document.querySelectorAll(".app-main .app-you")].find((x) => x.querySelector(".pb-picture")); const img = y?.querySelector(".pb-picture img"); const r = y?.querySelector(".pb-picture")?.getBoundingClientRect(); return img?.complete && img.naturalWidth > 0 ? { w: Math.round(r.width), h: Math.round(r.height), file: y.querySelector("a.pb-msg-file")?.textContent ?? "" } : null; })()`,
    20_000,
  );
  check("files: after a reload the picture is there in its box, and the file chip too", !!reloaded && reloaded.w === boxBefore?.w && reloaded.h === boxBefore?.h && /code\.pdf/.test(reloaded.file), JSON.stringify(reloaded));
  await shot("45-files-after-reload");

  // A file that is gone from the Mac says so after a reload, and is no link.
  const pdfOnDisk = join(botsDir, "pics", pdfA?.path ?? "none");
  if (existsSync(pdfOnDisk)) {
    renameSync(pdfOnDisk, `${pdfOnDisk}.away`);
    await reload15();
    await openBot15("Pics");
    const gone = await until(`[...document.querySelectorAll(".app-main .pb-msg-file[data-missing]")].map((x) => x.textContent).join("|")`, 15_000);
    check("files: a file that is gone says so in the chat", /code\.pdf/.test(String(gone)) && /This file is no longer on the Mac\./.test(String(gone)), String(gone));
    renameSync(`${pdfOnDisk}.away`, pdfOnDisk);
  }

  // Too big: the words, and nothing is sent. Since step 7c a file of any kind is taken (sample.dat).
  await pick([join(fdir, "big.pdf"), join(fdir, "sample.dat")]);
  const refused = await until(`(() => { const c = ${chips}; return c.length === 2 && c[0].status === "refused" && c[1].status === "done" && c; })()`, 30_000);
  check("files: a file over 100 MB is refused with the words", refused?.[0]?.problem === "big.pdf is too big. A file can be up to 100 MB.", JSON.stringify(await js(chips)));
  check("files: a file of a kind Pobots does not read is taken (step 7c)", refused?.[1]?.status === "done", JSON.stringify(refused?.[1]));
  await shot("46-files-refused");
  const before15 = await js(youCount);
  await type("This must not be sent.");
  await sleep(2000);
  const itemsNow = (await side3.request("thread.read", { threadId: pics.mainThreadId })).items;
  check("files: with a refused file in the box nothing is sent", (await js(youCount)) === before15 && !itemsNow.some((i) => i.kind === "user" && /must not be sent/.test(i.text ?? "")));
  await js(`[...document.querySelectorAll(".app-main .pb-chip-remove")].forEach((b) => b.click())`);

  // Straight at the engine: the limit, HTML and SVG never inline, and no way in without the token.
  const T = `token=${encodeURIComponent(endpoint.token)}`;
  const post = (name, body, token = true) => fetch(`${httpBase3}/api/attachments?bot=pics&name=${encodeURIComponent(name)}${token ? `&${T}` : ""}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
  const tooBig = await post("huge.pdf", Buffer.alloc(100 * 1024 * 1024 + 1, 0x20));
  check("files: the engine itself refuses more than 100 MB", tooBig.status === 413 && (await tooBig.json()).error?.code === "too_large", String(tooBig.status));
  for (const [name, body] of [
    ["page.html", "<!doctype html><html><body><script>parent.postMessage('ran', '*')</script>hello</body></html>"],
    ["drawing.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>'],
  ]) {
    const up = await post(name, body);
    const a = up.status === 200 ? (await up.json()).attachment : undefined;
    const full = a ? await fetch(`${httpBase3}/api/attachments/${a.id}/full?${T}`) : undefined;
    const prev = a ? await fetch(`${httpBase3}/api/attachments/${a.id}/preview?${T}`) : undefined;
    check(
      `files: an uploaded ${name.split(".")[1].toUpperCase()} is a file, never served inline`,
      a?.kind === "file" && full?.status === 200 && /^attachment;/.test(full.headers.get("content-disposition") ?? "") && full.headers.get("content-type") === "application/octet-stream" && /sandbox/.test(full.headers.get("content-security-policy") ?? "") && full.headers.get("x-content-type-options") === "nosniff" && prev?.status === 404,
      `${up.status} ${a?.kind} | ${full?.status} ${full?.headers.get("content-type")} ${full?.headers.get("content-disposition")} | preview ${prev?.status}`,
    );
    if (a) await side3.request("attachment.discard", { id: a.id });
  }
  const noToken = await post("note.txt", "hello", false);
  const noTokenPrev = picA ? await fetch(`${httpBase3}/api/attachments/${picA.id}/preview`) : undefined;
  const noTokenFull = picA ? await fetch(`${httpBase3}/api/attachments/${picA.id}/full`) : undefined;
  const withToken = picA ? await fetch(`${httpBase3}/api/attachments/${picA.id}/full?${T}`) : undefined;
  check("files: without the token the upload is refused", noToken.status === 401, String(noToken.status));
  check("files: without the token the preview and the full picture are refused", noTokenPrev?.status === 401 && noTokenFull?.status === 401, `${noTokenPrev?.status} ${noTokenFull?.status}`);
  check("files: with it the picture is inline as a PNG", withToken?.status === 200 && withToken.headers.get("content-type") === "image/png" && /^inline;/.test(withToken.headers.get("content-disposition") ?? ""), `${withToken?.status} ${withToken?.headers.get("content-type")}`);

  cdp.off("message", onPaused);
  side3.close();
}
