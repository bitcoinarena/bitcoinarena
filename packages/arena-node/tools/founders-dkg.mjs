#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FOUNDERS' DKG OF CENSUS KEY 0 (spec 5A.3B, kanban #1021, #1050): each founder on its own machine, before any bond exists and before genesis. There is no chain to run it on and no door
// to reach, so it goes by files in one folder the founders share any way they like: nothing in it is secret, a deal's shares are sealed to their holders. It is the census DKG a seat runs
// (dkg.js CensusDkg), one share each, threshold floor(2n / 3) + 1.
//
//   node tools/founders-dkg.mjs plan   --founders <file of node keys, one per line, in share order> --network mainnet|regtest --dir <shared folder>
//   node tools/founders-dkg.mjs deal   --store <this node's store.db> --dir <shared folder>        each founder: deal-<key>.bin
//   node tools/founders-dkg.mjs sign   --store <this node's store.db> --dir <shared folder>        each, with the deals in: statement-<key>.json, or complaint-<key>-<dealer>.bin
//   node tools/founders-dkg.mjs finish --store <this node's store.db> --dir <shared folder>        each, with the statements in: keeps its shares in its store, prints census_key_0
//
// A founder that did not deal holds its share all the same as long as those that did reach the threshold; a founder that sees a bad deal publishes a complaint anyone can check, and
// `sign` drops the deals that complaints in the folder prove. Every founder must sign one record, so run `sign` only when the folder holds every deal that will be used.
// `finish` prints the census_key_0 for genesis_parameters, and all founders must print the same bytes.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore, nodeIdentity } from '../src/store.js';
import { CensusDkg } from '../src/dkg.js';
import { feldmanGroup } from '../src/curve.js';
import { CensusKeyStore } from '../src/census-key-store.js';
import { censusKey0Shares } from '../../arena-protocol/src/census-key.js';
import { censusDealId, censusComplaintHolds, decodeCensusComplaint, decodeCensusDeal, encodeCensusComplaint, founderRun, joinSignedCensusDeal, splitSignedCensusDeal } from '../../arena-protocol/src/census-dkg.js';
import { CENSUS_KEY_SHARES_MAX, censusKey0Stands, genesisFor } from '../../arena-protocol/src/genesis.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const random = (n) => new Uint8Array(randomBytes(n));
const planPath = (dir) => join(dir, 'plan.json');
const readPlan = (dir) => JSON.parse(readFileSync(planPath(dir), 'utf8'));
const runOf = (plan) => founderRun(censusKey0Shares({ holders: plan.holders.map(fromHex), threshold: plan.threshold }));
/** The founders' floor: the census minimum of the network, which genesis checks again. */
const minimumOf = (network) => (network === 'mainnet' ? 10 : genesisFor(network).censusMinNodes);
const inFolder = (dir, re) => readdirSync(dir).filter((f) => re.test(f)).sort();

function identityOf(storePath) {
  const db = openStore(storePath), id = nodeIdentity(db);
  return { db, secret: id.secret, key: schnorr.getPublicKey(id.secret) };
}

function dkgOf(dir, id) {
  const plan = readPlan(dir), run = runOf(plan);
  if (!run.holders.some((h) => h.key === toHex(id.key))) throw new Error(`this store's node ${toHex(id.key).slice(0, 16)} is not one of the founders of that plan`);
  return { plan, run, dkg: new CensusDkg({ key: id.key, secret: id.secret, run, curve: feldmanGroup, random }) };
}

/** Takes the deals of the folder, each checked as a seat checks a signed deal, and what the complaints there prove. Answers the dealers it took. */
async function takeDeals(dkg, run, dir) {
  const took = [], refused = [];
  for (const f of inFolder(dir, /^deal-[0-9a-f]{64}\.bin$/)) {
    const wire = new Uint8Array(readFileSync(join(dir, f)));
    let parts, deal;
    try { parts = splitSignedCensusDeal(wire); deal = decodeCensusDeal(parts.bytes); } catch (e) { refused.push(`${f}: ${e.message}`); continue; }
    let good = false; try { good = toHex(deal.runId) === toHex(run.runId) && schnorr.verify(parts.signature, censusDealId(deal), deal.from); } catch { good = false; }
    if (!good) { refused.push(`${f}: not signed by its dealer for this run`); continue; }
    const r = await dkg.accept(new Uint8Array(parts.bytes));
    if (r.ok) took.push(toHex(deal.from)); else refused.push(`${f}: ${r.why}`);
  }
  for (const f of inFolder(dir, /^complaint-.*\.bin$/)) {
    const c = decodeCensusComplaint(new Uint8Array(readFileSync(join(dir, f))));
    const proven = await dkg.hearComplaint(c);
    if (proven.ok) refused.push(`${f}: proves dealer ${toHex(c.dealer).slice(0, 16)} dealt badly`);
  }
  return { took, refused };
}

