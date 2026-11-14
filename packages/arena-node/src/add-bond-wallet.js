// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ADD TO BOND FROM A BOND WALLET (kanban #553, 2026-10-20: "Add bond needs to be posted from within the interface"): a seat set up
// by hand has no installer home (no arena.conf, no installer wallet), so the owner page could only tell its owner to run a command. Such a
// seat names the Bitcoin Core wallet its bonds were paid from - ARENA_BOND_CLI, a bitcoin-cli command line with its -datadir and
// -rpcwallet - and the owner page adds to its bond as on an installed node: a SECOND bond output beside the first (protocol 19 counts both
// as one), its body the seat's own newest advertisement (tools/testnet4-add-bond.mjs, kanban #544), funded from that wallet.
//
//   ARENA_BOND_CLI="/path/bitcoin-cli -datadir=/path -rpcwallet=bonds"   (or the same with commas)
//
// Without `post` it builds both transactions and checks them with testmempoolaccept; with it, broadcasts them.
import { execFileSync } from 'node:child_process';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { recognizeBond } from '../../arena-protocol/src/chain.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../../arena-protocol/src/constants.js';
import { BOND_TEMPLATE_V2, BOND_TEMPLATE_V3 } from '../../arena-protocol/src/bond-script.js';
import { NO_CENSUS_KEY_READ, readsTemplate3Only } from '../../arena-protocol/src/genesis.js';
import { bondSetFor } from './curve.js';

const CARRIER_FEE = 3000n;
/** WHAT ADDING COSTS BESIDE THE AMOUNT (kanban #553: the page says "send N sat", worked out): the bond output's dust (330), the carrier's fee and
 *  what it keeps for the bond transaction (1,000), and about 500 sat for the funding transaction at 2 sat/vB. */
export const ADD_OVERHEAD_SATS = 330n + CARRIER_FEE + 1000n + 500n;
const MIN_ADD = 1000n;
/** A TEMPLATE-3 BOND'S UPDATE (5A.3B, kanban #1053), funded by the bond's own funding transaction: the marker, its fee and a little change. */
const PRESIG_CARRIER_SATS = 3000n;
/** The bond wallet's command line from the environment, or null: { cli(...args) -> stdout, wallet }. */
export function bondCliFrom(env = process.env) {
  // words apart by spaces or commas (a launcher that passes its settings as one space-split list writes them with commas)
  const words = String(env.ARENA_BOND_CLI || '').trim().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return null;
  const [bin, ...base] = words;
  const w = base.find((x) => x.startsWith('-rpcwallet='));
  return { cli: (...a) => execFileSync(bin, [...base, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 }).trim(), wallet: w ? w.slice('-rpcwallet='.length) : null };
}

/**
 * THE PLAN, AND WITH `post` THE TWO TRANSACTIONS SENT. { ok, plan: { addSats, bondSats, totalSats, fees: { total }, maturity, lock: { estimatedMs },
 * countsAfter }, bond?: { txid } } or { ok: false, why }. `blockMs` the chain's block interval, for the time estimate only.
 * `censusKey` the newest standing census key on a network that has one: the new output is then template 3 and names it (5A.3B), with its slash_presig in an update sent beside it, since
 * such a bond counts only with that presig. The funding transaction pays both carriers, so the two are one step.
 */
/**
 * ONE OWNER ACTION SENT, NOT TWO (kanban #1374, audit 2 #1204 FED-C4 / INSTALLER-DOORS-15; #1165 fixed only the installer's path): what a post is about to
 * broadcast is kept first (`journal.keep(kind, record)`, the seat's store), and the same request again - its key, or with no key the same amount or roles
 * within SAME_ACTION_MS - while that transaction is not confirmed answers the one kept and broadcasts its bytes again, in place of funding a second.
 */
