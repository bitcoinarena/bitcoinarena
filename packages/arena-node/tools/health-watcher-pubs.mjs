// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE HEALTH WATCHER'S ROUND PUBLICATIONS (kanban #759, 2026-10-28, the owner: "The transaction watcher needs to do tasks like this to make sure
 * that all of our rounds always get confirmed", then "public testnet4" - our publications must confirm on the PUBLIC chain - and "Also
 * increase the fees for the unconfirmed transactions"). Part of tools/health-watcher.mjs; importing it does nothing.
 *
 * TRACKED   every publication of ours that carries rounds: the duty postings of today and tomorrow (GET /duty: primary, backup, the
 *           emergency marker), the grids the seats read with rounds still ahead (GET /pending grids, GET /expected), the ops grids
 *           (~/blwp-testnet4/emergency-*.log "published" lines of the last 36 h), and their unconfirmed parents (up to 4 deep)
 * LOOKED    on two chains, each by its own bitcoind (no txindex: the mempool, and every new block scanned once for our txids):
 *           ours    the seats' branch (bitcoin-cli -datadir=/mnt/bitcoin/tn4 on the test host)
 *           public  public testnet4 through a public Esplora API (kanban #1124, 2026-11-04: the ssh node went behind a slow relay and the
 *                   watcher read nothing there for 6 h): HW_PUBLIC_ESPLORA, mempool.space then blockstream.info, every call HW_ESPLORA_MS
 *                   (8 s); a base that fails steps back for 10 min. The ssh bitcoind (HW_PUBLIC_HOST) is only the second source, read
 *                   when no Esplora base answers, HW_PUBLIC_SSH_S (60 s) at most; HW_PUBLIC_SSH=0 never.
 * REPLACED  (kanban #1124) a publication the public chain refuses as spent: the spender of its inputs (Esplora outspend) is read; one that
 *           carries the same OP_RETURN scripts IS the publication (the payload landed): it is tracked from then on and the replaced txid
 *           dropped - resolved, not alerted. A spender without the payload is alerted with that reason: the payload needs a new publication.
 * WHEN      (kanban #1124, the owner: "fuer wann die runde ist und fuer welche app") each line names the app and the time its rounds are for:
 *           the "ARN" 'S' series ids of its payload by GET /series (start + horizon), a grid's first window to last close, a duty
 *           posting's day, the "ARN" 'D' marker's day
 * FIXED     each behind a rate limit and rechecked on the next pass:
 *           - in no mempool and in no block of a chain: the raw tx (kept from where it was seen) sent to that chain, parents first
 *           - in our mempool and not on miner C's list: appended (the watcher's minerc-add)
 *           - unconfirmed on the public chain 2 blocks past ours or 30 min: CPFP - a child spending its change from the posting wallet, its
 *             fee lifting the package above the public going rate; never RBF (the seats know a series by its publication txid). The child
 *             goes to both chains (on ours it keeps the wallet from spending the change twice) and is tracked like the rest.
 *           - HW_PUBLIC_CONFIRM=1 with HW_PUBLIC_MINE_CMD: the public-chain mining step, run with the txids (the hook for the chain
 *             helper's miner; nothing mines on the public chain without it)
 * ALERTED   "round publication not confirmed", one line per tx: app, what it is for and when, txid8, our branch, public chain, minutes,
 *           and each fix tried with its time and answer ("rebroadcast 17:20Z ok", "CPFP 17:25Z refused: ...")
 */
const HEX64 = /^[0-9a-f]{64}$/;
const mins = (ms) => Math.round(ms / 60000);
const hm = (ms) => new Date(Number(ms)).toISOString().slice(11, 16);
const GAME = { updown: 'Up/Down', 'btc-updown-15m': 'Up/Down', updownGrid: 'Up/Down', rps: 'RPS', 'rock-paper-scissors': 'RPS', rpsGrid: 'RPS', nextblock: 'Next Block', nb90: 'Next Block', nbGrid: 'Next Block' };
const gameName = (g) => GAME[g] || g || '?';

export function pubsConfig(env = process.env, H = process.env.HOME || '/home/arena') {
  const n = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);
  return {
    oursCli: (env.HW_OURS_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli -datadir=/mnt/bitcoin/tn4').split(' '),
    publicHost: env.HW_PUBLIC_HOST || 'arena@198.51.100.106',
    publicCli: env.HW_PUBLIC_CLI || '$HOME/.arena-node/bitcoin-core/bitcoin-31.1/bin/bitcoin-cli -testnet4 -datadir=$HOME/.arena-node/bitcoin-testnet4',
    wallet: env.HW_POSTING_WALLET || 'blwp-tn4-bonds',
    opsDir: env.HW_OPS_LOG_DIR || `${H}/blwp-testnet4`,
    scanBack: n('HW_SCAN_BACK', 300), scanMax: n('HW_SCAN_MAX', 320),
    sourceMs: n('HW_PUB_SOURCE_H', 36) * 3600000, keepMs: n('HW_PUB_KEEP_H', 48) * 3600000,
    publicBlocks: n('HW_PUBLIC_BLOCKS', 2), publicMs: n('HW_PUBLIC_MIN', 30) * 60000, oursBlocks: n('HW_OURS_BLOCKS', 2),
    resendMs: n('HW_RESEND_MIN', 30) * 60000,
    cpfp: env.HW_CPFP !== '0', cpfpGapMs: n('HW_CPFP_GAP_MIN', 60) * 60000, cpfpMax: n('HW_CPFP_MAX_BUMPS', 2),
    cpfpRate: n('HW_CPFP_RATE', 2), cpfpMaxSat: n('HW_CPFP_MAX_SAT', 5000), childVsize: 110, dust: 330,
    esplora: (env.HW_PUBLIC_ESPLORA != null ? env.HW_PUBLIC_ESPLORA : 'https://mempool.space/testnet4/api,https://blockstream.info/testnet4/api').split(/[\s,]+/).filter(Boolean),
    esploraMs: n('HW_ESPLORA_MS', 8000), publicSsh: env.HW_PUBLIC_SSH !== '0', publicSshMs: n('HW_PUBLIC_SSH_S', 60) * 1000,
    publicConfirm: env.HW_PUBLIC_CONFIRM === '1', publicMineCmd: env.HW_PUBLIC_MINE_CMD || null, publicMineGapMs: n('HW_PUBLIC_MINE_GAP_MIN', 30) * 60000,
  };
}

// ---------------------------------------------------------------- SOURCES: what carries rounds now
/** Every publication of ours with rounds still to come: [{ txid, game, source, atMs? }]. */
export function pubSources({ duty = [], pending = [], expected = [], ops = [], nowMs, sourceMs = 36 * 3600000 }) {
  const out = new Map();
  // when: [from, to] ms the rounds it carries are for (kanban #1124) - a grid's first window to its last close, a duty posting's day
  const add = (txid, game, source, atMs = null, when = null) => { if (!HEX64.test(txid || '')) return; const w = out.get(txid);
    if (!w) out.set(txid, { txid, game: gameName(game), source, atMs, when }); else { if (atMs && (!w.atMs || atMs < w.atMs)) w.atMs = atMs; if (!w.when && when) w.when = when; } };
  const gridWhen = (g) => (Number(g.lastCloseMs) > 0 ? [Number(g.firstWindowMs || g.firstCloseMs) || null, Number(g.lastCloseMs)] : null);
  const best = duty.slice().sort((a, b) => cnt(b) - cnt(a))[0];
  for (const day of (best && best.days) || []) { const d0 = Date.parse(`${day.covers}T00:00:00Z`);
    for (const a of day.apps || []) for (const p of a.postings || []) add(p.txid, a.app || a.name, `duty ${day.covers.slice(5)} ${a.role}${p.emergency ? ' emergency' : ''}`, null, d0 ? [d0, d0 + 86400000] : null); }
  for (const b of pending) for (const g of (b && b.grids) || []) if (Number(g.lastCloseMs) > nowMs && g.publication) add(g.publication.txid, g.game, 'grid', null, gridWhen(g));
  for (const b of expected) for (const e of (b && b.expected) || []) if (Number(e.lastCloseMs) > nowMs && e.publication) add(e.publication.txid, e.game, 'expected', null, gridWhen(e));
  for (const o of ops) if (nowMs - o.atMs <= sourceMs) add(o.txid, o.game, 'ops grid', o.atMs);
  return [...out.values()];
}
const cnt = (d) => (d.days || []).reduce((s, x) => s + (x.apps || []).reduce((y, a) => y + (a.postings || []).length, 0), 0);
/** The ops logs' published grids: lines {"at":..., "<grid>":"published","txid":...}. */
export function opsPublished(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    if (!l.includes('"published"')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const game = Object.keys(j).find((k) => j[k] === 'published');
    if (HEX64.test(j.txid || '')) out.push({ txid: j.txid, game, atMs: Date.parse(j.at) || 0 });
  }
  return out;
}

// ---------------------------------------------------------------- THE READ: both chains, through io.chainLook / io.chainCalls / io.publicHttp
/** Reads both chains for the tracked txids (and fetches the raw tx of any not kept yet). Adds f.pubSources, f.chains, f.raw, f.replaced. */
export async function gatherPubs(io, pc, prev, f) {
  f.pubSources = pubSources({ duty: f.duty, pending: f.pending, expected: f.expected || [], ops: io.opsPublished ? await io.opsPublished() : [], nowMs: f.nowMs, sourceMs: pc.sourceMs });
  const kept = (prev && prev.pubs) || {}, gone = (prev && prev.replaced) || {};
  const txids = [...new Set([...Object.keys(kept), ...f.pubSources.map((s) => s.txid)])].filter((t) => !gone[t]);
  f.chains = {}; f.raw = {}; f.replaced = {};
  if (!txids.length) return;
  const web = io.publicHttp && pc.esplora && pc.esplora.length ? io.publicHttp : null;
  for (const chain of ['ours', 'public']) {
    // the public chain: Esplora first (kanban #1124); the ssh bitcoind only when no Esplora base answers
    let webErr = null;
    if (chain === 'public' && web) {
      try { const a = await esploraLook(web, txids); f.chains.public = { ...a, stale: [], to: a.tip, known: txids, via: 'esplora', authoritative: true }; continue; }
      catch (e) { webErr = e.message; if (!pc.publicSsh || !io.chainLook) { f.chains.public = { error: `esplora: ${webErr}` }; continue; } }
    }
    const sc = prev && prev.scan && prev.scan[chain];
    const known = new Set((sc && sc.known) || []), fresh = txids.filter((t) => !known.has(t));
    try {
      const a = await io.chainLook(chain, { txids, from: sc ? sc.to + 1 : null, back: pc.scanBack, max: pc.scanMax, verify: sc ? Object.entries(sc.found || {}).map(([, v]) => v) : [] });
      // txids new to this chain: their blocks may be behind the scan - looked for once from scanBack
      const b = sc && fresh.length ? await io.chainLook(chain, { txids: fresh, from: null, back: pc.scanBack, max: pc.scanBack + 1, verify: [] }) : null;
      f.chains[chain] = { tip: a.tip, mem: a.mem, found: [...a.found, ...(b ? b.found : [])], stale: a.stale, to: a.scannedTo, known: txids, via: webErr ? 'ssh' : undefined };
    } catch (e) { f.chains[chain] = { error: webErr ? `esplora: ${webErr}; ssh: ${e.message}` : e.message }; }
  }
  // the raw tx of each tracked one not kept yet, from a chain that has it (ours first: it has the fee and the posting wallet)
  const need = txids.filter((t) => !(kept[t] && kept[t].hex));
  for (const chain of ['ours', 'public']) {
    const c = f.chains[chain]; if (!c || c.error) continue;
    const where = need.filter((t) => !f.raw[t] && (c.mem.includes(t) || c.found.some((x) => x.txid === t)));
    if (!where.length) continue;
    const res = await io.chainCalls(chain, where.map((t) => { const x = c.found.find((y) => y.txid === t); return ['getrawtransaction', t, '2', ...(x ? [x.hash] : [])]; }));
    where.forEach((t, i) => { if (res[i] && res[i].ok) { try { f.raw[t] = rawOf(JSON.parse(res[i].out)); } catch { /* not JSON */ } } });
  }
  // REPLACED (kanban #1124): a kept one the public chain does not have - who spent its inputs there, and does that tx carry its payload?
  const pub = f.chains.public;
  if (!web || !pub || pub.error || pub.via !== 'esplora') return;
  const look = txids.filter((t) => kept[t] && kept[t].hex && !kept[t].replacedBy && !pub.mem.includes(t) && !pub.found.some((x) => x.txid === t) && !(pub.unread || []).includes(t)).slice(0, 8);
  for (const t of look) {
    let prevouts = kept[t].prev;
    if (!prevouts) {   // kept before #1124: its inputs read from the raw tx by our own bitcoind
      const [d] = await io.chainCalls('ours', [['decoderawtransaction', kept[t].hex]]);
      try { prevouts = JSON.parse(d.out).vin.filter((v) => v.txid).map((v) => [v.txid, v.vout]); f.raw[t] = { ...(f.raw[t] || {}), prev: prevouts }; } catch { continue; }
    }
    const mine = payloadOf(kept[t].vout);
    for (const [ptx, n] of prevouts) {
      const o = await web('GET', `/tx/${ptx}/outspend/${n}`);
      let j; try { j = JSON.parse(o.text); } catch { continue; }
      if (!o.ok || !j.spent || !HEX64.test(j.txid || '') || j.txid === t) continue;
      const by = j.txid, st = j.status || {};
      const [tx, hex] = [await web('GET', `/tx/${by}`), await web('GET', `/tx/${by}/hex`)];
      let raw = null; try { raw = rawOf(esploraTx(JSON.parse(tx.text), hex.ok ? hex.text.trim() : null)); } catch { /* unread */ }
      if (!raw) continue;
      const theirs = payloadOf(raw.vout);
      f.replaced[t] = { by, input: `${ptx.slice(0, 8)}:${n}`, confirmed: !!st.confirmed, h: st.block_height ?? null, hash: st.block_hash ?? null,
        same: mine.length > 0 && mine.every((x) => theirs.includes(x)), raw };
      break;
    }
  }
}
/** A bitcoind getrawtransaction verbose answer, as kept: hex, vsize, fee (sat), inputs, outputs. */
export function rawOf(j) {
  return { hex: j.hex, vsize: j.vsize, fee: j.fee != null ? Math.round(j.fee * 1e8) : null, vin: (j.vin || []).filter((v) => v.txid).map((v) => v.txid),
    prev: (j.vin || []).filter((v) => v.txid).map((v) => [v.txid, v.vout]),
    vout: (j.vout || []).map((o) => ({ n: o.n, sat: Math.round(o.value * 1e8), spk: o.scriptPubKey && o.scriptPubKey.hex, address: o.scriptPubKey && o.scriptPubKey.address })) };
}
/** A tx's OP_RETURN scripts (hex): its payload - what a replacement must carry to count as the same publication. */
export const payloadOf = (vout) => (vout || []).map((o) => String(o.spk || '')).filter((x) => x.startsWith('6a'));

// ---------------------------------------------------------------- THE PUBLIC CHAIN BY ESPLORA (kanban #1124)
/** Each tracked txid's status on the public chain: { tip, mem, found, unread }; throws when no base gives the tip. */
export async function esploraLook(http, txids) {
  const t = await http('GET', '/blocks/tip/height');
  const tip = Number(String(t.text || '').trim());
  if (!t.ok || !Number.isInteger(tip)) throw new Error(`no tip (${String(t.text || t.status).slice(0, 60)})`);
  const r = { tip, mem: [], found: [], unread: [] };
  for (let i = 0; i < txids.length; i += 5) {
    await Promise.all(txids.slice(i, i + 5).map(async (x) => {
      const s = await http('GET', `/tx/${x}/status`);
      if (s.status === 404) return;                     // the chain and its mempool do not know it
      let j = null; try { j = JSON.parse(s.text); } catch { /* no */ }
      if (!s.ok || !j) { r.unread.push(x); return; }
      if (j.confirmed) r.found.push({ txid: x, h: j.block_height, hash: j.block_hash }); else r.mem.push(x);
    }));
  }
  return r;
}
/** An Esplora tx (JSON, sat) as bitcoind's getrawtransaction verbose answer (BTC). */
export function esploraTx(j, hex) {
  return { txid: j.txid, hex, vsize: Math.ceil(Number(j.weight) / 4), fee: j.fee != null ? j.fee / 1e8 : null, confirmed: !!(j.status && j.status.confirmed),
    vin: (j.vin || []).filter((v) => !v.is_coinbase).map((v) => ({ txid: v.txid, vout: v.vout })),
    vout: (j.vout || []).map((o, n) => ({ n, value: o.value / 1e8, scriptPubKey: { hex: o.scriptpubkey, address: o.scriptpubkey_address } })) };
}
/** The bitcoin-cli calls the watcher makes on the public chain, answered by Esplora: { ok, out, err } each, as parseCalls gives them.
 * Throws only when no base answered any of them (the caller may then ask the ssh bitcoind). */
export async function esploraCalls(http, calls) {
  let answered = 0;
  const get = async (path) => { const r = await http('GET', path); if (r.status) answered++; return r; };
  const ok = (out) => ({ ok: true, out: typeof out === 'string' ? out : JSON.stringify(out) }), no = (err) => ({ ok: false, out: '', err: String(err || 'refused').trim() });
  const txOf = async (t) => { const r = await get(`/tx/${t}`); if (!r.ok) return null; try { return JSON.parse(r.text); } catch { return null; } };
  const send = async (hex) => { const r = await http('POST', '/tx', hex); if (r.status) answered++; return r.ok ? ok(String(r.text).trim()) : no(esploraErr(r.text)); };
  const out = [];
  for (const c of calls) {
    const [name, ...a] = c.filter((x) => !String(x).startsWith('-rpcwallet='));
    if (name === 'getrawtransaction') {
      const j = await txOf(a[0]); const h = j ? await get(`/tx/${a[0]}/hex`) : null;
      out.push(j && h && h.ok ? ok(esploraTx(j, String(h.text).trim())) : no('No such mempool or blockchain transaction'));
    } else if (name === 'sendrawtransaction') out.push(await send(a[0]));
    else if (name === 'getmempooldescendants') {
      const j = await txOf(a[0]); if (!j || (j.status && j.status.confirmed)) { out.push(no('Transaction not in mempool')); continue; }
      const r = await get(`/tx/${a[0]}/outspends`); let s = []; try { s = JSON.parse(r.text); } catch { /* none */ }
      out.push(ok(s.filter((x) => x && x.spent && !(x.status && x.status.confirmed)).map((x) => x.txid)));
    } else if (name === 'getmempoolentry') {
      // its ancestors as far as Esplora says: the tx and its unconfirmed parents (one level)
      const j = await txOf(a[0]); if (!j || (j.status && j.status.confirmed)) { out.push(no('Transaction not in mempool')); continue; }
      let size = Math.ceil(j.weight / 4), fee = j.fee;
      for (const v of j.vin || []) { const pj = v.is_coinbase ? null : await txOf(v.txid); if (pj && !(pj.status && pj.status.confirmed)) { size += Math.ceil(pj.weight / 4); fee += pj.fee; } }
      out.push(ok({ vsize: Math.ceil(j.weight / 4), ancestorsize: size, fees: { base: j.fee / 1e8, ancestor: fee / 1e8 } }));
    } else if (name === 'estimatesmartfee') {
      const r = await get('/fee-estimates'); let e = null; try { e = JSON.parse(r.text); } catch { /* no */ }
      const k = e && Object.keys(e).map(Number).filter((x) => x >= Number(a[0] || 2)).sort((x, y) => x - y)[0];
      out.push(k != null ? ok({ feerate: e[k] / 1e5, blocks: k }) : ok({ errors: ['no fee estimate'], blocks: Number(a[0] || 2) }));
    } else if (name === 'getmempoolinfo') {
      const r = await get('/v1/fees/recommended'); let e = null; try { e = JSON.parse(r.text); } catch { /* no */ }
      out.push(e && e.minimumFee != null ? ok({ mempoolminfee: e.minimumFee / 1e5 }) : no('no minimum fee'));
    } else if (name === 'submitpackage') {
      // mempool.space's package relay; else each tx alone, parents first
      const hexes = JSON.parse(a[0]); const r = await http('POST', '/v1/txs/package', JSON.stringify(hexes)); if (r.status) answered++;
      if (r.ok) { out.push(ok(r.text)); continue; }
      let last = null; for (const h of hexes) { last = await send(h); if (!last.ok && !/already|known/.test(last.err)) break; }
      out.push(last.ok ? last : no(`package: ${esploraErr(r.text)}; alone: ${last.err}`));
    } else out.push(no(`${name}: not on Esplora`));
  }
  if (calls.length && !answered) throw new Error('no Esplora base answered');
  return out;
}
/** "sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}" -> "bad-txns-inputs-missingorspent" */
export function esploraErr(text) {
  const t = String(text || '').trim();
  const m = /"message"\s*:\s*"([^"]+)"/.exec(t) || /RPC error -?\d+:\s*(.+)$/m.exec(t);
  return (m ? m[1] : t || 'no answer').slice(0, 120);
}

