// kanban #2905: the canary's alert. Reads $CANARY_DIR/canary.jsonl after each run and tells the owner (Signal, through the Beelink) and the card
// when 2 counted rounds in a row failed (VOID with the bot expected, no signed result within 60 s, lock > 6 s, no entry, page down) or no
// round was played for 90 min (time inside a seat roll does not count). At most one alert an hour; one "wieder ok" when a round passes again.
// Usage: node canary-alert.mjs [--test]   --test (or CANARY_ALERT_TEST=1): the message goes only to the card, marked TEST, state untouched.
// Env: CANARY_DIR, CANARY_BEELINK (ssh target, default user@192.168.1.65), CANARY_CARD (default 2905)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const DIR = process.env.CANARY_DIR || `${homedir()}/arena-canary`;
const TEST = process.argv.includes('--test') || process.env.CANARY_ALERT_TEST === '1';
const BEE = process.env.CANARY_BEELINK || 'user@192.168.1.65', CARD = process.env.CANARY_CARD || '2905';
const HOUR = 3600000, STALE = 90 * 60000, now = Date.now();
const lines = (() => { try { return readFileSync(`${DIR}/canary.jsonl`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } })();
const stateFile = `${DIR}/alert-state.json`;
const state = (() => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { down: false, lastAlertAt: 0 }; } })();

const runs = lines.filter((r) => r.kind === 'rps' && !r.skip && r.tag !== 'measure-dry');
const counted = runs.filter((r) => r.countable !== false);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + 'Z';
const why = (r) => `${hhmm(Date.parse(r.at))} ${r.fail.join('+')}${r.round ? ' ' + r.round.slice(0, 8) : ''}${r.lockMs != null ? ` lock ${(r.lockMs / 1000).toFixed(1)}s` : ''}`;

// 1. two counted failures in a row
const last2 = counted.slice(-2);
const twoFailed = last2.length === 2 && last2.every((r) => !r.ok);
// 2. no played round for 90 min: from the last ok round (or the first run) to now, minus time spent skipped in a roll
const lastOk = [...counted].reverse().find((r) => r.ok);
const since = lastOk ? Date.parse(lastOk.at) : (lines.length ? Date.parse(lines[0].at) : now);
const rollSkips = lines.filter((r) => r.skip === 'roll' && Date.parse(r.at) > since).length;
const staleMs = now - since - rollSkips * 30 * 60000;
const stale = staleMs > STALE && counted.some((r) => Date.parse(r.at) > since);
const latest = counted[counted.length - 1];
const inRoll = lines.length && lines[lines.length - 1].skip === 'roll';

let msg = null, kind = null;
if (!inRoll && (twoFailed || stale)) {
  if (!state.down || now - (state.lastAlertAt || 0) >= HOUR) {
    kind = 'alert';
    msg = `#2905 Canary: Stein-Papier-Schere bezahlt geht nicht. ${twoFailed ? '2 Runden hintereinander fehlgeschlagen' : `seit ${Math.round((now - since) / 60000)} min keine gespielte Runde`}: `
      + counted.slice(-3).map(why).join('; ') + '. Log: MacBook ~/arena-canary/canary.jsonl';
  }
} else if (state.down && latest && latest.ok) {
  kind = 'recovered';
  msg = `#2905 Canary wieder ok: Runde ${latest.round ? latest.round.slice(0, 8) : ''} gespielt (${latest.result}), Lock ${(latest.lockMs / 1000).toFixed(1)} s, Ergebnis ${((latest.resultAfterCloseMs ?? latest.signedAfterCloseMs) / 1000).toFixed(0)} s nach Schluss.`;
}

const send = (target, text) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', BEE, 'python3', 'arena-canary/canary-beelink.py', ...target],
  { input: text, encoding: 'utf8', timeout: 60000 }).trim();

if (TEST) {
  const text = `TEST (Alarmweg, nicht an the owner): ` + (msg || `#2905 Canary: jetzt kein Alarm faellig (2 hintereinander fehlgeschlagen: ${twoFailed}, ohne gespielte Runde ${Math.round(staleMs / 60000)} min). Letzte Runden: ${counted.slice(-3).map(why).join('; ')}`);
  console.log('#2905 test -> card ' + CARD + ': ' + send(['card', CARD], text));
  process.exit(0);
}
if (!msg) { console.log(`#2905 no alert (twoFailed ${twoFailed}, stale ${Math.round(staleMs / 60000)} min, down ${!!state.down}, inRoll ${!!inRoll})`); process.exit(0); }
const out = [];
try { out.push(send(['signal'], msg)); } catch (e) { out.push('signal failed: ' + String(e.message).slice(0, 120)); }
try { out.push(send(['card', CARD], msg)); } catch (e) { out.push('card failed: ' + String(e.message).slice(0, 120)); }
if (kind === 'alert') { state.down = true; state.lastAlertAt = now; } else { state.down = false; state.recoveredAt = now; }
writeFileSync(stateFile, JSON.stringify(state));
console.log(`#2905 ${kind}: ${msg} | ${out.join(' | ')}`);
