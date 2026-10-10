// A MARKET IN THE PAGE (kanban #206 slice 2, §0A.7a; the owner 2026-10-07, decisions A and B of plan 777): the pick sheet's
// model, the pick handed to the seats, the outcome checked by the page itself, and the lines the lobby draws.
//
// - The sheet (#blwp-pick in index.html) is drawn from `pickSheet`: one button per outcome, the stake, the 5% fee line and
//   the 0-5% donation line. Outcome labels and attestor keys come from the page's PINNED known-games list (`marketOf`),
//   never from a node; a market the page does not pin is read from its signed manifest (GET /game-manifest, checked to hash
//   to the round's game id) and staked on only after the second confirmation (§0A.6) - `needsConfirm`.
// - A pick plays no run: the page hands the entry and its locks to the seats itself (`submitPick`), no session opens, and
//   the join ends in state `picked` - Unity does not take it over.
// - The outcome is the seats' GET /outcome, but believed only once its attestation verifies against the attestors the page
//   pinned (`checkAttestation`, Ed25519 through WebCrypto); otherwise it is shown as unverified and nothing is concluded.
import { stakeOf } from './join.js';
import { decodeManifest, gameIdOf, isAttested, RESULT_TYPE } from '../../arena-protocol/src/manifest.js';
import { decodeAttestation, attestationStands, attestationBodyId } from '../../arena-protocol/src/attested.js';
import { marketOf, feeOfKnownGame } from '../../arena-protocol/src/known-game.js';
import { entryFeeMsat, feeBpsOf, donationBpsOf } from '../../arena-protocol/src/fee.js';
import { termsOfKnownGame } from '../../arena-protocol/src/known-game.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { handLock } from './page-lock.js';
import { cancelId, sellId, PRICE_SCALE } from '../../arena-protocol/src/order-book.js';

const sats = (msat) => (Number(BigInt(msat)) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });

/**
 * THE MARKET A ROUND PLAYS, as this page may stake on it: pinned (`known: true`), or - for a game the page does not pin -
 * from the manifest a seat served, only if that manifest IS the round's game (its id) and is attested; `needsConfirm` then.
 * null for a round that is not a market.
 */
export function marketForRound(round, { manifestBytes = null } = {}) {
  if (!round || !(round.gameId instanceof Uint8Array)) return null;
  const pinned = marketOf(round.gameId);
  // ITS FEE (kanban #235): a market's own, from its manifest, or the market default 0.5 % + 0.5 %
  // AND ITS TERMS (kanban #236): resolution delay and void deadline - what its rounds' lock span is checked by (lock-expiry.js)
  if (pinned) return { ...pinned, needsConfirm: false, fee: feeOfKnownGame(round.gameId), terms: termsOfKnownGame(round.gameId) };
  if (!manifestBytes) return null;
  let m;
  try { m = decodeManifest(manifestBytes instanceof Uint8Array ? manifestBytes : fromHex(String(manifestBytes))); } catch { return null; }
  if (toHex(gameIdOf(m)) !== toHex(round.gameId) || !isAttested(m)) return null;
  return { gameId: toHex(round.gameId), name: m.gameName, known: false, needsConfirm: true, outcomes: [...m.outcomes],
    attestors: m.attestors.map(toHex), threshold: m.attestThreshold, devKey: toHex(m.gameDevPubkey), networks: [],
    fee: { nodeBps: feeBpsOf(m), donationBps: donationBpsOf(m) }, terms: m.marketTerms || null };
}

/**
 * THE PICK SHEET: the market's outcomes as buttons, and what a pick costs out of the stake - the fee (5%, §0A.8), the
 * donation (0-5%, the player's own setting) and the net stake that is at risk. An unpinned market carries the second
 * confirmation's words: its developer key and manifest id.
 */