// ---------------------------------------------------------------- WHAT A PUBLICATION IS FOR, AND WHEN (kanban #1124)
/** Its payload decoded: "ARN" 'S' series ids, 'R' round ids, 'D' duty markers - as the day whose rounds they are (slot d posts day d + 1). */
export function decodePayload(spks) {
  const r = { series: [], rounds: [], days: [] };
  for (const s of spks || []) {
    const m = /^6a([0-9a-f]{2})41524e([0-9a-f]{2})([0-9a-f]*)$/.exec(String(s)); if (!m) continue;
    const kind = String.fromCharCode(parseInt(m[2], 16)), body = m[3];
    if (kind === 'S' && body.length === 64) r.series.push(body);
    else if (kind === 'R' && body.length === 64) r.rounds.push(body);
    else if (kind === 'D' && body.length === 16) r.days.push((parseInt(body.slice(0, 8), 16) + 1) * 86400000);
  }
  return r;
}
/** "11-05 00:00-24:00Z", "11-04 16:10-19:10Z", "11-04 10:41Z-11-05 22:00Z" */
export function spanText(from, to) {
  const A = new Date(Number(from)).toISOString(), d0 = Date.parse(`${A.slice(0, 10)}T00:00:00Z`);
  if (to == null) return `${A.slice(5, 10)} ${A.slice(11, 16)}Z`;
  const B = new Date(Number(to)).toISOString();
  const end = B.slice(0, 10) === A.slice(0, 10) ? B.slice(11, 16) : Number(to) - d0 === 86400000 ? '24:00' : null;
  return end ? `${A.slice(5, 10)} ${A.slice(11, 16)}-${end}Z` : `${A.slice(5, 10)} ${A.slice(11, 16)}Z-${B.slice(5, 10)} ${B.slice(11, 16)}Z`;
}
/** "series ba68579a for 11-04 16:10-19:10Z", "grid for ...", "duty day 11-05" - from the payload, GET /series, the source's times. */
export function whatText(p, seriesById = new Map()) {
  const d = decodePayload(payloadOf(p.vout));
  const span = (w) => (w && w[0] ? ` for ${spanText(w[0], w[1])}` : w && w[1] ? ` until ${spanText(w[1])}` : '');
  if (d.series.length) {
    const s = d.series.map((id) => seriesById.get(id)).find(Boolean);
    return `series ${d.series[0].slice(0, 8)}${d.series.length > 1 ? ` +${d.series.length - 1}` : ''}${span(s ? [s.from, s.to] : p.when)}`;
  }
  if (p.when) return `${/^duty/.test(p.source || '') ? 'duty' : 'grid'}${span(p.when)}`;
  if (d.days.length) return `duty for ${spanText(d.days[0], d.days[0] + 86400000)}`;
  if (d.rounds.length) return `round ${d.rounds[0].slice(0, 8)}`;
  return null;
}
/** GET /series bodies -> id -> { from, to } (start, start + horizon). */
export function seriesTimes(bodies) {
  const m = new Map();
  for (const b of bodies || []) for (const s of (b && b.series) || []) if (HEX64.test(s.series || '') && Number(s.startTimeMs) > 0) m.set(s.series, { from: Number(s.startTimeMs), to: Number(s.startTimeMs) + (Number(s.horizonMs) || 0) || null });
  return m;
}

