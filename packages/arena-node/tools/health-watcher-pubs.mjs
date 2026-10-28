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
 *           public  public testnet4 (the owner's installer node on the test host, ~/.arena-node/bitcoin-testnet4, over ssh)
 * FIXED     each behind a rate limit and rechecked on the next pass:
 *           - in no mempool and in no block of a chain: the raw tx (kept from where it was seen) sent to that chain, parents first
 *           - in our mempool and not on miner C's list: appended (the watcher's minerc-add)
 *           - unconfirmed on the public chain 2 blocks past ours or 30 min: CPFP - a child spending its change from the posting wallet, its
 *             fee lifting the package above the public going rate; never RBF (the seats know a series by its publication txid). The child
 *             goes to both chains (on ours it keeps the wallet from spending the change twice) and is tracked like the rest.
 *           - HW_PUBLIC_CONFIRM=1 with HW_PUBLIC_MINE_CMD: the public-chain mining step, run with the txids (the hook for the chain
 *             helper's miner; nothing mines on the public chain without it)
 * ALERTED   "round publication not confirmed", one line per tx: app, txid8, our branch, public chain, minutes
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
    publicHost: env.HW_PUBLIC_HOST || 'arena@198.51.100.7',
    publicCli: env.HW_PUBLIC_CLI || '$HOME/.arena-node/bitcoin-core/bitcoin-31.1/bin/bitcoin-cli -testnet4 -datadir=$HOME/.arena-node/bitcoin-testnet4',
    wallet: env.HW_POSTING_WALLET || 'blwp-tn4-bonds',
    opsDir: env.HW_OPS_LOG_DIR || `${H}/blwp-testnet4`,
    scanBack: n('HW_SCAN_BACK', 300), scanMax: n('HW_SCAN_MAX', 320),
    sourceMs: n('HW_PUB_SOURCE_H', 36) * 3600000, keepMs: n('HW_PUB_KEEP_H', 48) * 3600000,
    publicBlocks: n('HW_PUBLIC_BLOCKS', 2), publicMs: n('HW_PUBLIC_MIN', 30) * 60000, oursBlocks: n('HW_OURS_BLOCKS', 2),
    resendMs: n('HW_RESEND_MIN', 30) * 60000,
    cpfp: env.HW_CPFP !== '0', cpfpGapMs: n('HW_CPFP_GAP_MIN', 60) * 60000, cpfpMax: n('HW_CPFP_MAX_BUMPS', 2),
    cpfpRate: n('HW_CPFP_RATE', 2), cpfpMaxSat: n('HW_CPFP_MAX_SAT', 5000), childVsize: 110, dust: 330,
    publicConfirm: env.HW_PUBLIC_CONFIRM === '1', publicMineCmd: env.HW_PUBLIC_MINE_CMD || null, publicMineGapMs: n('HW_PUBLIC_MINE_GAP_MIN', 30) * 60000,
  };
}