// `contract`: the round's (its stake is read here, so the page names no contract field); `stakeMsat` instead, for a caller with no
// contract at hand.
export function pickSheet({ market, contract = null, stakeMsat = contract ? contract.stakeMsat : 0n }) {
  const stake = BigInt(stakeMsat);
  // THE MARKET'S OWN RATES (kanban #235): its node fee and its donation (0.5 % + 0.5 % by default), DUE WHEN THE PICK FILLS -
  // at entry close (the owner 2026-10-09): they sit in the fee lock beside the stake, are paid out when the market resolves from
  // winners and losers alike, and come back whole on a cancel before entry close, a VOID or a market nobody picked right
  const rates = market.fee || { nodeBps: 50, donationBps: 50 };
  const fee = entryFeeMsat(stake, rates.nodeBps + rates.donationBps);
  const pct = (bps) => `${(bps / 100).toFixed(bps % 100 ? (bps % 10 ? 2 : 1) : 0)}%`;
  const net = stake - fee;
  return {
    title: `${market.name} - pick one`,
    outcomes: market.outcomes.map((label, index) => ({ index, label })),
    lines: {
      stake: `stake ${sats(stake)} sats`,
      fee: `fees ${pct(rates.nodeBps + rates.donationBps)}: ${sats(fee)} sats - ${pct(rates.nodeBps)} nodes + ${pct(rates.donationBps)} donation `
        + `(half to the protocol devs, half to ${market.name}'s dev), due once your pick is in at entry close - cancel before that costs nothing; `
        + 'back in full if the market is void or nobody picked right',
      net: `at risk on your pick: ${sats(net)} sats`,
    },
    stakeMsat: stake, feeMsat: fee, donationMsat: 0n, netMsat: net,
    attestors: `outcome by ${market.threshold} of ${market.attestors.length} attestors named by ${market.name}'s dev`,
    confirm: market.needsConfirm
      ? `${market.name} is not on this page's list of known markets. Its developer key is ${market.devKey.slice(0, 16)}… and its manifest ${market.gameId.slice(0, 16)}…; `
        + 'only its attestors decide the outcome. Stake on it anyway?'
      : null,
  };
}

/**
 * HAND A PICK TO THE ROUND'S SEATS (no session, no run): the entry to every seat, then its stake lock and fee lock as the
 * client hands them (`handLock`). Answers each seat's word and the entry id.
 */