/** The founders in share order, written once, for every founder to compare. */
export function plan({ founders, network = 'mainnet', dir }) {
  const holders = founders.map((k) => { const key = fromHex(String(k).trim()); if (key.length !== 32) throw new Error(`${k} is no 32-byte node key`); return key; });
  const threshold = Math.floor((2 * holders.length) / 3) + 1;
  const stands = censusKey0Stands({ publicKey: new Uint8Array(32), holders, threshold }, { minHolders: minimumOf(network), sharesMax: CENSUS_KEY_SHARES_MAX });
  if (!stands.ok) throw new Error(stands.why);
  const body = { network, holders: holders.map(toHex), threshold };
  mkdirSync(dir, { recursive: true });
  writeFileSync(planPath(dir), `${JSON.stringify(body, null, 1)}\n`);
  return { ...body, run: toHex(runOf(body).runId) };
}

/** This founder's signed deal, once: a second would make two keys of one run. */
export async function deal({ store, dir }) {
  const id = identityOf(store);
  try {
    const { dkg } = dkgOf(dir, id);
    const path = join(dir, `deal-${toHex(id.key)}.bin`);
    if (inFolder(dir, /^deal-/).some((f) => f === `deal-${toHex(id.key)}.bin`)) return { path, again: true };
    const made = await dkg.deal();
    if (!made.ok) throw new Error(made.why);
    writeFileSync(path, joinSignedCensusDeal(made.bytes, schnorr.sign(censusDealId(decodeCensusDeal(made.bytes)), id.secret)));
    return { path, again: false };
  } finally { id.db.close(); }
}

/** The check of every deal in the folder. Good: this founder's statement. Bad: its complaints, and no statement until the others have heard them. */
export async function sign({ store, dir }) {
  const id = identityOf(store);
  try {
    const { plan: p, run, dkg } = dkgOf(dir, id);
    const { refused } = await takeDeals(dkg, run, dir);
    if (dkg.deals.size < p.threshold) throw new Error(`${dkg.deals.size} good deals in that folder, and the key needs ${p.threshold}${refused.length ? `: ${refused.join('; ')}` : ''}`);
    const checked = dkg.check();
    if (checked.complaints.length) {
      for (const c of checked.complaints) writeFileSync(join(dir, `complaint-${toHex(id.key)}-${toHex(c.dealer)}.bin`), encodeCensusComplaint(c));
      return { ok: false, complaints: checked.complaints.map((c) => toHex(c.dealer)), refused };
    }
    const said = dkg.statement();
    writeFileSync(join(dir, `statement-${toHex(id.key)}.json`), `${JSON.stringify({ node: toHex(said.node), recordId: toHex(said.recordId), signature: toHex(said.signature) })}\n`);
    return { ok: true, dealers: dkg.deals.size, recordId: toHex(said.recordId), refused };
  } finally { id.db.close(); }
}

/** With statements of the threshold on one record: this founder's shares in its store, as a seat keeps them, and census_key_0. */
export async function finish({ store, dir }) {
  const id = identityOf(store);
  try {
    const { plan: p, run, dkg } = dkgOf(dir, id);
    await takeDeals(dkg, run, dir);
    dkg.check();
    const statements = inFolder(dir, /^statement-[0-9a-f]{64}\.json$/).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      .map((s) => ({ node: fromHex(s.node), recordId: fromHex(s.recordId), signature: fromHex(s.signature) }));
    const made = dkg.finish(statements);
    if (!made.ok) throw new Error(`no key yet: ${made.why}`);
    const publicKey = made.groupPublicKey.subarray(1);
    const stands = censusKey0Stands({ publicKey, holders: p.holders.map(fromHex), threshold: p.threshold }, { minHolders: minimumOf(p.network), sharesMax: CENSUS_KEY_SHARES_MAX });
    if (!stands.ok) throw new Error(stands.why);
    new CensusKeyStore(id.db).keepHeld({ publicKey, epoch: 0, runId: run.runId, record: new Uint8Array(0), negated: made.negated, shares: made.shares, commitments: made.commitments });
    return { publicKey: toHex(publicKey), holders: p.holders, threshold: p.threshold, signers: made.have };
  } finally { id.db.close(); }
}

const STEPS = { plan, deal, sign, finish };
if (process.argv[1] && process.argv[1].endsWith('founders-dkg.mjs')) {
  const [step, ...rest] = process.argv.slice(2);
  const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (!STEPS[step] || !opt('dir')) { console.error('founders-dkg plan|deal|sign|finish --dir <shared folder> (plan: --founders <file> --network <name>; the others: --store <store.db>)'); process.exit(2); }
  const args = step === 'plan' ? { founders: readFileSync(opt('founders'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean), network: opt('network') || 'mainnet', dir: opt('dir') } : { store: opt('store'), dir: opt('dir') };
  Promise.resolve().then(() => STEPS[step](args)).then((out) => { console.log(JSON.stringify(out, null, 1)); process.exit(out.ok === false ? 1 : 0); }, (e) => { console.error(`founders-dkg ${step}: ${e.message}`); process.exit(1); });
}