/** A tx on one chain: { s: 'confirmed', n } | { s: 'mempool' } | { s: 'missing' } | { s: '?' } */
export function chainState(c, txid, scanFound) {
  if (!c || c.error || (c.unread && c.unread.includes(txid))) return { s: '?' };
  const x = scanFound && scanFound[txid];
  if (x) return { s: 'confirmed', n: c.tip - x[0] + 1 };
  if (c.mem.includes(txid)) return { s: 'mempool' };
  return { s: 'missing' };
}
const say = (x) => (x.s === 'confirmed' ? `confirmed (${x.n})` : x.s);

// ---------------------------------------------------------------- THE JUDGEMENT (pure): state, problems, fixes
export function assessPubs(f, st, pc, problems, fixes, nowMs) {
  st.pubs = st.pubs || {}; st.scan = st.scan || {};
  // the scans: blocks found, a stale block (reorg) dropped and rescanned from there
  for (const chain of ['ours', 'public']) {
    const c = f.chains && f.chains[chain]; if (!c || c.error || c.tip == null) continue;
    const sc = st.scan[chain] || { to: null, found: {}, known: [] };
    for (const h of c.stale || []) for (const [t, v] of Object.entries(sc.found)) if (v[0] === h) delete sc.found[t];
    // Esplora answers each txid's status itself: one it no longer calls confirmed is dropped (a reorg)
    if (c.authoritative) for (const t of c.known || []) if (sc.found[t] && !c.found.some((x) => x.txid === t) && !(c.unread || []).includes(t)) delete sc.found[t];
    for (const x of c.found) sc.found[x.txid] = [x.h, x.hash];
    sc.to = (c.stale && c.stale.length) ? Math.min(...c.stale) - 1 : c.to; sc.known = c.known;
    st.scan[chain] = sc;
  }
  // replaced publications (kanban #1124): their payload landed in another tx - not tracked again while a seat still names them
  st.replaced = st.replaced || {};
  for (const [t, r] of Object.entries(st.replaced)) if (nowMs - r.atMs > pc.keepMs) delete st.replaced[t];
  for (const s of f.pubSources || []) {
    if (st.replaced[s.txid]) continue;
    const p = st.pubs[s.txid] || (st.pubs[s.txid] = { game: s.game, source: s.source, firstMs: s.atMs || nowMs });
    p.game = p.game === '?' ? s.game : p.game; p.live = nowMs;
    if (s.when && !p.when) p.when = s.when;
    if (s.atMs && s.atMs < p.firstMs) p.firstMs = s.atMs;
  }
  const seriesById = seriesTimes(f.series), landed = [], orphan = [];
  // a tx that spent a publication's input: the same payload - the publication, tracked under its new txid; another payload - alerted
  for (const [t, r] of Object.entries(f.replaced || {})) {
    const p = st.pubs[t]; if (!p) continue;
    if (!r.same) { p.orphan = { by: r.by, input: r.input, confirmed: r.confirmed, h: r.h, atMs: nowMs }; continue; }
    // (read on both chains from the next pass: this pass did not ask for it)
    const q = st.pubs[r.by] || (st.pubs[r.by] = { game: p.game, source: `replaces ${t.slice(0, 8)}`, firstMs: p.firstMs, live: nowMs, depth: 0, addedMs: nowMs });
    Object.assign(q, r.raw); q.when = q.when || p.when; q.replaces = t;
    landed.push(`${p.game} ${whatText(p, seriesById) || p.source}, txid ${t.slice(0, 8)}: replaced by ${r.by.slice(0, 8)} with the same payload, ${r.confirmed ? `confirmed at ${r.h}` : 'in the public mempool'}`);
    st.replaced[t] = { by: r.by, atMs: nowMs, game: p.game };
    delete st.pubs[t];
  }
  const bad = [], resend = { ours: [], public: [] }, bumps = [], mine = [];
  for (const [txid, p] of Object.entries(st.pubs)) {
    if (p.addedMs === nowMs) { p.what = whatText(p, seriesById); continue; }
    if (f.raw && f.raw[txid]) Object.assign(p, f.raw[txid]);
    p.what = whatText(p, seriesById) || p.what || null;
    const ours = chainState(f.chains.ours, txid, st.scan.ours && st.scan.ours.found), pub = chainState(f.chains.public, txid, st.scan.public && st.scan.public.found);
    if (pub.s !== 'missing') delete p.orphan;
    p.ours = ours.s === '?' ? p.ours : ours; p.public = pub.s === '?' ? p.public : pub;
    // parents of one not confirmed on the public chain, tracked too (4 deep)
    if (pub.s !== 'confirmed' && p.vin && (p.depth || 0) < 4) for (const v of p.vin) if (!st.pubs[v]) st.pubs[v] = { game: p.game, source: `parent of ${txid.slice(0, 8)}`, firstMs: nowMs, depth: (p.depth || 0) + 1, parentOf: txid, live: nowMs };
    // forget: 6 deep on the public chain and confirmed on ours, or tracked longer than HW_PUB_KEEP_H
    if ((ours.s === 'confirmed' && pub.s === 'confirmed' && pub.n >= 6) || nowMs - p.firstMs > pc.keepMs) { delete st.pubs[txid]; continue; }
    if (ours.s === 'mempool' && p.oursMemTip == null) p.oursMemTip = f.chains.ours.tip;
    if (pub.s !== 'confirmed' && p.publicFirstTip == null && f.chains.public && f.chains.public.tip != null) p.publicFirstTip = f.chains.public.tip;
    // lost: no raw tx anywhere and in no chain - said in the log (the posting and seating checks see what it costs)
    p.lost = !p.hex && ours.s === 'missing' && pub.s === 'missing';
    if (p.lost) continue;
    // resend to a chain that lacks it (not on its own chain if that chain refused it as spent: replaced)
    for (const chain of ['ours', 'public']) {
      const x = chain === 'ours' ? ours : pub;
      if (x.s !== 'missing' || !p.hex || (p.dead && p.dead[chain])) continue;
      const last = p.sent && p.sent[chain];
      if (last && nowMs - last.atMs < pc.resendMs) continue;
      resend[chain].push({ txid, depth: p.depth || 0 });
    }
    // our branch: listed (or not) but unmined past 2 of our blocks
    const oursLate = ours.s === 'mempool' && p.oursMemTip != null && f.chains.ours.tip - p.oursMemTip >= pc.oursBlocks;
    // the public chain: 2 of ours deep, 2 public blocks or 30 min, and still not mined there
    const pubLate = pub.s !== 'confirmed' && pub.s !== '?' && ((ours.s === 'confirmed' && ours.n >= pc.publicBlocks)
      || (p.publicFirstTip != null && f.chains.public.tip - p.publicFirstTip >= pc.publicBlocks) || nowMs - p.firstMs >= pc.publicMs);
    if (oursLate || (pubLate && !(p.dead && p.dead.public)) || (p.orphan && pub.s === 'missing')) bad.push({ txid, p, ours, pub, oursLate, pubLate });
    // CPFP on the public chain: once in the public mempool (or with its parents there), our change unspent, rate-limited; at once when
    // the public chain refused the tx alone for its fee (it goes as a package with its child)
    const feeRefused = pub.s === 'missing' && /fee/.test((p.sendErr && p.sendErr.public) || '');
    if ((pubLate || feeRefused) && !p.orphan && pc.cpfp && p.hex && ours.s !== 'missing') {
      const b = p.bumps || [];
      if (b.length < pc.cpfpMax && (!b.length || nowMs - b[b.length - 1].atMs >= pc.cpfpGapMs) && !(p.parentOf && st.pubs[p.parentOf])) bumps.push(txid);
    }
    if (pubLate && pc.publicConfirm && pc.publicMineCmd) mine.push(txid);
  }
  for (const chain of ['ours', 'public']) if (resend[chain].length) {
    const xs = resend[chain].sort((a, b) => b.depth - a.depth).map((x) => x.txid);
    fixes.push({ key: `resend:${chain}`, kind: 'resend', chain, txids: xs, allowed: true, blocked: [] });
  }
  for (const t of bumps) fixes.push({ key: `cpfp:${t}`, kind: 'cpfp', txid: t, allowed: true, blocked: [] });
  if (mine.length) {
    const fx = st.fixes && st.fixes['public-mine'], held = fx && nowMs - fx.atMs < pc.publicMineGapMs;
    fixes.push({ key: 'public-mine', kind: 'public-mine', txids: mine, allowed: !held, blocked: held ? ['once per 30 min'] : [] });
  }
  const lost = Object.entries(st.pubs).filter(([, p]) => p.lost);
  if (lost.length) problems.push({ key: 'publications-lost', ticket: '759', title: `${lost.length} publication(s) in no chain and no mempool (replaced?)`, lines: lost.slice(0, 4).map(([t, p]) => `${p.game} ${t.slice(0, 8)} (${p.source})`), alert: false });
  for (const chain of ['ours', 'public']) { const c = f.chains && f.chains[chain]; if (c && c.error) problems.push({ key: `chain-unread:${chain}`, ticket: '759', title: `${chain === 'ours' ? 'our branch' : 'public chain'} bitcoind not readable`, lines: [String(c.error).slice(0, 80)], tried: ['nothing'], needs: 'the node checked, see #759', alert: true }); }
  if (landed.length) problems.push({ key: 'publications-replaced', ticket: '1124', title: `${landed.length} publication(s) replaced, payload landed`, lines: landed, alert: false });
  if (bad.length) {
    const lines = bad.slice(0, 4).map(({ txid, p, ours, pub }) => `${pubName(txid, p)}: ours ${say(ours)}, public ${say(pub)}, ${mins(nowMs - p.firstMs)} min${triedText(p)}`);
    if (bad.length > 4) lines.push(`and ${bad.length - 4} more`);
    const tried = [];
    if (bad.some((b) => p2(b.p.sent))) tried.push('rebroadcast');
    if (bad.some((b) => b.p.bumps && b.p.bumps.length)) tried.push('CPFP');
    if (bad.some((b) => b.p.orphan)) tried.push('replacement looked up');
    if (!tried.length) tried.push('nothing yet');
    const needsPublic = bad.some((b) => b.pubLate);
    problems.push({ key: 'publications', ticket: '759', title: 'round publication not confirmed', lines, tried: [tried.join(', ')],
      needs: bad.some((b) => b.p.orphan) ? 'republish needed: the payload is in no chain and its inputs are spent, see #1124'
        : needsPublic ? (pc.publicConfirm ? 'public mining, see #759' : 'public mining (HW_PUBLIC_CONFIRM off), see #759') : 'miner C checked, see #759', alert: true });
  }
  return { bad };
}
const p2 = (sent) => !!(sent && (sent.ours || sent.public));
/** "RPS series ba68579a for 11-04 16:10-19:10Z, txid 9e022f7c" (kanban #1124: which app, and when its rounds are) */
const pubName = (txid, p) => `${p.game}${p.what ? ` ${p.what}, txid` : ''} ${txid.slice(0, 8)}`;
/** What was done about it and the answer: "; rebroadcast 17:20Z refused: bad-txns-inputs-missingorspent; CPFP 17:25Z ok, child c1c1c1c1 413 sat" */
function triedText(p) {
  let out = '';
  const s = p.sent && p.sent.public;
  if (s) out += `; rebroadcast ${hm(s.atMs)}Z ${s.ok || !(p.sendErr && p.sendErr.public) ? 'ok' : `refused: ${p.sendErr.public}`}`;
  const b = (p.bumps || [])[(p.bumps || []).length - 1];
  if (b) out += `; CPFP ${hm(b.atMs)}Z ${b.ok ? `ok, child ${String(b.child).slice(0, 8)} ${b.feeSat} sat` : `refused: ${p.bumpErr || b.why || 'no answer'}`}${p.bumps.length > 1 ? ` (${p.bumps.length} tries)` : ''}`;
  if (p.orphan) out += `; input ${p.orphan.input} spent by ${p.orphan.by.slice(0, 8)} (${p.orphan.confirmed ? `confirmed at ${p.orphan.h}` : 'public mempool'}) without this payload: republish needed`;
  return out;
}
/** Our mempool's tracked publications, as pending txs for the miner C check. */
export function pubMemTxs(f, prevPubs = {}) {
  const c = f.chains && f.chains.ours; if (!c || c.error) return [];
  const games = new Map((f.pubSources || []).map((s) => [s.txid, s.game]));
  return c.mem.filter((t) => games.has(t) || prevPubs[t]).map((t) => ({ txid: t, kind: 'publication', game: games.get(t) || (prevPubs[t] && prevPubs[t].game), inMempool: true }));
}