export const SAME_ACTION_MS = 30 * 60_000;
const rebroadcast = (cli, hexes) => { for (const h of hexes) { try { cli('sendrawtransaction', h); } catch { /* in the mempool or mined already */ } } };
// THE KEPT ACTION'S TRANSACTION IS REALLY THERE (audit 6, kanban #1423): the journal is written before the broadcast (#1374), so a broadcast that threw
// left a row for a transaction no node holds, and the same ask answered "already" with nothing sent. After the rebroadcast it must be in this node's
// mempool or mined (`confirmed`); else the row is stale and the action is built again
// ONLY "NOT FOUND" IS "NOT THERE" (audit 6 re-check N8, kanban #1426): a busy or restarting bitcoind's error read as missing, and the same add was built
// and sent a second time; any other error answers "already" - the safe side, the kept bytes were re-sent above
const notFound = (e) => /not in mempool|No such mempool|No such mempool or blockchain transaction|Invalid or non-wallet transaction id|-5\b/i.test(`${e && e.message} ${e && e.stderr}`);
const txThere = (cli, txid, confirmed = false) => { if (confirmed) return true;
  try { cli('getmempoolentry', txid); return true; } catch (e) { if (!notFound(e)) return true; }
  try { const t = JSON.parse(cli('gettransaction', txid)); return Number(t.confirmations) > 0; } catch (e) { return !notFound(e); } };
// THE ADVERTISEMENT IN FORCE IS THE NEWEST ONE SENT, NOT ONLY THE NEWEST MINED (state audit 2026-11-12, kanban #2182): newestUpdateOf reads mined
// markers only, so while the owner's roles change sat in the mempool the seat's own check (advert-self -> guardianOfFromWallet) built its update from
// the advertisement before it - old roles, guardian-capable again - and sent it after: the census reads the one mined last, the owner's change was
// undone on the chain and asked again answered "already". Every update of a hand-set seat is built on top of the newest one sent while that is
// unconfirmed: the one sent in this process (`sentUpdates`), and the owner's roles change kept in owner_actions (`ownerRoles`, read by the advert
// worker, which has its own module); the roles door refuses while advert-self's own update (`waitFor`) is unconfirmed.
const sentUpdates = new Map();   // `${bond txid}:${vout}` -> { txid, advert } of the update this process sent last
const inMempool = (cli, txid) => { if (!txid) return false; try { cli('getmempoolentry', String(txid)); return true; } catch (e) { return !notFound(e); } };
function advertInForce(cli, rt, bond, ownerRoles = null) {
  const at = `${bond.txid}:${bond.vout}`;
  const mined = (rt.newestUpdateOf(bond) || {}).advert || bond.advert;
  const sent = sentUpdates.get(at);
  if (sent && inMempool(cli, sent.txid)) return sent.advert;
  const r = ownerRoles, a = r && r.plan && r.plan.after;
  if (a && Array.isArray(a.roles) && r.plan.bond === at && inMempool(cli, r.txid))
    return { ...mined, roles: [...a.roles], guardianCapable: !!a.custody, ...(a.custody ? {} : { guardianEndpoint: '' }) };
  return mined;
}
const sameAction = (was, { key, what, nowMs }) => !!was && (key ? was.key === key : (!was.key && was.what === what && nowMs - Number(was.atMs || 0) < SAME_ACTION_MS));

/**
 * THE ADVERTISEMENT IN FORCE, READ AS THE CENSUS READS IT (kanban #1836; census.js newestPerNode, protocol 19): of the node's bond outputs
 * (`bondsOf` records, each with its own newest update as `advert`), the one whose advertisement is newest - its update's height, else the
 * output's own; an update before an output's own body at the same height, then the larger txid. bondsOf()[0] is the newest OUTPUT by
 * height: with an output added beside the first (kanban #544) and the step-out update posted on the largest, it was the added one's stale
 * body that each of the seat's own posts (its check, roles, add to bond) built on - serving = true, and the stepped-out node was back in
 * every census, never asked. Answers the record, or null for none.
 */
