// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * THE HEALTH WATCHER'S LOOK AT THE TEST BOTS AND THE TESTNET LNDS (kanban #3893). Measured 2026-11-27: LND A and B stopped cleanly at 06:07Z,
 * the RPS opponent bot's top-ups failed from then on, it ran out at 16:32Z, and nobody was told - the canary saw "void" for three hours.
 *
 * Each pass: the testnet LND units (systemctl --user), and each bot's DIR/balance.json (written by the bot every 30 s, read over ssh).
 *   lnd-down:<unit>   a testnet LND not active on HW_CONFIRM_PASSES passes in a row (Restart=always brings a crash back; this is the rest)
 *   bot-topup:<name>  a bot below its threshold whose top-ups failed for HW_BOT_FAIL_MIN minutes (none worked since)
 *   bot-stale:<name>  its balance file older than HW_BOT_STALE_MIN minutes, or unreadable (the bot is not running)
 * The alerts go the watcher's usual way (new, again at most every HW_REPEAT_MIN = 60 min, resolved) and, for these keys, to Signal too.
 *
 *   HW_TESTNET_LNDS=lnd-testnet,lnd-testnet4-b,arena-gw-c-lnd   HW_BOTS=<name>=<ssh host>:<balance.json path>,...   ('-' as host: this machine)
 *   HW_BOT_FAIL_MIN=10  HW_BOT_STALE_MIN=15  HW_SIGNAL_URL=http://127.0.0.1:8080/api/v1/rpc  HW_SIGNAL_TO_FILE=<file with the number>
 */
export const BOT_KEYS = /^(lnd-down|bot-topup|bot-stale):/;

export function botsConfig(env = process.env) {
  const n = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    lnds: list(env.HW_TESTNET_LNDS != null ? env.HW_TESTNET_LNDS : 'lnd-testnet,lnd-testnet4-b,arena-gw-c-lnd').map((u) => (u.endsWith('.service') ? u : `${u}.service`)),
    bots: list(env.HW_BOTS).map((b) => { const [name, rest] = [b.slice(0, b.indexOf('=')), b.slice(b.indexOf('=') + 1)]; const i = rest.indexOf(':'); return { name, host: rest.slice(0, i), path: rest.slice(i + 1) }; }).filter((b) => b.name && b.path),
    failMs: n('HW_BOT_FAIL_MIN', 10) * 60000,
    staleMs: n('HW_BOT_STALE_MIN', 15) * 60000,
    signal: { url: env.HW_SIGNAL_URL || 'http://127.0.0.1:8080/api/v1/rpc', toFile: env.HW_SIGNAL_TO_FILE || null },
  };
}

/** The facts: { lnds: { unit: { active } }, bots: [{ name, ok, body | why }] } */
export async function gatherBots(io, bc) {
  const lnds = bc.lnds.length ? await io.units(bc.lnds) : {};
  const bots = [];
  for (const b of bc.bots) {
    try { bots.push({ name: b.name, ok: true, body: JSON.parse(await io.readBotFile(b)) }); } catch (e) { bots.push({ name: b.name, ok: false, why: String(e.message || e).slice(0, 160) }); }
  }
  return { lnds, bots };
}

const hm = (ms) => new Date(Number(ms)).toISOString().slice(11, 16);
const sat = (msat) => Math.floor(Number(msat || 0) / 1000);

/** The problems (pure). `streak` is the watcher's kept per-key pass count. */
export function botProblems(bf, streak, bc, cfg, nowMs) {
  const out = [];
  for (const unit of bc.lnds) {
    const u = bf.lnds[unit], key = `lnd-down:${unit.replace(/\.service$/, '')}`;
    if (!u) continue;   // not known this pass (systemctl did not answer): neither down nor up
    if (u.active === 'active') { delete streak[key]; continue; }
    streak[key] = (streak[key] || 0) + 1;
    out.push({ key, ticket: '3893', title: `testnet ${unit.replace(/\.service$/, '')} is ${u.active}${u.sub ? `/${u.sub}` : ''}`, lines: ['bot top-ups and the faucet pay through it'],
      tried: ['nothing (Restart=always restarts a crash; a stop was by hand)'], needs: `systemctl --user start ${unit}`, alert: streak[key] >= cfg.confirm });
  }
  for (const b of bf.bots) {
    const stale = `bot-stale:${b.name}`, broke = `bot-topup:${b.name}`;
    const at = b.ok ? Date.parse(b.body.at) : NaN;
    if (!b.ok || !(nowMs - at < bc.staleMs)) {
      out.push({ key: stale, ticket: '3893', title: `${b.name} bot: no balance report ${b.ok ? `since ${hm(at)} UTC` : `(${b.why})`}`, lines: [], tried: ['nothing'], needs: 'the bot checked (is it running?)', alert: true });
      continue;
    }
    const low = Object.entries(b.body.balanceMsat || {}).filter(([, m]) => sat(m) < Number(b.body.belowSat || 0));
    const fail = b.body.lastFail ? Date.parse(b.body.lastFail.at) : NaN, ok = b.body.lastOk ? Date.parse(b.body.lastOk.at) : NaN;
    const failing = Number.isFinite(fail) && !(ok > fail);
    // failing since: the first failure after the last success; the bot keeps only the last one, so the watcher keeps the first it saw
    const k = `bot-fail-since:${b.name}`;
    if (!(low.length && failing)) { delete streak[k]; continue; }
    if (!streak[k] || (ok > streak[k])) streak[k] = fail;
    if (nowMs - streak[k] < bc.failMs) continue;
    out.push({ key: broke, ticket: '3893', title: `${b.name} bot cannot top up (failing since ${hm(streak[k])} UTC)`,
      lines: [...low.map(([fed, m]) => `${fed}: ${sat(m)} sat (below ${b.body.belowSat})`), `last: ${String(b.body.lastFail.why || '').slice(0, 200)}`],
      tried: [`every gateway (${(b.body.gateways || []).length})`], needs: 'a working gateway LND and the faucet', alert: true });
  }
  return out;
}

/** A Signal message through the local signal-cli JSON-RPC (the owner's Signal); the number only from a file, never in code. */
export async function signalSend(bc, text, { fetchImpl = fetch, readFile } = {}) {
  if (!bc.signal.toFile) throw new Error('HW_SIGNAL_TO_FILE not set');
  const to = String(readFile(bc.signal.toFile)).trim();
  const r = await fetchImpl(bc.signal.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'send', params: { recipient: [to], message: text.slice(0, 1500) } }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`signal HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(`signal: ${String(j.error.message || j.error).slice(0, 120)}`);
}
