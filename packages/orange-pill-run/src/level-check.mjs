// Orange Pill Run - the level check before a round opens (kanban #3247). The seed comes from the candles and
// the round id: seed_k = first 4 bytes of sha256(candles | roundId | k). The scripted players (sim/bot.js)
// run the level; when none reaches the flag, k goes up and the level is built again, up to 20 times.
// levelHash = sha256 of { v: GAME_VERSION, seed, candles }, published with the round so anyone can check the
// level was fixed before the first run.
import { createHash } from "node:crypto";
import { GAME_VERSION, buildLevel, botInput, BOT_CONFIGS, recordLog, runLog, resultOf } from "./sim/index.js";

const sha256 = (s) => createHash("sha256").update(s).digest();
export const MAX_TRIES = 20;

export function seedFor(candles, roundId, k) {
  const s = sha256(JSON.stringify(candles) + "|" + String(roundId) + "|" + k).readInt32BE(0);
  return s || 1;
}
export function levelHashOf(candles, seed, version = GAME_VERSION) {
  return sha256(JSON.stringify({ v: version, seed: seed | 0, candles })).toString("hex");
}

// the bots on one built level: the first config that reaches the flag, with its log checked by runLog
export function botsFinish(L) {
  const runs = [];
  for (const c of BOT_CONFIGS) {
    const cfg = { ...c }, { log, W } = recordLog(L, (w) => botInput(w, cfg));
    const rec = resultOf(W), rep = runLog(L, log);
    const same = rep.total === rec.total && rep.steps === rec.steps && rep.deaths === rec.deaths && rep.finished === rec.finished;
    runs.push({ bot: c.name, finished: rec.finished && same, total: rec.total, steps: rec.steps, deaths: rec.deaths, timeS: rec.timeS, presses: log.presses.length });
    if (rec.finished && same) return { ok: true, runs };
  }
  return { ok: false, runs };
}

// version = the round's pinned game version (kanban #3271: a round opened on opr-1 is checked and played on opr-1)
export function checkLevel(candles, roundId, { maxTries = MAX_TRIES, version = GAME_VERSION } = {}) {
  const attempts = [];
  for (let k = 0; k < maxTries; k++) {
    const seed = seedFor(candles, roundId, k), L = buildLevel(candles, seed, version), b = botsFinish(L);
    attempts.push({ k, seed, runs: b.runs });
    if (b.ok) { const levelHash = levelHashOf(candles, seed, version); return { ok: true, seed, tries: k + 1, levelHash, hash: levelHash, gameVersion: version, bot: b.runs[b.runs.length - 1], attempts }; }
  }
  return { ok: false, seed: null, tries: maxTries, levelHash: null, hash: null, gameVersion: version, attempts };
}