export function inForceOf(bonds) {
  // ONLY THE NEWEST BODY IS IN FORCE (kanban #2426): a body the node signed before, re-posted by anyone as an update of one of its outputs,
  // is older than the newest the node signed - so of the outputs, only those whose advertisement carries the highest signed timestamp
  // are read (all, when a record carries none)
  const tsOf = (a) => { try { return a && a.timestamp !== undefined && a.timestamp !== null ? BigInt(a.timestamp) : null; } catch { return null; } };
  const all = (bonds || []).filter(Boolean);
  const stamps = all.map((b) => tsOf(b.advert));
  const top = stamps.every((t) => t !== null) && stamps.length ? stamps.reduce((m, t) => (t > m ? t : m)) : null;
  let best = null;
  for (const b of top === null ? all : all.filter((x, i) => stamps[i] === top)) {
    const c = b.updatedBy ? { b, height: b.updatedBy.height, pos: 0, tie: String(b.updatedBy.txid || '').toLowerCase() }
      : { b, height: b.height, pos: -1, tie: String(b.txid || '').toLowerCase() };
    if (!best || c.height > best.height || (c.height === best.height && (c.pos > best.pos || (c.pos === best.pos && c.tie > best.tie)))) best = c;
  }
  return best ? best.b : null;
}

