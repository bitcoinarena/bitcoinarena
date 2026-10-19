#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * A TESTNET4 TAIL SERIES WITH LATE JOIN (2026-10-03: "Create a new round series, 90 seconds ... back to back 90
 * seconds. Joining an existing round is possible with 45 seconds in." and "the round series should be at least 72 hours").
 * The live paid round's contract - network, cores, federation, stake, donation set, signer nodes, census - carried forward
 * into a tail: rounds every 90 s from TAIL_START to its day's end, committee_time 12 h before the start (a tail's lead),
 * entry closing LATE_JOIN_MS (45 s) after each round's start. The publication spends ONE wallet output, never a bond.
 *
 *   node tools/testnet4-late-tail.mjs <signer node url> <tail start ISO> <out dir> [--send]
 * Prints the series line for the nodes' series file: `<template hex> count=N`.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import {
  seriesLeadIsValid, seriesId, seriesPublicationPayload, seriesRound, genesisSeriesStart, ROUNDS_PER_SERIES, ROUND_PERIOD_MS,
  SERIES_MAX_MS, LATE_JOIN_MS, TAIL_COMMITTEE_LEAD_MIN_MS,
} from '../../arena-protocol/src/series.js';

const [nodeUrl, startIso, outDir, send] = process.argv.slice(2);
if (!nodeUrl || !startIso || !outDir) { console.error('usage: testnet4-late-tail.mjs <node url> <tail start ISO> <out dir> [--send]'); process.exit(2); }
const env = process.env;
const cli = (...a) => execFileSync(env.ARENA_BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4'}`, ...a], { encoding: 'utf8' }).trim();
const wallet = (...a) => cli(`-rpcwallet=${env.ARENA_TN4_WALLET || 'blwp-tn4-bonds'}`, ...a);
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));

// 1. THE LIVE PAID ROUND'S CONTRACT, from a signer node
const listed = await (await fetch(`${nodeUrl}/rounds?next=4`)).json();
const paid = (listed.rounds || listed).find((r) => !r.free);
if (!paid) throw new Error('the node lists no paid round to carry forward');
const bytes = new Uint8Array(await (await fetch(`${nodeUrl}/round?id=${paid.id}`)).arrayBuffer());
const live = decodeRoundContract(bytes);
if (toHex(roundId(live)) !== paid.id) throw new Error(`the node answered a contract whose id is not ${paid.id}`);
const base = { ...live }; delete base.seriesId; delete base.roundIndex; delete base.seriesCount; delete base.seriesCutFrom;

// 2. THE TAIL: on the 90 s grid inside its day, to the day's end
const start = BigInt(Date.parse(startIso));
const g = genesisSeriesStart(live.networkId);
const into = start - g;
if (into < 0n || into % ROUND_PERIOD_MS !== 0n) throw new Error(`${startIso} is not on the 90 s grid from genesis_series_start`);
const index = Number((into % SERIES_MAX_MS) / ROUND_PERIOD_MS);
if (index === 0) throw new Error('a tail starts inside its day, not at its first round');
const count = ROUNDS_PER_SERIES - index;
const template = { ...base, startTimeMs: start, committeeTimeMs: start - TAIL_COMMITTEE_LEAD_MIN_MS, entryCloseMs: start + LATE_JOIN_MS, seriesCount: count };
const lead = seriesLeadIsValid(template);
if (!lead.ok) throw new Error(lead.why);
const tipMtp = BigInt(JSON.parse(cli('getblockchaininfo')).mediantime) * 1000n;
if (template.committeeTimeMs <= tipMtp + 3600000n)
  throw new Error(`committee_time ${new Date(Number(template.committeeTimeMs)).toISOString()} is not an hour past the tip's median ${new Date(Number(tipMtp)).toISOString()}`);
const id = seriesId(template);
const payload = seriesPublicationPayload(id);
const hex = toHex(encodeRoundContract(template));
const first = seriesRound(template, 0); const last = seriesRound(template, count - 1);
say({ step: 'series', id: toHex(id), count, index, start: new Date(Number(first.startTimeMs)).toISOString(),
  firstEntryClose: new Date(Number(first.entryCloseMs)).toISOString(), last: new Date(Number(last.startTimeMs)).toISOString(),
  committeeTime: new Date(Number(template.committeeTimeMs)).toISOString(), census: live.censusHeight, stakeMsat: template.stakeMsat,
  blockTicks: template.blockTicks, from: paid.id.slice(0, 16), line: `${hex.slice(0, 24)}... count=${count}` });

// 3. ONE WALLET OUTPUT, NEVER A BOND (50000 sat) NOR A MARKER (1670 sat)
const utxos = JSON.parse(wallet('listunspent', '1')).filter((u) => u.spendable && u.solvable
  && ![50000, 1670].includes(Math.round(u.amount * 1e8)) && u.amount * 1e8 >= 5000).sort((a, b) => a.amount - b.amount);
if (!utxos.length) throw new Error('no non-bond output of 5000 sat or more');
const input = utxos[0];
const raw = wallet('createrawtransaction', JSON.stringify([{ txid: input.txid, vout: input.vout }]), JSON.stringify([{ data: toHex(payload) }]));
const funded = JSON.parse(wallet('fundrawtransaction', raw, JSON.stringify({ add_inputs: false, fee_rate: Number(env.FEE_RATE || 5), changePosition: 1 })));
const signed = JSON.parse(wallet('signrawtransactionwithwallet', funded.hex));
const decoded = JSON.parse(cli('decoderawtransaction', signed.hex));
if (decoded.vin.length !== 1 || decoded.vin[0].txid !== input.txid) throw new Error('the publication spends something other than the chosen output');
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([signed.hex])))[0];
say({ step: 'publication', input: `${input.txid}:${input.vout}`, inputSats: Math.round(input.amount * 1e8), feeSats: Math.round(funded.fee * 1e8),
  txid: decoded.txid, accept: accept.allowed, reject: accept['reject-reason'] || null });
const rec = { series: toHex(id), template: hex, count, line: `${hex} count=${count}`, committeeTimeMs: String(template.committeeTimeMs),
  startMs: String(start), lateJoinMs: String(LATE_JOIN_MS), fromRound: paid.id, payload: toHex(payload), txid: decoded.txid, hex: signed.hex };
const file = join(outDir, `late-tail-${toHex(id).slice(0, 16)}.json`);
if (send !== '--send') { writeFileSync(file.replace('.json', '-dry.json'), JSON.stringify(rec, null, 1)); say({ step: 'dry run - nothing broadcast', file: file.replace('.json', '-dry.json') }); process.exit(0); }
if (!accept.allowed) throw new Error('the mempool refuses the publication: ' + accept['reject-reason']);
const sent = cli('sendrawtransaction', signed.hex);
writeFileSync(file, JSON.stringify({ ...rec, broadcast: true, broadcastAt: new Date().toISOString() }, null, 1));
say({ step: 'BROADCAST', txid: sent, file });