// `onEntries` (kanban #293, measured on the paid regtest stack: a paid head-to-head tap was counted only after the guardians
// accepted its lock and the 7 seats had each checked it - 6.5 s median at load 30-47; the seats had taken the entry at ~2.8 s):
// called with { entryId, entries } as soon as the seats answered the entry, while the locks are handed after it
export async function submitPick({ entry, stakeLock, nodes, fetcher = fetch, onEntries = null }) {
  const eid = entryId(entry);
  const bytes = encodeEntryContract(entry);
  const entries = await Promise.all(nodes.map(async (node) => {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/entry`, { method: 'POST', body: bytes });
      return { node, status: r.status, why: r.status === 201 ? null : (await r.text()).trim() };
    } catch (e) { return { node, status: 0, why: e.message }; }
  }));
  const took = entries.filter((x) => x.status === 201).map((x) => x.node);
  if (onEntries) { try { onEntries({ entryId: toHex(eid), entries }); } catch { /* the caller's own fault */ } }
  if (!took.length) return { ok: false, entryId: toHex(eid), entries, why: entries.map((x) => `${x.node}: ${x.why}`).join('; ') };
  if (!stakeLock) return { ok: took.length === nodes.length, entryId: toHex(eid), entries, lock: null, feeLock: null };
  // THE LOCKS ONCE THE GUARDIANS ACCEPTED THEM, AND AGAIN TO A SEAT THAT REFUSED (kanban #237, measured on the regtest market
  // stack): handed once, at once, while the federation was still accepting the lock, every seat that looked first refused it
  // and none was asked again - so the order was tradable nowhere (a batch needs 5 seats holding its locks). The first pass
  // after acceptance is awaited; the seats still refusing are asked again in the background until the round's entry closes
  // (`stakeLock.handUntilMs`) or LOCK_HAND_MS passes - `handing` is that whole.
  if (stakeLock.accepted && typeof stakeLock.accepted.then === 'function') {
    try { await stakeLock.accepted; } catch (e) { return { ok: false, entryId: toHex(eid), entries, why: `the stake lock was not accepted: ${e.message}` }; }
  }
  const kinds = [{ door: 'lock', fields: stakeLock.fields }, ...(stakeLock.feeLock ? [{ door: 'fee-lock', fields: stakeLock.feeLock.fields }] : [])];
  const tookLock = new Map(kinds.map((k) => [k.door, new Set()]));
  const said = {};
  const pass = async () => {
    await Promise.all(kinds.map(async (k) => {
      const left = took.filter((n) => !tookLock.get(k.door).has(n));
      if (!left.length) return;
      const r = await handLock({ entryId: eid, fields: k.fields, nodes: left, needed: 0, fetcher, door: k.door });
      for (const x of r.said) if (x.status === 201) tookLock.get(k.door).add(x.node);
      said[k.door] = { committed: tookLock.get(k.door).size, needed: took.length, said: r.said };
    }));
  };
  await pass();
  const until = Math.max(Date.now() + LOCK_HAND_MS_PICK, Number(stakeLock.handUntilMs || 0));
  const handing = (async () => {
    for (let pause = 1000; Date.now() < until && kinds.some((k) => tookLock.get(k.door).size < took.length); pause = Math.min(pause * 2, 15000)) {
      await new Promise((r) => setTimeout(r, pause));
      await pass();
    }
    return said;
  })();
  return { ok: took.length === nodes.length, entryId: toHex(eid), entries, lock: said.lock || null, feeLock: said['fee-lock'] || null, handing };
}
const LOCK_HAND_MS_PICK = 120000;

/**
 * THE TAB'S RECORD OF A PICK (what the lobby's market lines are made of): its round, entry and pick, its market's game, its
 * stake and entry close as the round's contract says them, and the signer nodes to ask for its outcome.
 */
export function pickRecord({ roundIdHex, entryIdHex, pick, round, nodes, confirmed = false }) {
  return { roundIdHex, entryIdHex, pick, gameId: toHex(round.gameId), stakeMsat: String(stakeOf(round)), entryCloseMs: String(round.entryCloseMs),
    nodes: [...nodes], confirmed: !!confirmed };
}

/** Ed25519 through the browser's WebCrypto; null where the browser cannot (the attestation is then shown unverified). */
export async function webCryptoEd25519(signature, message, key) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return null;
  try {
    const k = await subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
    return await subtle.verify({ name: 'Ed25519' }, k, signature, message);
  } catch { return null; }
}

/**
 * IS THE SEATS' OUTCOME THE ATTESTORS'? The attestation's own bytes (GET /outcome), checked against the market this page
 * pinned (or confirmed): its round, an outcome in range, the threshold of distinct named attestors, every signature good.
 * `verify(signature, digest, key)` may be async (WebCrypto); a verifier that cannot answer leaves it `unverifiable`.
 */
export async function checkAttestation({ attestationHex, market, roundIdHex, verify = webCryptoEd25519 }) {
  let a;
  try { a = decodeAttestation(fromHex(String(attestationHex))); } catch (e) { return { verified: false, why: `not an attestation: ${e.message}` }; }
  const digest = attestationBodyId(a);
  const said = new Map();
  for (const s of a.signatures) {
    const v = await verify(s.signature, digest, s.key);
    if (v === null) return { verified: false, unverifiable: true, why: 'this browser cannot check Ed25519 signatures: the outcome is shown unverified' };
    said.set(`${toHex(s.key)}:${toHex(s.signature)}`, v === true);
  }
  const manifest = { gameName: market.name, resultType: RESULT_TYPE.ATTESTED, outcomes: market.outcomes,
    attestors: market.attestors.map((k) => fromHex(k)), attestThreshold: market.threshold };
  const stands = attestationStands(a, { manifest, roundIdBytes: fromHex(roundIdHex),
    verify: (sig, _d, key) => said.get(`${toHex(key)}:${toHex(sig)}`) === true });
  return stands.ok ? { verified: true, outcome: stands.outcome, label: stands.label, why: stands.why } : { verified: false, why: stands.why };
}

/**
 * THE LOBBY'S MARKET LINES (Unity draws them under the round rows, kind 'market'): for each pick this page made, the pick
 * while its round is open, then the outcome as the page checked it, and what it means for this pick.
 * `picks`: [{ roundIdHex, entryIdHex, market, pick, stakeMsat, entryCloseMs }]; `outcomes`: Map roundIdHex -> the seats'
 * GET /outcome answer with `check` (checkAttestation's) added.
 */
export function marketLines({ picks, outcomes = new Map(), nowMs = Date.now() }) {
  const lines = [];
  const left = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  for (const p of picks) {
    const label = p.market.outcomes[p.pick];
    const head = `${p.market.name} ${p.roundIdHex.slice(0, 8)}`;
    const o = outcomes.get(p.roundIdHex);
    if (nowMs < Number(p.entryCloseMs)) {
      lines.push({ kind: 'market', text: `${p.market.name}: you picked '${label}' · ${sats(p.stakeMsat)} sats · closes in ${left(Number(p.entryCloseMs) - nowMs)}` });
      continue;
    }
    if (!o || o.state === 'OPEN') {
      lines.push({ kind: 'market', text: `${head}: you picked '${label}' · waiting for the outcome · ${p.market.threshold} of ${p.market.attestors.length} attestors` });
      continue;
    }
    if (o.state === 'DISPUTED') {
      lines.push({ kind: 'market', text: `${head}: the attestors contradicted themselves, nothing is paid; your stake comes back at expiry` });
      continue;
    }
    const check = o.check || { verified: false, why: 'not checked yet' };
    if (!check.verified) {
      lines.push({ kind: 'market', text: `${head}: the signer nodes say '${o.label}' - UNVERIFIED (${check.why})` });
      continue;
    }
    const row = o.table && o.table.rows ? o.table.rows.find((r) => r.entryId === p.entryIdHex) : null;
    const signed = `'${check.label}' (${p.market.threshold} of ${p.market.attestors.length} attestors, verified)`;
    if (!row) { lines.push({ kind: 'market', text: `${head}: ${signed} · your pick is not in the signer nodes' table` }); continue; }
    const net = BigInt(row.netMsat);
    const pay = BigInt(row.payoutMsat);
    // A FREE ROUND: nothing staked, so the pick was right or wrong and nothing more
    if (BigInt(p.stakeMsat) === 0n) lines.push({ kind: 'market', text: `${head}: ${signed} · ${row.won ? 'your pick was right' : 'your pick was wrong'} (free round)` });
    else if (o.table.refunded) lines.push({ kind: 'market', text: `${head}: ${signed} · nobody picked it: your ${sats(net)} sats come back` });
    else if (row.won) lines.push({ kind: 'market', text: `${head}: ${signed} · you won ${sats(pay - net)} sats${o.final ? '' : ' (final after the objection window)'}` });
    else lines.push({ kind: 'market', text: `${head}: ${signed} · you lost ${sats(net)} sats` });
  }
  return lines;
}

// AN ORDER'S OWN MESSAGES (kanban #237): what its session key signs to cancel it, or to sell its shares back, before the
// market resolves (protocol order-book.js) - here so the page's bundle carries them (the bundle takes no import aliases)
export function orderCancelId({ roundId, entryId }) { return cancelId({ roundId, entryId }); }
export function orderSellId({ roundId, entryId, outcome, price, sharesMsat, nonce }) { return sellId({ roundId, entryId, outcome, price, sharesMsat, nonce }); }
/** The order book's price scale: a limit price of PRICE_SCALE is certainty (1 sat per share). */
export const ORDER_PRICE_SCALE = Number(PRICE_SCALE);