export async function addBondFromWallet({ cli, wallet, network = 'testnet4', secret, pubkey, addSats, post = false, blockMs = 600000, now = Date.now(), censusKey = null, key = null, journal = null }) {
  // A NETWORK THAT READS TEMPLATE 3 ONLY NEVER FALLS BACK (5A.3B, kanban #1065): no key read, no bond
  if (!censusKey && readsTemplate3Only(network)) return { ok: false, why: NO_CENSUS_KEY_READ };
  let add; try { add = BigInt(String(addSats)); } catch { return { ok: false, why: 'name the sat to add as a whole number' }; }
  if (add < MIN_ADD) return { ok: false, why: `add at least ${MIN_ADD} sat` };
  const { regtest } = await import('../tools/regtest-bond.mjs');
  const rt = regtest(cli, { network, wallet: wallet || 'arena' });
  const bonds = rt.bondsOf(secret);
  if (!bonds.length) return { ok: false, why: 'this node has no confirmed bond to add to yet' };
  const bondSats = bonds.reduce((a, b) => a + BigInt(b.sats), 0n);
  // THE SAME ADD ASKED AGAIN (kanban #1374): the one sent before, while its bond is not confirmed yet
  if (post && journal) {
    const was = journal.last('add-bond');
    if (sameAction(was, { key, what: String(add), nowMs: now }) && !bonds.some((b) => b.txid === was.bondTxid)) {
      rebroadcast(cli, was.hexes || []);
      if (txThere(cli, was.bondTxid)) return { ok: true, plan: was.plan, bond: was.bond, already: true };
      // never sent (kanban #1423): built and sent anew below
    }
  }
  const newest = inForceOf(bonds);   // the advertisement in force, as the census reads it (kanban #1836), not bonds[0]
  const versions = [...new Set([...(newest.advert.protocolVersions || []), ...SUPPORTED_PROTOCOL_VERSIONS])].sort((a, b) => a - b);
  const bondAdvert = { ...newest.advert, protocolVersions: versions };
  const template = censusKey ? BOND_TEMPLATE_V3 : BOND_TEMPLATE_V2;
  // only its length matters here: postBond sets the same template, height and census key
  const presig = censusKey ? rt.presigCarrier({ ...bondAdvert, bondScriptTemplateVersion: BOND_TEMPLATE_V3, bondMaturityHeight: 1, censusKey }) : null;
  const addressOf = (spk) => JSON.parse(cli('decodescript', toHex(spk))).address;
  let fundingHex = null, fundingFee = 0n, made, fundingDecoded = null;
  try { made = rt.postBond(secret, { advert: bondAdvert, bondSats: add, template, censusKey, utxo: (spk) => {
    const address = addressOf(spk);
    const value = add + 330n + CARRIER_FEE + 1000n;
    const outputs = [{ [address]: Number(value) / 1e8 }, ...(presig ? [{ [addressOf(presig.spk)]: Number(PRESIG_CARRIER_SATS) / 1e8 }] : [])];
    let funded;
    try { funded = JSON.parse(cli('-named', 'walletcreatefundedpsbt', 'inputs=[]', `outputs=${JSON.stringify(outputs)}`,
      `options=${JSON.stringify({ include_unsafe: true, fee_rate: 2 })}`)); }
    catch (e) {
      if (!/Insufficient funds/i.test(String(e.stderr || e.message))) throw e;
      const have = walletOf(cli).spendableSats;
      throw Object.assign(new Error(`the bond wallet holds ${have} sat that can be spent, and adding ${add} sat needs about ${value + 500n + (presig ? PRESIG_CARRIER_SATS : 0n)} sat: top it up first`), { plain: true });
    }
    fundingFee = BigInt(Math.round(Number(funded.fee) * 1e8));
    const final = JSON.parse(cli('finalizepsbt', JSON.parse(cli('walletprocesspsbt', funded.psbt)).psbt));
    if (!final.complete) throw new Error('the bond wallet did not sign the funding transaction');
    fundingHex = final.hex;
    const d = JSON.parse(cli('decoderawtransaction', fundingHex));
    fundingDecoded = d;
    return { txid: d.txid, vout: d.vout.find((o) => o.scriptPubKey.hex === toHex(spk)).n, value };
  } }); } catch (e) { if (e.plain) return { ok: false, why: e.message }; throw e; }
  const update = presig ? rt.postBondPresig(secret, made, { carrier: presig,
    utxo: { txid: fundingDecoded.txid, vout: fundingDecoded.vout.find((o) => o.scriptPubKey.hex === toHex(presig.spk)).n, value: PRESIG_CARRIER_SATS } }) : null;
  const tx = parseTransaction(fromHex(made.hex));
  const advert = advertInTransaction(tx);
  if (!advert || toHex(advert.nodePubkey) !== toHex(pubkey) || advert.operatorId !== newest.advert.operatorId)
    return { ok: false, why: 'the added bond does not read back as this node\'s advertisement; nothing was sent' };
  const seen = recognizeBond(tx, 0, advert, { network, bond: bondSetFor(network) });
  if (!seen.ok) return { ok: false, why: `the added bond would not be recognised (${seen.why}); nothing was sent` };
  const sends = [fundingHex, made.hex, ...(update ? [update.hex] : [])];
  const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify(sends)));
  if (!accept.every((a) => a.allowed)) return { ok: false, why: `the network would refuse it (${accept.map((a) => a['reject-reason']).filter(Boolean).join(', ')}); nothing was sent` };
  const tip = Number(cli('getblockcount'));
  // the added output's own fee is the carrier's, beside the 1,000 sat the carrier output keeps for the bond transaction
  const plan = { addSats: String(add), bondSats: String(bondSats), totalSats: String(bondSats + add), fees: { total: String(fundingFee + CARRIER_FEE + (update ? PRESIG_CARRIER_SATS : 0n)) }, template,
    maturity: made.maturity, lock: { estimatedMs: now + Math.max(0, made.maturity - tip) * blockMs }, countsAfter: 6 };
  if (!post) return { ok: true, plan };
  const bond = { txid: made.txid, ...(update ? { presigUpdate: update.txid } : {}) };
  // KEPT BEFORE IT IS SENT (kanban #1374): a lost answer, a restart or a second click finds it
  if (journal) journal.keep('add-bond', { key, what: String(add), atMs: now, hexes: sends, bondTxid: made.txid, bond, plan });
  for (const hex of sends) cli('sendrawtransaction', hex);
  return { ok: true, plan, bond };
}

