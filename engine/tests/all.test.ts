// Entry point for the model-free tests:  cd engine && node --test
//
// Node runs the TypeScript sources directly. The sources import each other as "./x.js" (what the
// type checker and the bundler expect), so this file first teaches Node to find "./x.ts" for a
// relative "./x.js" that does not exist, then loads the test files. Static imports would be
// resolved before the hook is in place, hence the dynamic imports below.
import { registerHooks } from "node:module";

process.env.POBOTS_LOG ??= "warn";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if ((specifier.startsWith(".") || specifier.startsWith("/")) && specifier.endsWith(".js")) {
        return nextResolve(specifier.slice(0, -3) + ".ts", context);
      }
      throw err;
    }
  },
});

await import("./envfile.spec.js");
await import("./config.spec.js");
await import("./store.spec.js");
await import("./bots.spec.js");
await import("./models.spec.js");
await import("./labels.spec.js");
await import("./engine.spec.js");
await import("./files.spec.js");
await import("./team.spec.js");
await import("./triggers.spec.js");
await import("./channels.spec.js");
await import("./channel-posts.spec.js");
await import("./context.spec.js");
await import("./helpers.spec.js");
await import("./working-helpers.spec.js");
await import("./waiting.spec.js");
await import("./stop.spec.js");
await import("./aside.spec.js");
await import("./artifacts.spec.js");
await import("./lock.spec.js");
await import("./server.spec.js");
await import("./push.spec.js");
await import("./notify.spec.js");
await import("./browser.spec.js");
await import("./webhooks.spec.js");
await import("./codex.spec.js");
await import("./gpt.spec.js");
await import("./fast.spec.js");
await import("./attachments.spec.js");
await import("./backup-format.spec.js");
await import("./backup.spec.js");
await import("./restore.spec.js");
await import("./steer.spec.js");
await import("./settings7.spec.js");
await import("./chat7.spec.js");
await import("./step7c-access.spec.js");
await import("./step7c-files.spec.js");
await import("./step7c-todos.spec.js");
await import("./sees.spec.js");
await import("./helper-sees.spec.js");
await import("./gpt-bot-sees.spec.js");
await import("./gpt-change-sees.spec.js");
await import("./workers.spec.js");
await import("./main-tools.spec.js");
await import("./sees-tools.spec.js");
await import("./bot-reach.spec.js");
await import("./task-managers.spec.js");
await import("./calendar.spec.js");
await import("./temp-cleanup.spec.js");
await import("./activity-log.spec.js");
await import("./helper-status.spec.js");
await import("./failed-words.spec.js");
await import("./cards-after-restart.spec.js");
await import("./card-questions.spec.js");
await import("./restored-waiting.spec.js");
await import("./lost-reply.spec.js");
await import("./first-start.spec.js");
await import("./gpt-titles.spec.js");