// ---------------------------------------------------------------- THE FIXES (io)
/** Sends kept raw txs to one chain, in order (parents first); records each answer. A "spent"/"conflict" refusal marks it dead there. */
export async function doResend(io, st, x, nowMs) {
  const items = x.txids.map((t) => ({ t, hex: st.pubs[t] && st.pubs[t].hex })).filter((y) => y.hex);
  const res = await io.chainCalls(x.chain, items.map((y) => ['sendrawtransaction', y.hex]));
  const out = [];
  items.forEach((y, i) => {
    const p = st.pubs[y.t], r = res[i] || { ok: false, err: 'no answer' };
    p.sent = { ...(p.sent || {}), [x.chain]: { atMs: nowMs, ok: r.ok } };
    const err = r.ok ? null : shortErr(r.err || r.out);
    p.sendErr = { ...(p.sendErr || {}), [x.chain]: err };
    if (err && /already in block chain|txn-already-known|txn-already-in-mempool/.test(r.err || '')) p.sendErr[x.chain] = null;
    else if (err && /conflict|missingorspent|already spent/.test(r.err || '') && (x.chain === 'ours' || /conflict/.test(r.err || ''))) p.dead = { ...(p.dead || {}), [x.chain]: err };
    out.push(`${y.t.slice(0, 8)} ${err || 'sent'}`);
  });
  return out.join(', ');
}
const shortErr = (e) => String(e || '').replace(/^error code: -?\d+\s*/m, '').replace(/^error message:\s*/m, '').split('\n').filter(Boolean)[0]?.slice(0, 60) || 'refused';