/** THE BOND WALLET'S COINS: what it can spend now and what is still confirming, in sat. */
export function walletOf(cli) {
  const b = JSON.parse(cli('getbalances')).mine || {};
  const sat = (x) => BigInt(Math.round(Number(x || 0) * 1e8));
  return { spendableSats: sat(b.trusted), confirmingSats: sat(b.untrusted_pending) + sat(b.immature) };
}
/** A NEW ADDRESS of the bond wallet, to top it up (bech32m). */
export const walletAddress = (cli) => cli('getnewaddress', 'add-bond', 'bech32m');

/** WHAT AN ADVERTISEMENT CAN SAY THE NODE DOES (constants.js ROLES), and custody: its guardian_capable flag. */
export const ADVERT_ROLES = Object.freeze(['game', 'verify', 'settlement', 'relay', 'audit']);
const UPDATE_CARRIER_SATS = 3000n;
/**
 * THE NODE'S ROLES CHANGED FROM THE OWNER PAGE (kanban #553, 2026-10-20: "It also offers no options to setup the role of the node";
 * "I should be still able to setup the roles"): an advertisement update (§5A.2) of the node's newest bond - its advertisement as it stands,
 * with `roles` (a subset of ADVERT_ROLES) and `custody` (guardian_capable) as asked and a new timestamp - its carrier funded from the bond
 * wallet. No bond is spent and no maturity clock starts. Without `post` both transactions are built and checked (testmempoolaccept);
 * with it, sent. The census reads the new roles once the update is 6 deep.
 */
export async function changeRolesFromWallet({ cli, wallet, network = 'testnet4', secret, pubkey, roles, custody, post = false, key = null, journal = null, nowMs = Date.now(), waitFor = null }) {
  const want = [...new Set((roles || []).map(String))];
  const bad = want.filter((r) => !ADVERT_ROLES.includes(r));
  if (bad.length) return { ok: false, why: `${bad.join(', ')}: not a role an advertisement names (${ADVERT_ROLES.join(', ')})` };
  if (!want.length && !custody) return { ok: false, why: 'a node with no role at all serves nothing: keep at least one' };
  const { regtest } = await import('../tools/regtest-bond.mjs');
  const rt = regtest(cli, { network, wallet: wallet || 'arena' });
  const bonds = rt.bondsOf(secret);
  if (!bonds.length) return { ok: false, why: 'this node has no confirmed bond whose advertisement could be updated' };
  const bond = inForceOf(bonds);   // the output whose advertisement is in force (kanban #1836), not bonds[0]
  // kanban #2182: the seat's own update not mined yet - a change built now would drop the guardians or games it adds
  if (waitFor && inMempool(cli, waitFor)) return { ok: false, why: `this node's own advertisement update ${String(waitFor).slice(0, 16)} is not confirmed yet: change the roles once it is mined` };
  const now = advertInForce(cli, rt, bond, journal ? journal.last('roles') : null);
  const before = { roles: [...(now.roles || [])].sort(), custody: !!now.guardianCapable };
  const after = { roles: want.sort(), custody: custody === undefined ? before.custody : !!custody };
  // CUSTODY OFF NAMES NO GUARDIAN ENDPOINT (advert.js guardianRole: "a node that is not guardian-capable names no guardian_endpoint";
  // measured 2026-10-26, kanban #577: turning the n495 test nodes out of the founding draw was refused before anything was built)
  const advert = () => ({ ...now, roles: after.roles, guardianCapable: after.custody, ...(after.custody ? {} : { guardianEndpoint: '' }), timestamp: BigInt(Date.now()) });
  // THE SAME CHANGE ASKED AGAIN (kanban #1374): a confirmed one reads as "already advertises" above; one sent and not confirmed is answered, not paid twice
  if (post && journal) {
    const was = journal.last('roles');
    if (sameAction(was, { key, what: JSON.stringify(after), nowMs })) { rebroadcast(cli, was.hexes || []); if (txThere(cli, was.txid)) return { ok: true, plan: was.plan, update: { txid: was.txid }, already: true }; }
  }
  // asked before the "already advertises" answer (kanban #2182): the advertisement in force now includes the owner's own change still in the mempool
  if (JSON.stringify(before) === JSON.stringify(after)) return { ok: false, why: 'those are the roles this node already advertises' };
  let plan = null;
  const sent = sendUpdateFromWallet({ cli, rt, secret, bond, advert: advert(), post,
    keep: (hexes, txid, feeSats) => { if (journal) journal.keep('roles', { key, what: JSON.stringify(after), atMs: nowMs, hexes, txid,
      plan: { before, after, bond: `${bond.txid}:${bond.vout}`, feeSats, countsAfter: 6 } }); } });
  if (!sent.ok) return sent;
  plan = { before, after, bond: `${bond.txid}:${bond.vout}`, feeSats: sent.feeSats, countsAfter: 6 };
  return post ? { ok: true, plan, update: { txid: sent.txid } } : { ok: true, plan };
}

