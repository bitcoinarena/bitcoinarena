// Records the bot's input log on the prototype day into test/fixtures/log-prototype-bot.json with its result,
// so the tests pin the score of a fixed log (a rule change must bump GAME_VERSION and re-record). (kanban #3246)
import fs from "node:fs";
import { buildLevel, BOT_CONFIGS, botInput, recordLog, resultOf } from "../src/sim/index.js";
const day = JSON.parse(fs.readFileSync(new URL("../test/fixtures/prototype-day.json", import.meta.url)));
const L = buildLevel(day.candles, day.to | 0), cfg = { ...BOT_CONFIGS[0] };
const { log, W } = recordLog(L, (w) => botInput(w, cfg));
fs.writeFileSync(new URL("../test/fixtures/log-prototype-bot.json", import.meta.url), JSON.stringify({ seed: day.to | 0, log, result: resultOf(W) }) + "\n");
console.log(JSON.stringify(resultOf(W)));
