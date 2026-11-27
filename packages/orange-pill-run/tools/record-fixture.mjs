// Records the bot's input log on the prototype day into test/fixtures/log-prototype-bot[-<version>].json with its result,
// so the tests pin the score of a fixed log (a rule change must bump GAME_VERSION and re-record). (kanban #3246)
// node tools/record-fixture.mjs [version]: opr-1 writes log-prototype-bot.json (kept as the opr-1 pin, kanban #3271),
// every later version log-prototype-bot-<version>.json.
import fs from "node:fs";
import { GAME_VERSION, buildLevel, BOT_CONFIGS, botInput, recordLog, resultOf } from "../src/sim/index.js";
const v = process.argv[2] || GAME_VERSION;
const day = JSON.parse(fs.readFileSync(new URL("../test/fixtures/prototype-day.json", import.meta.url)));
const L = buildLevel(day.candles, day.to | 0, v), cfg = { ...BOT_CONFIGS[0] };
const { log, W } = recordLog(L, (w) => botInput(w, cfg));
const name = v === "opr-1" ? "log-prototype-bot.json" : "log-prototype-bot-" + v + ".json";
fs.writeFileSync(new URL("../test/fixtures/" + name, import.meta.url), JSON.stringify({ seed: day.to | 0, log, result: resultOf(W) }) + "\n");
console.log(name, JSON.stringify(resultOf(W)));