/** AN ADVERTISEMENT UPDATE OF `bond`, ITS CARRIER FUNDED FROM THE BOND WALLET: built, checked with testmempoolaccept, and with `post` sent. */
function sendUpdateFromWallet({ cli, rt, secret, bond, advert, post, keep = () => {} }) {
  // the earliest update with a slash_presig counts, and a later one need not repeat it (5A.3B)
  const prepared = rt.prepareAdvertUpdate(secret, { ...advert, slashPresig: undefined });
  const address = JSON.parse(cli('decodescript', toHex(prepared.spk))).address;
  let funded;
  try { funded = JSON.parse(cli('-named', 'walletcreatefundedpsbt', 'inputs=[]', `outputs=${JSON.stringify([{ [address]: Number(UPDATE_CARRIER_SATS) / 1e8 }])}`,
    `options=${JSON.stringify({ include_unsafe: true, fee_rate: 2 })}`)); }
  catch (e) {
    if (!/Insufficient funds/i.test(String(e.stderr || e.message))) throw e;
    return { ok: false, why: `the bond wallet holds ${walletOf(cli).spendableSats} sat that can be spent, and the update needs about ${UPDATE_CARRIER_SATS + 500n} sat: top it up first` };
  }
  const final = JSON.parse(cli('finalizepsbt', JSON.parse(cli('walletprocesspsbt', funded.psbt)).psbt));
  if (!final.complete) return { ok: false, why: 'the bond wallet did not sign the funding transaction' };
  const d = JSON.parse(cli('decoderawtransaction', final.hex));
  const out = d.vout.find((o) => o.scriptPubKey.hex === toHex(prepared.spk));
  const update = rt.postAdvertUpdate(prepared, { txid: bond.txid, vout: bond.vout }, { utxo: { txid: d.txid, vout: out.n, value: UPDATE_CARRIER_SATS }, feeSats: 1200n });
  const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([final.hex, update.hex])));
  if (!accept.every((a) => a.allowed)) return { ok: false, why: `the network would refuse it (${accept.map((a) => a['reject-reason']).filter(Boolean).join(', ')}); nothing was sent` };
  const feeSats = String(BigInt(Math.round(Number(funded.fee) * 1e8)) + 1200n);
  if (!post) return { ok: true, feeSats };
  keep([final.hex, update.hex], update.txid, feeSats);   // kept before it is sent (kanban #1374)
  sentUpdates.set(`${bond.txid}:${bond.vout}`, { txid: update.txid, advert });   // the next update builds on it (kanban #2182)
  cli('sendrawtransaction', final.hex);
  cli('sendrawtransaction', update.hex);
  return { ok: true, feeSats, txid: update.txid };
}