// ---------------------------------------------------------------- SOURCES: what carries rounds now
/** Every publication of ours with rounds still to come: [{ txid, game, source, atMs? }]. */
export function pubSources({ duty = [], pending = [], expected = [], ops = [], nowMs, sourceMs = 36 * 3600000 }) {
  const out = new Map();
  const add = (txid, game, source, atMs = null) => { if (!HEX64.test(txid || '')) return; const w = out.get(txid);
    if (!w) out.set(txid, { txid, game: gameName(game), source, atMs }); else if (atMs && (!w.atMs || atMs < w.atMs)) w.atMs = atMs; };
  const best = duty.slice().sort((a, b) => cnt(b) - cnt(a))[0];
  for (const day of (best && best.days) || []) for (const a of day.apps || []) for (const p of a.postings || []) add(p.txid, a.app || a.name, `duty ${day.covers.slice(5)} ${a.role}${p.emergency ? ' emergency' : ''}`);
  for (const b of pending) for (const g of (b && b.grids) || []) if (Number(g.lastCloseMs) > nowMs && g.publication) add(g.publication.txid, g.game, 'grid');
  for (const b of expected) for (const e of (b && b.expected) || []) if (Number(e.lastCloseMs) > nowMs && e.publication) add(e.publication.txid, e.game, 'expected');
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

// ---------------------------------------------------------------- THE READ: both chains, through io.chainLook / io.chainCalls
/** Reads both chains for the tracked txids (and fetches the raw tx of any not kept yet). Adds f.pubSources, f.chains, f.raw. */
export async function gatherPubs(io, pc, prev, f) {
  f.pubSources = pubSources({ duty: f.duty, pending: f.pending, expected: f.expected || [], ops: io.opsPublished ? await io.opsPublished() : [], nowMs: f.nowMs, sourceMs: pc.sourceMs });
  const kept = (prev && prev.pubs) || {};
  const txids = [...new Set([...Object.keys(kept), ...f.pubSources.map((s) => s.txid)])];
  f.chains = {}; f.raw = {};
  if (!txids.length) return;
  for (const chain of ['ours', 'public']) {
    const sc = prev && prev.scan && prev.scan[chain];
    const known = new Set((sc && sc.known) || []), fresh = txids.filter((t) => !known.has(t));
    try {
      const a = await io.chainLook(chain, { txids, from: sc ? sc.to + 1 : null, back: pc.scanBack, max: pc.scanMax, verify: sc ? Object.entries(sc.found || {}).map(([, v]) => v) : [] });
      // txids new to this chain: their blocks may be behind the scan - looked for once from scanBack
      const b = sc && fresh.length ? await io.chainLook(chain, { txids: fresh, from: null, back: pc.scanBack, max: pc.scanBack + 1, verify: [] }) : null;
      f.chains[chain] = { tip: a.tip, mem: a.mem, found: [...a.found, ...(b ? b.found : [])], stale: a.stale, to: a.scannedTo, known: txids };
    } catch (e) { f.chains[chain] = { error: e.message }; }
  }
  // the raw tx of each tracked one not kept yet, from a chain that has it (ours first: it has the fee and the posting wallet)
  const need = txids.filter((t) => !(kept[t] && kept[t].hex));
  for (const chain of ['ours', 'public']) {
    const c = f.chains[chain]; if (!c || c.error) continue;
    const where = need.filter((t) => !f.raw[t] && (c.mem.includes(t) || c.found.some((x) => x.txid === t)));
    if (!where.length) continue;
    const res = await io.chainCalls(chain, where.map((t) => { const x = c.found.find((y) => y.txid === t); return ['getrawtransaction', t, '2', ...(x ? [x.hash] : [])]; }));
    where.forEach((t, i) => { if (res[i] && res[i].ok) { try { const j = JSON.parse(res[i].out); f.raw[t] = { hex: j.hex, vsize: j.vsize, fee: j.fee != null ? Math.round(j.fee * 1e8) : null,
      vin: (j.vin || []).filter((v) => v.txid).map((v) => v.txid), vout: (j.vout || []).map((o) => ({ n: o.n, sat: Math.round(o.value * 1e8), spk: o.scriptPubKey && o.scriptPubKey.hex, address: o.scriptPubKey && o.scriptPubKey.address })) }; } catch { /* not JSON */ } } });
  }
}

/** A tx on one chain: { s: 'confirmed', n } | { s: 'mempool' } | { s: 'missing' } | { s: '?' } */
export function chainState(c, txid, scanFound) {
  if (!c || c.error) return { s: '?' };
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
    for (const x of c.found) sc.found[x.txid] = [x.h, x.hash];
    sc.to = (c.stale && c.stale.length) ? Math.min(...c.stale) - 1 : c.to; sc.known = c.known;
    st.scan[chain] = sc;
  }
  for (const s of f.pubSources || []) {
    const p = st.pubs[s.txid] || (st.pubs[s.txid] = { game: s.game, source: s.source, firstMs: s.atMs || nowMs });
    p.game = p.game === '?' ? s.game : p.game; p.live = nowMs;
    if (s.atMs && s.atMs < p.firstMs) p.firstMs = s.atMs;
  }
  const bad = [], resend = { ours: [], public: [] }, bumps = [], mine = [];
  for (const [txid, p] of Object.entries(st.pubs)) {
    if (f.raw && f.raw[txid]) Object.assign(p, f.raw[txid]);
    const ours = chainState(f.chains.ours, txid, st.scan.ours && st.scan.ours.found), pub = chainState(f.chains.public, txid, st.scan.public && st.scan.public.found);
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
    if (oursLate || (pubLate && !(p.dead && p.dead.public))) bad.push({ txid, p, ours, pub, oursLate, pubLate });
    // CPFP on the public chain: once in the public mempool (or with its parents there), our change unspent, rate-limited
    if (pubLate && pc.cpfp && p.hex && ours.s !== 'missing') {
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
  if (bad.length) {
    const lines = bad.slice(0, 4).map(({ txid, p, ours, pub }) => `${p.game} ${txid.slice(0, 8)}: ours ${say(ours)}, public ${say(pub)}, ${mins(nowMs - p.firstMs)} min`
      + `${(p.bumps || []).some((b) => b.ok) ? `, bumped ${p.bumps.filter((b) => b.ok).length}x` : ''}${p.sendErr && p.sendErr.public ? ` (public: ${p.sendErr.public})` : ''}${p.bumpErr ? ` (cpfp: ${p.bumpErr})` : ''}`);
    if (bad.length > 4) lines.push(`and ${bad.length - 4} more`);
    const tried = [];
    if (bad.some((b) => p2(b.p.sent))) tried.push('rebroadcast');
    if (bad.some((b) => b.p.bumps && b.p.bumps.length)) tried.push('CPFP');
    if (!tried.length) tried.push('nothing yet');
    const needsPublic = bad.some((b) => b.pubLate);
    problems.push({ key: 'publications', ticket: '759', title: 'round publication not confirmed', lines, tried: [tried.join(', ')],
      needs: needsPublic ? (pc.publicConfirm ? 'public mining, see #759' : 'public mining (HW_PUBLIC_CONFIRM off), see #759') : 'miner C checked, see #759', alert: true });
  }
  return { bad };
}
const p2 = (sent) => !!(sent && (sent.ours || sent.public));
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
