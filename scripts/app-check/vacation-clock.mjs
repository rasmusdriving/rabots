// Preloaded only in the vacation check's temporary engine. Timers stay on real time.
import { readFileSync } from "node:fs";
const path = process.env.POBOTS_VACATION_CHECK_CLOCK;
if (path) Date.now = () => Number(readFileSync(path, "utf8"));