/** CPFP: a child spending the publication's change (the posting wallet's, unspent on our branch), paying for the package at the public
 * going rate; sent to our branch (the wallet sees it) and to the public chain (alone, or with its parent as a package). Never RBF. */
export async function doCpfp(io, st, pc, txid, nowMs, { plan = false } = {}) {
  const p = st.pubs[txid];
  // a bump that cannot be made is said in the alert's line for this tx (and counts as a try: once per HW_CPFP_GAP_MIN)
  const fail = (why) => { if (!plan) { p.bumpErr = why; p.bumps = [...(p.bumps || []), { atMs: nowMs, ok: false, why }]; } return { ok: false, text: `${txid.slice(0, 8)}: ${why}` }; };
  const W = [`-rpcwallet=${pc.wallet}`];
  // a child in the public mempool already (another bump, by hand or by the chain helper): not a second one
  const [kids] = await io.chainCalls('public', [['getmempooldescendants', txid]]);
  let kid = []; try { kid = JSON.parse(kids.out); } catch { /* not in the public mempool */ }
  if (kids.ok && kid.length) return fail(`has a child in the public mempool already (${String(kid[0]).slice(0, 8)})`);
  // the change: a wallet output of the publication still unspent on our branch
  let change = null;
  for (const o of (p.vout || []).filter((v) => v.address && v.sat > 0)) {
    const [mine, utxo] = await io.chainCalls('ours', [[...W, 'getaddressinfo', o.address], ['gettxout', txid, String(o.n), 'true']]);
    let isMine = false; try { isMine = JSON.parse(mine.out).ismine === true; } catch { /* no */ }
    if (isMine && utxo.ok && String(utxo.out).trim()) { change = o; break; }
    if (isMine) return fail('its change is spent already (bump the spender)');
  }
  if (!change) return fail('no change of the posting wallet');
  // the package on the public chain: its mempool entry's ancestors, else the publication alone (sent as a package)
  const [entry, est, info] = await io.chainCalls('public', [['getmempoolentry', txid], ['estimatesmartfee', '2'], ['getmempoolinfo']]);
  let ancVsize = p.vsize, ancFee = p.fee, inPool = false;
  if (entry.ok) { try { const e = JSON.parse(entry.out); ancVsize = e.ancestorsize; ancFee = Math.round(e.fees.ancestor * 1e8); inPool = true; } catch { /* no */ } }
  if (ancVsize == null || ancFee == null) return fail('its fee is not known');
  let going = pc.cpfpRate;
  try { const r = JSON.parse(est.out).feerate; if (r) going = Math.max(going, r * 1e5); } catch { /* no estimate on testnet4 */ }
  try { going = Math.max(going, JSON.parse(info.out).mempoolminfee * 1e5 * 2); } catch { /* no */ }
  const fee = Math.ceil(going * (ancVsize + pc.childVsize)) - ancFee;
  const childFee = Math.max(fee, Math.ceil(going * pc.childVsize));
  if (childFee > pc.cpfpMaxSat) return fail(`fee ${childFee} sat > cap ${pc.cpfpMaxSat}`);
  if (change.sat - childFee < pc.dust) return fail(`change ${change.sat} sat too small for ${childFee}`);
  // --dry: the plan, read only (no address taken from the wallet, nothing signed or sent)
  if (plan) return { ok: true, text: `${txid.slice(0, 8)}: would add a child of ${childFee} sat (${going.toFixed(1)} sat/vB over ${ancVsize + pc.childVsize} vB, change ${change.sat} sat, ${inPool ? 'parent in the public mempool' : 'as a package'})` };
  // build and sign with the posting wallet on our branch
  const [addr] = await io.chainCalls('ours', [[...W, 'getrawchangeaddress', 'bech32']]);
  if (!addr.ok) return fail(shortErr(addr.err));
  const outs = JSON.stringify([{ [String(addr.out).trim()]: (change.sat - childFee) / 1e8 }]);
  const [raw] = await io.chainCalls('ours', [['createrawtransaction', JSON.stringify([{ txid, vout: change.n }]), outs]]);
  if (!raw.ok) return fail(shortErr(raw.err));
  const [signed] = await io.chainCalls('ours', [[...W, 'signrawtransactionwithwallet', String(raw.out).trim(), JSON.stringify([{ txid, vout: change.n, scriptPubKey: change.spk, amount: change.sat / 1e8 }])]]);
  let hex = null; try { const j = JSON.parse(signed.out); if (j.complete) hex = j.hex; } catch { /* no */ }
  if (!hex) return fail('the wallet did not sign the child');
  const [onOurs] = await io.chainCalls('ours', [['sendrawtransaction', hex]]);
  if (!onOurs.ok) return fail(`ours: ${shortErr(onOurs.err)}`);
  const childId = String(onOurs.out).trim();
  const [onPublic] = await io.chainCalls('public', [inPool ? ['sendrawtransaction', hex] : ['submitpackage', JSON.stringify([p.hex, hex])]]);
  st.pubs[childId] = { game: p.game, source: `cpfp child of ${txid.slice(0, 8)}`, firstMs: nowMs, live: nowMs, hex, depth: 0, child: true };
  p.bumps = [...(p.bumps || []), { atMs: nowMs, ok: onPublic.ok, child: childId, feeSat: childFee, rate: going }];
  p.bumpErr = onPublic.ok ? null : `public: ${shortErr(onPublic.err || onPublic.out)}`;
  return { ok: onPublic.ok, child: childId, text: `${txid.slice(0, 8)} child ${childId.slice(0, 8)} ${childFee} sat at ${going.toFixed(1)} sat/vB${onPublic.ok ? '' : ` (${p.bumpErr})`}` };
}

