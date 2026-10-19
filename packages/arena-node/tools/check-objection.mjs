// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CHECK AN OBJECTION BUNDLE AS A STRANGER (§13A, kanban #24: "Anyone can check this; there is no judgement involved, only
// replay"). Everything is read off a signer node's public doors - the round's contract (GET /round), the entry (GET
// /entry), the signed results (GET /results), the beacon (GET /randomness) - and the replay runs HERE, under the core the
// round names from this checkout's own cores. Nothing the seat says about the objection is asked; the seat only hands over
// the round's public record, and a stranger who trusts no seat can read the same record from any of them.
//
//   node tools/check-objection.mjs <seat url> <round hex> <entry hex> <bundle file>
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodeRoundContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { cutSignedResults } from '../../arena-protocol/src/result.js';
import { coreOfGame, hostedPlugins } from '../src/plugins.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { verifiedFinal } from '../src/verdict.js';
import { checkObjectionBundle } from '../src/objection-check.js';

const bytesOf = (h) => (h instanceof Uint8Array ? h : new Uint8Array(Buffer.from(String(h), 'hex')));
const hex = (b) => Buffer.from(b).toString('hex');
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };

/** Check `bundle` against the round `roundId`'s entry `entryId` as the public record at `base` has it. */
export async function checkObjectionAt({ base, roundId, entryId, bundle, fetcher = fetch }) {
  const rid = bytesOf(roundId), eid = bytesOf(entryId);
  const get = async (path) => {
    const r = await fetcher(`${base}${path}`);
    if (r.status !== 200) throw new Error(`GET ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return { r, bytes: new Uint8Array(await r.arrayBuffer()) };
  };
  const contract = decodeRoundContract((await get(`/round?id=${hex(rid)}`)).bytes);
  const entry = decodeEntryContract((await get(`/entry?id=${hex(eid)}`)).bytes);
  const resultsBytes = (await get(`/results?round=${hex(rid)}&entry=${hex(eid)}`)).bytes;
  const records = [];
  for (const rec of cutSignedResults(resultsBytes)) records.push(rec.slice());
  // THE COMMITTEE THE ROUND NAMES, and the run it signed at its threshold - counted here, each signature verified
  const committee = contract.nodes;
  const seen = verifiedFinal(records, { contract, signerNodes: committee });
  const signedResultId = seen.ok && seen.final ? bytesOf(seen.runId) : null;
  const beacon = await get(`/randomness?round=${hex(rid)}`);
  const roundRandomness = beacon.bytes.length === 32 ? beacon.bytes : bytesOf(JSON.parse(Buffer.from(beacon.bytes).toString()).hash);
  // THE ROUND'S GAME, as a node hosts it (kanban #203): its core and config, and the configs it plays as one world per round
  const game = hostedPlugins([NEXTBLOCK]).get(hex(contract.gameId));
  if (!game) return { holds: false, step: 'replay', why: `this tool replays nextblock only, and that round plays game ${hex(contract.gameId).slice(0, 16)}` };
  const found = coreOfGame(contract, game);
  if (!found.ok) return { holds: false, step: 'replay', why: found.why };
  const core = { ...found.core, config: found.config, runTicks: found.runTicks,
    world: { configHash: contract.configHash, censusRoot: contract.censusRoot, roundId: rid, sharedWorld: [...game.sharedWorld] } };
  const checked = await checkObjectionBundle({ bundle: bytesOf(bundle), roundId: rid, entryId: eid, entry, contract, committee,
    signedResultId, core, roundRandomness, verify });
  return { ...checked, signedBy: seen.ok ? seen.signers ?? null : null, results: records.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [base, round, entry, file] = process.argv.slice(2);
  if (!file) { console.error('usage: check-objection.mjs <seat url> <round hex> <entry hex> <bundle file>'); process.exit(2); }
  const got = await checkObjectionAt({ base, roundId: round, entryId: entry, bundle: new Uint8Array(readFileSync(file)) });
  console.log(JSON.stringify(got));
  process.exit(got.holds ? 0 : 1);
}