/**
 * THE FEDERATIONS THIS NODE'S GUARDIANS SERVE, IN ITS ADVERTISEMENT (kanban #577, 2026-10-23: a founding's record lists the census nodes whose
 * advertisements name the federation, and a seat set up by hand had to have that update posted by hand - the step that kept e2f42eea's
 * founding from counting as hands-free): an advertisement update of the node's newest bond with guardian_of[] set to `guardianOf`
 * ([{ federationId, guardianKey }] as bytes - every federation one of its guardians runs), funded from the bond wallet as the roles are.
 * Answers { ok: false, same: true } when the advertisement says that already.
 */
/**
 * THE SEAT'S ADVERTISEMENT AFTER ITS OWN CHECK: `now` the advertisement in force; guardian_of as asked; the games hosted = those it names
 * and `hostedGames` (32-byte ids), sorted, none removed. Answers { same } when nothing would change, else { advert, before, after, addedGames }.
 */
export function ownAdvertAfter(now, { guardianOf, hostedGames = null, nowMs = Date.now() }) {
  const key = (gs) => (gs || []).map((g) => `${toHex(g.federationId)}:${toHex(g.guardianKey)}`).sort().join(',');
  const before = key(now.guardianOf), after = key(guardianOf);
  const had = (now.hostedGames || []).map(toHex);
  const games = [...new Set([...had, ...(hostedGames || []).map(toHex)])].sort();
  const addedGames = games.filter((g) => !had.includes(g));
  if (before === after && !addedGames.length) return { same: true };
  return { advert: { ...now, guardianOf: (guardianOf || []).map((g) => ({ federationId: g.federationId, guardianKey: g.guardianKey })),
    hostedGames: games.map((g) => fromHex(g)), timestamp: BigInt(nowMs) }, before, after, addedGames };
}

// AND THE GAMES IT HOSTS (kanban #685, measured 2026-10-27: the seats loaded Up/Down v24 and never announced it, so every v24 round drew only
// the 3 outside nodes that did and none could be seated): `hostedGames` (32-byte ids) are added to what the advertisement names - nothing is
// removed - in the same update as the guardians, so a new game version counts once that update does
// `keep`: the guardians the advertisement names stay, those in `guardianOf` added or their keys made current (a seat's own check, kanban #741:
// one read of the chain answers both the advertisement in force and the update, where the check read it twice); `scan` as regtest takes it
export async function guardianOfFromWallet({ cli, wallet, network = 'testnet4', secret, guardianOf, hostedGames = null, post = false, keep = false, scan = null, ownerRoles = null }) {
  const { regtest } = await import('../tools/regtest-bond.mjs');
  const rt = regtest(cli, { network, wallet: wallet || 'arena', scan });
  const bonds = rt.bondsOf(secret);
  if (!bonds.length) return { ok: false, noBond: true, why: 'this node has no confirmed bond whose advertisement could be updated' };
  const bond = inForceOf(bonds);   // the output whose advertisement is in force (kanban #1836), not bonds[0]
  const now = advertInForce(cli, rt, bond, ownerRoles);   // the owner's roles change still in the mempool is kept (kanban #2182)
  if (keep) {
    const want = new Map(((now && now.guardianOf) || []).map((g) => [toHex(g.federationId), g]));
    for (const e of guardianOf || []) want.set(toHex(e.federationId), e);
    guardianOf = [...want.values()];
  }
  const next = ownAdvertAfter(now, { guardianOf, hostedGames });
  if (next.same) return { ok: false, same: true, why: 'the advertisement names these guardians and games already' };
  const { advert, before, after, addedGames } = next;
  const sent = sendUpdateFromWallet({ cli, rt, secret, bond, advert, post });
  if (!sent.ok) return sent;
  const plan = { before, after, addedGames, bond: `${bond.txid}:${bond.vout}`, feeSats: sent.feeSats, countsAfter: 6 };
  return post ? { ok: true, plan, update: { txid: sent.txid } } : { ok: true, plan };
}