/** The public-chain mining step (HW_PUBLIC_CONFIRM=1): the chain helper's tool, given the txids. */
export async function doPublicMine(io, pc, txids) { return io.run('bash', ['-c', `${pc.publicMineCmd} ${txids.join(' ')}`], 600000); }

// ---------------------------------------------------------------- THE REAL CHAINS
/** The script that looks for txids on one chain: its tip, which are in its mempool, which are in the blocks from..to, which kept blocks changed. */
export function lookScript(cli, { txids, from, back, max, verify }) {
  const pat = txids.filter((t) => HEX64.test(t)).join('|');
  const v = verify.filter(([h, hash]) => Number.isInteger(h) && HEX64.test(hash)).map(([h, hash]) => `${h}:${hash}`).join(' ');
  return `set -u
C="${cli}"
TIP=$($C getblockcount) || exit 3
echo "tip $TIP"
$C getrawmempool | grep -oE '[0-9a-f]{64}' | grep -xE '${pat || 'x'}' | sed 's/^/mem /'
FROM=${from == null ? `$((TIP-${Number(back) || 0}))` : Number(from)}
END=$((FROM+${Number(max) || 1}-1)); [ $END -gt $TIP ] && END=$TIP
h=$FROM
while [ $h -le $END ]; do
  H=$($C getblockhash $h) || break
  $C getblock $H 1 | grep -oE '[0-9a-f]{64}' | grep -xE '${pat || 'x'}' | sed "s/^/found $h $H /"
  h=$((h+1))
done
echo "scanned $((h-1))"
for x in ${v}; do [ "$($C getblockhash \${x%%:*} 2>/dev/null)" = "\${x#*:}" ] || echo "stale \${x%%:*}"; done
`;
}
export function parseLook(out) {
  const r = { tip: null, mem: [], found: [], stale: [], scannedTo: null };
  for (const l of String(out).split('\n')) {
    const w = l.trim().split(' ');
    if (w[0] === 'tip') r.tip = Number(w[1]); else if (w[0] === 'mem') r.mem.push(w[1]);
    else if (w[0] === 'found') r.found.push({ txid: w[3], h: Number(w[1]), hash: w[2] });
    else if (w[0] === 'scanned') r.scannedTo = Number(w[1]); else if (w[0] === 'stale') r.stale.push(Number(w[1]));
  }
  if (r.tip == null) throw new Error('no tip');
  return r;
}
/** Several bitcoin-cli calls in one shell (the public chain over one ssh): each answer { ok, out, err }. Arguments must be plain words or JSON. */
export function callsScript(cli, calls) {
  const q = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
  return `C="${cli}"\n` + calls.map((c, i) => `echo "@@begin ${i}"; $C ${c.map(q).join(' ')} 2>&1; echo "@@rc ${i} $?"`).join('\n') + '\n';
}
export function parseCalls(out, k) {
  const res = Array.from({ length: k }, () => ({ ok: false, out: '', err: 'no answer' }));
  const re = /@@begin (\d+)\n([\s\S]*?)@@rc \1 (\d+)/g; let m;
  while ((m = re.exec(String(out)))) { const i = Number(m[1]); res[i] = m[3] === '0' ? { ok: true, out: m[2].trim() } : { ok: false, out: '', err: m[2].trim() }; }
  return res;
}
