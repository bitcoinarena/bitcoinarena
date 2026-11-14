// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT FILES A SLASH START (spec 5A.3B, kanban #972). It holds a proof, the accused's bond is template 3 and unstarted, so it takes the presig (the round's, else the one at bonding), a fee coin of its own and the proof's OP_RETURN,
// and asks the key's holders. Each holder replays the proof itself (`judge`) and holds the request to its own census and its own hold outputs before it commits a nonce, so a filer can claim nothing. Bitcoin takes the result
// or refuses it. A filer earns nothing here and the release pays its fee back, so seats that hold one proof wait their turn by a hash, and what one files the others see on the chain.
import { schnorr } from '@noble/curves/secp256k1.js';
import { BOND_TEMPLATE_V3, HOLD_INTERNAL_KEY, TAPLEAF_VERSION, controlBlockFor, tapLeafHash, tapTweak } from '../../arena-protocol/src/bond-script.js';
import { scriptPathWitness, serializeSpend, tapSighash } from '../../arena-protocol/src/bond-spend.js';
import { P2TR_DUST_SATS } from '../../arena-protocol/src/arbitration-tx.js';
import { SLASH_SPEND_FEE_RATE_FLOOR, startFeeRate, vsizeOfSpend } from '../../arena-protocol/src/slash-release.js';
import { buildSlashStart, checkSlashStart, signedSlashStart, slashStartDigest } from '../../arena-protocol/src/slash-start.js';
import { decodeSlashPayoutTable, fraudProofHash, slashHeightIsValid } from '../../arena-protocol/src/slash.js';
import { fromHex, taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { tweakPoint } from './curve.js';
import { bondKeyOf } from './bond-withdraw.js';
import { createCensusSigner, gatherCensusSignature, rosterOfRecord } from './census-sign.js';

const verifySig = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const HINT = new TextEncoder().encode('arena');
const txJson = (tx) => ({ version: tx.version, locktime: tx.locktime, inputs: tx.inputs.map((i) => ({ txid: toHex(i.txid), vout: i.vout, sequence: i.sequence })), outputs: tx.outputs.map((o) => ({ value: String(o.value), script: toHex(o.script) })) });
const txOfJson = (t) => ({ version: t.version, locktime: t.locktime, inputs: t.inputs.map((i) => ({ txid: fromHex(i.txid), vout: i.vout, sequence: i.sequence })), outputs: t.outputs.map((o) => ({ value: BigInt(o.value), script: fromHex(o.script) })) });
const coinsJson = (p) => p.map((x) => ({ value: String(x.value), script: toHex(x.script) }));
const coinsOfJson = (p) => p.map((x) => ({ value: BigInt(x.value), script: fromHex(x.script) }));
const bondOf = (e) => ({ txid: e.txid, vout: e.vout, value: BigInt(e.bondSats), script: e.script });
const display = (internal) => toHex(Uint8Array.from(internal).reverse());
/** A send refused because the very transaction is already there: this seat sent it before. */
const ALREADY = /txn-same-nonwitness-data-in-mempool|already in (the )?(mempool|block ?chain)|txn-already-known|txn-already-in-mempool|already known|outputs already in utxo set/i;

/** A PROOF'S FEE COIN AS THIS SEAT KEEPS IT (kanban #1191): slash_fee_coins, moved by coinStep only (createSlashStarter). */
export const FEE_COIN = Object.freeze({ NONE: 'none', FUNDING: 'funding', FUNDED: 'funded', FILING: 'filing', FILED: 'filed' });
const FEE_COIN_MOVES = Object.freeze({ [FEE_COIN.NONE]: [FEE_COIN.FUNDING], [FEE_COIN.FUNDING]: [FEE_COIN.FUNDED, FEE_COIN.NONE], [FEE_COIN.FUNDED]: [FEE_COIN.FILING],
  [FEE_COIN.FILING]: [FEE_COIN.FILED, FEE_COIN.FUNDED], [FEE_COIN.FILED]: [] });

/** Which seat files first, of the seats a proof reached: a hash of the proof and the key, so nobody picks its place. */
export const filerRank = (proofId, keys, me) => [...keys].sort((a, b) => (toHex(taggedHash('ARENA/v1/SlashFiler', Uint8Array.from([...proofId, ...fromHex(a)]))) < toHex(taggedHash('ARENA/v1/SlashFiler', Uint8Array.from([...proofId, ...fromHex(b)]))) ? -1 : 1)).indexOf(me);

/**
 * `key`; `db`; `store` CensusKeyStore; `thresholdOf(keyHex)`; `totalOf(keyHex)` its shares; `tipHeight()`; `entriesAtTip()` the census at the tip; `heldProofs()` [{ proofId, bytes, seenMs }] of the proofs this seat filed and the abandoned outputs it lists; `bytesOf(id)` what its relay keeps under a hash; `judge(bytes)` this seat's own
 * word on a complete proof (proof-judge.js): { verdict: true | false | undefined, why }, with `judge.read`; `holdsFor(entry, roundId, contract)` -> { holds: [{ script }], presig?(bytes), holdScript? } by this seat's own reckoning, `presig`/`holdScript` naming the one a filer uses;
 * `feeCoin(spk, value)`, `send(hex)`, `urlsOf(entries)`.
 * THE REPAID FEE (sweep): `txOut(txid display, vout)` a confirmed unspent output { sats, script hex } or null (bitcoind's gettxout without the mempool); `returnScript()` this node's own wallet
 * script; `ownServed(start)` this seat's own GET /slash-release answer, if it built the release or the fallback itself.
 */
export function createSlashStarter({ asker = null, key, network, db, store, thresholdOf, totalOf = () => null, tipHeight, entriesAtTip, heldProofs, bytesOf, judge, holdsFor, feeCoin, send, urlsOf, checkOther = null, feeSecret = () => schnorr.utils.randomSecretKey(), stepMs = 600000, judgeAgainMs = 600000, feeSats = 700n, fetchFn = fetch, now = Date.now, log = () => {},
  txOut = null, returnScript = async () => null, ownServed = null, sweepEveryMs = 60000, feeFind = null }) {
  const me = toHex(key);
  db.exec(`CREATE TABLE IF NOT EXISTS slash_starts (proof_id BLOB PRIMARY KEY, bond TEXT NOT NULL, txid TEXT NOT NULL, kept_ms INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS slash_handed (proof_id BLOB PRIMARY KEY, seen_ms INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS slash_fee_sweeps (proof_id BLOB PRIMARY KEY, rate INTEGER NOT NULL, state TEXT NOT NULL DEFAULT '{}')`);
  const filed = (id) => !!db.prepare('SELECT 1 FROM slash_starts WHERE proof_id = ?').get(id);
  const entryOf = (entries, bond) => entries.find((e) => toHex(e.txid) === toHex(bond.txid) && e.vout === bond.vout) || null;

  /** A HOLDER'S CHECK of a filer's request: the bond, its hold and the transaction by this seat's own census, and last, since it costs a replay, the proof on this seat's own judge. */
  async function check(request) {
    let tx, prevouts, bytes, presig;
    try { tx = txOfJson(request.tx); prevouts = coinsOfJson(request.prevouts); bytes = fromHex(request.proof); presig = fromHex(request.presig); }
    catch (e) { return { ok: false, why: `that is no request: ${e.message}` }; }
    const said = judge.read(bytes);
    if (!said.ok) return said;
    const entry = entryOf((await entriesAtTip()) || [], said.bond);
    if (!entry || entry.advert.bondScriptTemplateVersion !== BOND_TEMPLATE_V3) return { ok: false, why: 'no unspent template-3 bond of this census is that proof\'s' };
    if (entry.hold) return { ok: false, why: 'that bond was started already' };
    const { holds, why } = holdsFor(entry, said.roundId, said.contract);
    if (!holds.length) return { ok: false, why: why || 'that bond has no hold output here yet' };
    const c = checkSlashStart({ tx, prevouts, bond: bondOf(entry), nodeKey: entry.pubkey, censusKey: entry.advert.censusKey, holds, presig, proofId: fraudProofHash(bytes), verify: verifySig });
    if (!c.ok) return c;
    const height = slashHeightIsValid({ slashHeight: c.slashHeight, censusHeight: said.floorHeight, tipHeight: await tipHeight() });
    if (!height.ok) return height;
    const j = await judge(bytes);
    if (j.verdict !== true) return { ok: false, why: j.why };
    return { ok: true, digest: c.digest, publicKey: entry.advert.censusKey };
  }
  // ONE SIGNER FOR EVERY ASK OF THIS NODE'S SHARES: a start here, a fallback (slash-release-run.js checkFallback) by its `kind`
  // THE ROSTER A SIGNING SET IS READ AGAINST (kanban #1155): the record this node's keygen kept, or for key 0, kept without one, the chain's word on that key
  const rosterOf = (publicKey, held) => rosterOfRecord(publicKey, held) || (held.record && held.record.length ? null : { total: totalOf(toHex(publicKey)), threshold: thresholdOf(toHex(publicKey)) });
  // A SIGNED ASK COUNTS FOR ITS CENSUS NODE (kanban #1386, audit 2 #1204 RES-7): an unsigned one shares a small pool and gives way first
  const signer = createCensusSigner({ key, held: (publicKey) => store.held(publicKey), rosterOf,
    isAsker: async (nodeHex) => ((await entriesAtTip()) || []).some((e) => toHex(e.pubkey) === String(nodeHex).toLowerCase()),
    check: (request) => (request && request.kind && request.kind !== 'start' ? (checkOther ? checkOther(request) : { ok: false, why: `this seat signs no ${request.kind} yet` }) : check(request)) });

  // THE FEE COIN'S KEY, FROM THE NODE'S OWN AND THE PROOF: the release repays this coin to the very script it came from (5A.3B, pays = filer), so the filer can still spend it, after a restart too
  const feeKeyOf = (proofId) => {
    const secret = feeSecret(proofId), leaf = Uint8Array.from([0x20, ...schnorr.getPublicKey(secret), 0xac]), leafHash = tapLeafHash(leaf);
    const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, leafHash));
    return { script: fromHex(`5120${toHex(q.outputKey)}`), secret, leaf, leafHash, control: Uint8Array.from([TAPLEAF_VERSION | q.parity, ...HOLD_INTERNAL_KEY]) };
  };
  // THE FEE COIN OF A PROOF, ON DISK BEFORE EACH IRREVERSIBLE STEP (kanban #1191, the state machine audit of 2026-11-06). Before, the funded coin was kept in memory
  // until the start's row was written: a stop in between (or a start that gathered too few shares, then a restart) funded a second coin at the same script.
  //   none -> funding     written BEFORE the wallet is asked to fund (the script is the proof's own, so a coin found there later is this one)
  //   funding -> funded   the wallet's txid:vout, written as soon as it answers; a funding found on disk after a stop is looked for first (`feeFind`), and funded
  //                       again only when the wallet's history shows no coin at that script; with no `feeFind` it is held, never funded twice
  //   funding -> none     the wallet said it funded nothing (refused before its send)
  //   funded -> filing    the signed start's bytes and txid, written BEFORE they are sent; a filing found after a stop is sent again, the same bytes
  //   filing -> filed     the start was taken (or the chain already holds it); its slash_starts row in the same transaction
  //   filing -> funded    refused: the coin is kept for the next try
  db.exec(`CREATE TABLE IF NOT EXISTS slash_fee_coins (proof_id BLOB PRIMARY KEY, state TEXT NOT NULL, txid TEXT, vout INTEGER, value TEXT, raw TEXT, start TEXT, bond TEXT, rate INTEGER,
    at_ms INTEGER NOT NULL)`);
  const COLS = ['txid', 'vout', 'value', 'raw', 'start', 'bond', 'rate'];
  const coinRow = (id) => db.prepare('SELECT * FROM slash_fee_coins WHERE proof_id = ?').get(id) || null;
  /** THE ONE TRANSITION: compare and set on the row's state. False, nothing written, when the row is not in `from` or FEE_COIN_MOVES has no such move. */
  function coinStep(id, from, to, fields = {}) {
    if (!FEE_COIN_MOVES[from] || !FEE_COIN_MOVES[from].includes(to)) return false;
    const row = coinRow(id);
    if (((row && row.state) || FEE_COIN.NONE) !== from) return false;
    if (to === FEE_COIN.NONE) return Number(db.prepare('DELETE FROM slash_fee_coins WHERE proof_id = ? AND state = ?').run(id, from).changes) === 1;
    const next = COLS.map((c) => (c in fields ? fields[c] : row ? row[c] : null));
    const r = row
      ? db.prepare(`UPDATE slash_fee_coins SET state = ?, ${COLS.map((c) => `${c} = ?`).join(', ')}, at_ms = ? WHERE proof_id = ? AND state = ?`).run(to, ...next, now(), id, from)
      : db.prepare(`INSERT OR IGNORE INTO slash_fee_coins (proof_id, state, ${COLS.join(', ')}, at_ms) VALUES (${Array(COLS.length + 3).fill('?').join(', ')})`).run(id, to, ...next, now());
    return Number(r.changes) === 1;
  }
  const coinOf = (row, key) => ({ ok: true, txid: fromHex(row.txid).reverse(), vout: Number(row.vout), value: BigInt(row.value), ...key });
  /** This proof's fee coin: the one on disk, else one funded now - funding written before the wallet is asked. */
  async function feeFor(idHex) {
    const id = fromHex(idHex), key = feeKeyOf(id);
    const row = coinRow(id);
    if (row && row.state === FEE_COIN.FUNDED) return coinOf(row, key);
    if (row && row.state !== FEE_COIN.FUNDING) return { ok: false, why: `the fee coin of this proof is ${row.state}` };
    if (row) {
      // ASKED BEFORE A STOP, OR AN ANSWER NEVER HEARD: the wallet's own history says whether it funded that script
      if (typeof feeFind !== 'function') return { ok: false, held: true, why: 'a fee coin for this proof was asked of the wallet before and this seat cannot look for it: held, never funded twice' };
      let found; try { found = await feeFind(key.script); } catch (e) { return { ok: false, held: true, why: `a fee coin for this proof was asked before and the wallet could not be read (${String(e.message || e).slice(0, 160)}): held, never funded twice` }; }
      if (found && found.txid) {
        if (!coinStep(id, FEE_COIN.FUNDING, FEE_COIN.FUNDED, { txid: String(found.txid), vout: Number(found.vout), value: String(found.value) })) return { ok: false, why: 'the fee coin moved while it was read' };
        log(`[slash] ${idHex.slice(0, 16)}: the fee coin funded before a stop was found at ${found.txid}:${found.vout}, not funded again`);
        return coinOf(coinRow(id), key);
      }
      coinStep(id, FEE_COIN.FUNDING, FEE_COIN.NONE);
    }
    if (!coinStep(id, FEE_COIN.NONE, FEE_COIN.FUNDING)) return { ok: false, why: 'the fee coin moved while it was read' };
    let got; try { got = await feeCoin(key.script, feeSats); } catch (e) { got = { ok: false, unknown: true, why: String(e.message || e).slice(0, 200) }; }
    if (!got || !got.ok) {
      // A REFUSAL BEFORE THE SEND FUNDED NOTHING; AN ANSWER LOST AT THE SEND (`unknown`) STAYS FUNDING, to be looked for
      if (!(got && got.unknown)) coinStep(id, FEE_COIN.FUNDING, FEE_COIN.NONE);
      return got || { ok: false, why: 'the wallet gave no answer' };
    }
    coinStep(id, FEE_COIN.FUNDING, FEE_COIN.FUNDED, { txid: String(got.txid), vout: Number(got.vout), value: String(got.value) });
    return coinOf(coinRow(id), key);
  }
  /** The start is taken: its row, its sweep's rate and the coin's end in one transaction. */
  function filedNow(proofId, row) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO slash_starts (proof_id, bond, txid, kept_ms) VALUES (?, ?, ?, ?)').run(proofId, row.bond, String(row.start), now());
      // THE START'S OWN RATE, what its sweep pays later: the filer chose it, as the release does
      db.prepare('INSERT OR IGNORE INTO slash_fee_sweeps (proof_id, rate, state) VALUES (?, ?, ?)').run(proofId, Number(row.rate), '{}');
      coinStep(proofId, FEE_COIN.FILING, FEE_COIN.FILED);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  /** The signed start, on disk as FILING, sent: { ok, txid } or { ok: false, why } with the coin FUNDED again. A send the chain already holds is a send. */
  async function sendFiling(proofId) {
    const row = coinRow(proofId);
    let txid;
    try { txid = String(await send(row.raw)); } catch (e) {
      if (!ALREADY.test(e.message)) { coinStep(proofId, FEE_COIN.FILING, FEE_COIN.FUNDED, { raw: null, start: null, bond: null, rate: null }); return { ok: false, why: `the start was not taken: ${String(e.message).slice(0, 200)}` }; }
      txid = row.start;
    }
    filedNow(proofId, { ...row, start: txid });
    return { ok: true, txid };
  }
  /** FILINGS A STOP LEFT: sent again, the very bytes, before anything else (a start the chain holds has its bond started, so no pass would file it again). */
  async function resume() {
    const done = [];
    for (const r of db.prepare('SELECT proof_id FROM slash_fee_coins WHERE state = ?').all(FEE_COIN.FILING)) {
      const got = await sendFiling(new Uint8Array(r.proof_id)).catch((e) => ({ ok: false, why: e.message }));
      log(got.ok ? `[slash] a start filed before a stop was sent again: ${got.txid}` : `[slash] a start filed before a stop was not taken again: ${got.why}`);
      done.push({ resumed: true, ...got });
    }
    return done;
  }

  /** One filing: { ok, txid, signers } or { ok: false, why, refused }. */
  async function file({ bytes, said, entry, entries }) {
    const proofId = fraudProofHash(bytes), idHex = toHex(proofId);
    const { presig, holdScript, why } = holdsFor(entry, said.roundId, said.contract);
    if (!presig) return { ok: false, why: why || 'this seat holds no slash_presig of that bond' };
    const fee = await feeFor(idHex);
    if (!fee.ok) return fee;
    const censusKey = entry.advert.censusKey, nodeKey = entry.pubkey, keyHex = toHex(censusKey);
    const tip = await tipHeight();
    const { tx, prevouts } = buildSlashStart({ bond: bondOf(entry), holdScript, proofId, slashHeight: tip, hint: HINT, fee });
    const threshold = thresholdOf(keyHex);
    if (!threshold) return { ok: false, why: `this seat reads no threshold for key ${keyHex.slice(0, 16)}` };
    const request = { proof: toHex(bytes), presig: toHex(presig), tx: txJson(tx), prevouts: coinsJson(prevouts) };
    const digest = slashStartDigest({ tx, prevouts, nodeKey, censusKey });
    const got = await gatherCensusSignature({ asker, request, digest, publicKey: censusKey, threshold, urls: urlsOf(entries), own: store.held(censusKey) ? signer : null, fetchFn });
    if (!got.ok) return got;
    const feeWitness = scriptPathWitness({ stack: [schnorr.sign(tapSighash({ ...tx, prevouts, inputIndex: 1, leafHash: fee.leafHash }), fee.secret)], script: fee.leaf, controlBlock: fee.control });
    const control = controlBlockFor('slash', bondKeyOf(nodeKey, entry.advert.bondMaturityHeight, network, censusKey, entry.advert.ownerPubkey)).controlBlock;
    const raw = signedSlashStart({ tx, nodeKey, censusKey, censusSignature: got.signature, presig, control, feeWitness });
    // THE START ON DISK BEFORE IT LEAVES (kanban #1191): its bytes, txid, bond and rate; a stop after the send sends these bytes again, never others
    if (!coinStep(proofId, FEE_COIN.FUNDED, FEE_COIN.FILING, { raw: toHex(raw), start: display(parseTransaction(raw).txid), bond: `${toHex(entry.txid)}:${entry.vout}`, rate: Number(startFeeRate({ startRaw: raw, prevouts })) }))
      return { ok: false, why: 'the fee coin moved while the start was signed' };
    const sent = await sendFiling(proofId);
    if (!sent.ok) return { ...sent, signers: got.signers };
    return { ok: true, txid: sent.txid, signers: got.signers, shares: got.shares, refused: got.refused, size: parseTransaction(raw).outputs.length };
  }

  /** A PROOF HANDED TO THIS SEAT (PUT /slash/<id>): judged on the next pass, not at the door, since a replay costs seconds and the door is anyone's. */
  const handed = (id) => db.prepare('INSERT OR IGNORE INTO slash_handed (proof_id, seen_ms) VALUES (?, ?)').run(id, now());
  const handedProofs = () => db.prepare('SELECT proof_id, seen_ms FROM slash_handed ORDER BY seen_ms DESC LIMIT 256').all().flatMap((r) => {
    const proofId = new Uint8Array(r.proof_id), bytes = bytesOf(proofId);
    return bytes ? [{ proofId, bytes, seenMs: Number(r.seen_ms) }] : [];
  });

  // WHY A PROOF IS NOT FILED, ONCE PER PROOF AND REASON (kanban #972, measured on the slash-release regtest 11-04: proofs were held at 19 seats, no start was filed
  // and nothing said why): a pass that skips one says it the first time
  const skipSaid = new Map();
  const skipped = (p, why) => { const k = toHex(p.proofId); if (skipSaid.get(k) === why) return; skipSaid.set(k, why); if (skipSaid.size > 1024) skipSaid.delete(skipSaid.keys().next().value); log(`[slash] ${k.slice(0, 16)} not filed: ${why}`); };

  // A VERDICT IS ASKED ONCE PER `judgeAgainMs` (measured 2026-11-05 on the #1044 devnet: four proofs a named claim's judge could not say about were judged
  // again every 500 ms pass at seven seats, each judgement an arena-settle run - load 160). A false one is not asked again; an undefined one after judgeAgainMs
  const judged = new Map();
  /** One pass over the proofs this seat holds: nothing is replayed for a bond that is no template-3 unstarted bond of this census, or before this seat's turn. Only a proof this seat's own judge holds to is filed. */
  async function pass() {
    const done = await resume();
    const proofs =[...new Map([...(await heldProofs()), ...handedProofs()].map((p) => [toHex(p.proofId), p])).values()].filter((p) => !filed(p.proofId));
    if (!proofs.length) return done;
    const entries = await entriesAtTip();
    if (!entries) return done;
    for (const p of proofs) {
      const said = judge.read(p.bytes);
      if (!said.ok) { skipped(p, `the proof does not read: ${said.why}`); continue; }
      const entry = entryOf(entries, said.bond);
      if (!entry) { skipped(p, 'its bond is not in the census at the tip'); continue; }
      if (entry.hold) { skipped(p, 'its bond is already held'); continue; }
      if (entry.advert.bondScriptTemplateVersion !== BOND_TEMPLATE_V3) { skipped(p, `its bond is template ${entry.advert.bondScriptTemplateVersion}, not 3`); continue; }
      const keys = [...new Set(entries.map((e) => toHex(e.pubkey)))];
      if (now() - p.seenMs < filerRank(p.proofId, keys, me) * stepMs) continue;
      const k = toHex(p.proofId), last = judged.get(k);
      if (last && (last.verdict === false || now() - last.at < judgeAgainMs)) continue;
      const verdict = await judge(p.bytes);
      if (verdict.verdict !== true) {
        judged.set(k, { verdict: verdict.verdict, at: now() });
        if (judged.size > 4096) judged.delete(judged.keys().next().value);
        skipped(p, `this seat's judge says ${verdict.verdict}: ${String(verdict.why).slice(0, 200)}`); continue;
      }
      let r; try { r = await file({ bytes: p.bytes, said, entry, entries }); } catch (e) { r = { ok: false, why: e.message }; }
      log(r.ok ? `[slash] start filed against ${toHex(entry.pubkey).slice(0, 16)}: ${r.txid}, ${r.signers.length} holders, ${r.shares} shares` : `[slash] no start against ${toHex(entry.pubkey).slice(0, 16)} yet: ${r.why}${r.refused && r.refused.length ? ` (${r.refused.map((x) => x.why).join('; ')})` : ''}`);
      done.push(r);
    }
    return done;
  }
  /** The release or the fallback of a start that repaid this seat's fee coin, confirmed: { txid, vout, value } or null. Read from this seat's own build, else the census' doors; the chain decides. */
  async function repaidOutput(start, script) {
    const asks = [...(ownServed ? [async () => ownServed(start)] : []),
      ...(urlsOf([]) || []).slice(0, 32).map((u) => async () => { const r = await fetchFn(`${u}/slash-release?start=${start}`, { signal: AbortSignal.timeout(15000) }); return r.ok ? r.json() : null; })];
    const tried = new Set();
    for (const ask of asks) {
      let said; try { said = await ask(); } catch { said = null; }
      for (const s of [said && said.release, said && said.fallback]) {
        if (!s || !s.txid || !s.table || tried.has(`${s.txid}:${s.tableId}`)) continue;
        tried.add(`${s.txid}:${s.tableId}`);
        let t; try { t = decodeSlashPayoutTable(fromHex(s.table)); } catch { continue; }
        const i = t.outputs.findIndex((o) => o.pays === 'filer' && toHex(o.script) === toHex(script));
        if (i < 0) continue;
        const out = await txOut(String(s.txid), i + 1).catch(() => null);
        if (out && String(out.script) === toHex(script) && BigInt(out.sats) === t.outputs[i].value) return { txid: String(s.txid), vout: i + 1, value: String(t.outputs[i].value) };
      }
    }
    return null;
  }

  /**
   * THE FILER SWEEPS ITS REPAID FEE (5A.3B: `filer` repays the start's fee input to its own script). Once the release or the fallback that repaid it is confirmed, the coin goes to this node's
   * own wallet at the start's own rate. Once each: what was sent is kept, a send the chain already holds counts as sent, and the output gone after that is the end of it.
   */
  const asked = new Map();
  async function sweep() {
    const done = [];
    if (typeof txOut !== 'function') return done;
    const rows = db.prepare('SELECT s.proof_id, s.txid AS start, f.rate, f.state FROM slash_starts s LEFT JOIN slash_fee_sweeps f ON f.proof_id = s.proof_id').all();
    for (const r of rows) {
      const state = r.state ? JSON.parse(r.state) : {};
      if (state.done) continue;
      const rate = BigInt(r.rate ?? SLASH_SPEND_FEE_RATE_FLOOR);
      const keep = () => db.prepare('INSERT INTO slash_fee_sweeps (proof_id, rate, state) VALUES (?, ?, ?) ON CONFLICT (proof_id) DO UPDATE SET state = excluded.state').run(r.proof_id, Number(rate), JSON.stringify(state));
      const key = feeKeyOf(new Uint8Array(r.proof_id));
      try {
        if (!state.txid) {
          if (now() - (asked.get(r.start) ?? -Infinity) < sweepEveryMs) continue;
          asked.set(r.start, now());
          const found = await repaidOutput(r.start, key.script);
          if (!found) continue;
          Object.assign(state, found);
          keep();
        }
        const out = await txOut(state.txid, state.vout);
        if (!out) {
          // GONE AFTER IT WAS SEEN: only this key spends it, so that is the sweep
          if (state.sweep) { state.done = true; keep(); done.push({ start: r.start, swept: state.sweep, done: true }); }
          continue;
        }
        // SENT, NOT YET IN A BLOCK: sent again now and then, the same txid, in case a mempool dropped it
        if (state.sweep && now() - (asked.get(r.start) ?? -Infinity) < sweepEveryMs) continue;
        asked.set(r.start, now());
        if (!state.to) { const to = await returnScript(); if (!to) { done.push({ start: r.start, why: 'this node names no wallet to sweep its repaid fee to' }); continue; } state.to = toHex(to); keep(); }
        const to = fromHex(state.to), value = BigInt(state.value);
        const input = { txid: fromHex(state.txid).reverse(), vout: state.vout, sequence: 0xfffffffd };
        const vsize = vsizeOfSpend({ version: 2, locktime: 0, inputs: [input], outputs: [{ value, script: to }], witnesses: [scriptPathWitness({ stack: [new Uint8Array(64)], script: key.leaf, controlBlock: key.control })] });
        const left = value - rate * BigInt(vsize);
        if (left < P2TR_DUST_SATS) { done.push({ start: r.start, why: `${value} sat at ${rate} sat/vB leaves ${left} sat, below dust` }); continue; }
        const outputs = [{ value: left, script: to }];
        const sig = schnorr.sign(tapSighash({ version: 2, locktime: 0, inputs: [input], outputs, prevouts: [{ value, script: key.script }], inputIndex: 0, leafHash: key.leafHash }), key.secret);
        const raw = serializeSpend({ version: 2, locktime: 0, inputs: [input], outputs, witnesses: [scriptPathWitness({ stack: [sig], script: key.leaf, controlBlock: key.control })] });
        const txid = display(parseTransaction(raw).txid);
        try { await send(toHex(raw)); } catch (e) { if (!ALREADY.test(e.message)) { done.push({ start: r.start, why: `the sweep was not taken: ${e.message}` }); continue; } }
        const again = !!state.sweep;
        state.sweep = txid;
        keep();
        if (again) continue;
        log(`[slash] repaid fee of start ${r.start.slice(0, 16)} swept: ${txid}, ${left} sat`);
        done.push({ start: r.start, swept: txid, sats: left });
      } catch (e) { done.push({ start: r.start, why: e.message }); }
    }
    return done;
  }

  return { pass, file, handed, sweep, takeCommit: signer.takeCommit, takeShare: signer.takeShare, check, signer };
}
