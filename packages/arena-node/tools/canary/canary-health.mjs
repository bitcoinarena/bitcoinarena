// kanban #2905: one health line from the canary log, for the hourly check: rounds staked vs played/signed per hour (last 1 h and 24 h),
// median lock and result time, failures by kind, the last ok round and the alert state.
// Usage: node canary-health.mjs [log]   (default $CANARY_DIR/canary.jsonl)   e.g. from the Beelink: ssh user@192.168.1.226 '~/arena-canary/canary-health.sh'
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const DIR = process.env.CANARY_DIR || `${homedir()}/arena-canary`;
const file = process.argv[2] || `${DIR}/canary.jsonl`;
const all = (() => { try { return readFileSync(file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } })();
const now = Date.now();
const med = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const sec = (ms) => (ms == null ? '-' : (ms / 1000).toFixed(1) + 's');
const part = (h) => {
  const r = all.filter((x) => x.kind === 'rps' && now - Date.parse(x.at) <= h * 3600000);
  const runs = r.filter((x) => !x.skip), staked = runs.filter((x) => x.round), played = runs.filter((x) => x.played), ok = runs.filter((x) => x.ok);
  const fails = {}; for (const x of runs) for (const f of x.fail || []) fails[f] = (fails[f] || 0) + 1;
  const per = (n) => (n / h).toFixed(h === 1 ? 0 : 1);
  return `${h}h: ${per(staked.length)}/h staked, ${per(played.length)}/h played+signed (${staked.length ? Math.round((100 * played.length) / staked.length) : 0} %), ok ${ok.length}/${runs.length}`
    + `, lock med ${sec(med(staked.map((x) => x.lockMs)))}, result med ${sec(med(played.map((x) => x.resultAfterCloseMs ?? x.signedAfterCloseMs)))}`
    + (Object.keys(fails).length ? `, fails ${Object.entries(fails).map(([k, v]) => `${k} ${v}`).join(' ')}` : '')
    + (r.some((x) => x.skip) ? `, skipped ${r.filter((x) => x.skip).length}` : '');
};
const lastOk = [...all].reverse().find((x) => x.ok);
let alert = 'none'; try { const s = JSON.parse(readFileSync(`${DIR}/alert-state.json`, 'utf8')); alert = s.down ? `DOWN since alert ${new Date(s.lastAlertAt).toISOString().slice(11, 16)}Z` : 'up'; } catch {}
console.log(`#2905 canary rps | ${part(1)} | ${part(24)} | last ok ${lastOk ? Math.round((now - Date.parse(lastOk.at)) / 60000) + ' min ago' : 'never'} | alert ${alert}`);
