#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * POST ONE ROUND SERIES ON TESTNET4 (2026-09-28 11:44, POST72-1800: "When the node can write a 72 h series, post
 * one immediately ... Posted means the series publication transaction is broadcast (OP_RETURN ARN SERIES)").
 *
 * The series is the live paying round's committee, carried forward: its contract - network, core, federation, stake,
 * signer nodes, census - read from a signer node, and the series' own times set by the spec's clock (§5A.5, HORIZON72):
 *
 *   series_start   = MTP(census_height) + census lead + 1 s   (testnet4 36 h, mainnet 72 h) - so that census_height IS "the highest block whose MTP <=
 *                    series_start - census lead", the census the round already names (the reused bonds, 5A.2)
 *   committee_time = series_start - committee lead   (testnet4 24 h, mainnet 72 h)
 *
 * The publication spends ONE wallet output chosen here, never a bond: a 50000-sat bond or a 1670-sat marker is never an
 * input, and nothing else is added (`add_inputs: false`). It is broadcast and its txid written beside the series.
 *
 *   ARENA_BITCOIN_CLI=<bitcoin-cli> ARENA_TN4_DATADIR=<datadir> ARENA_TN4_WALLET=<wallet> \
 *     node tools/testnet4-series.mjs <signer node url> <round id hex> <out dir> [--send]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import {
  seriesTemplate, seriesIndexAt, seriesLeadIsValid, seriesId, seriesPublicationPayload, seriesRound, ROUNDS_PER_SERIES,
  seriesClockFor,
} from '../../arena-protocol/src/series.js';

const [nodeUrl, roundHex, outDir, send] = process.argv.slice(2);
if (!nodeUrl || !roundHex || !outDir) { console.error('usage: testnet4-series.mjs <node url> <round id> <out dir> [--send]'); process.exit(2); }
const env = process.env;
const cli = (...a) => execFileSync(env.ARENA_BITCOIN_CLI || '/mnt/bitcoin/bitcoin-31.1/bin/bitcoin-cli',
  [`-datadir=${env.ARENA_TN4_DATADIR || '/mnt/bitcoin/tn4'}`, ...a], { encoding: 'utf8' }).trim();
const wallet = (...a) => cli(`-rpcwallet=${env.ARENA_TN4_WALLET || 'blwp-tn4-bonds'}`, ...a);
const say = (o) => console.log(JSON.stringify(o));

// 1. THE COMMITTEE'S CONTRACT, from a signer node that holds it, checked against its id
const bytes = new Uint8Array(await (await fetch(`${nodeUrl}/round?id=${roundHex}`)).arrayBuffer());
const live = decodeRoundContract(bytes);
if (toHex(roundId(live)) !== roundHex) throw new Error(`the node answered a contract whose id is not ${roundHex}`);

// 2. THE SERIES' START, from the census the round names
const mtpOf = (h) => BigInt(JSON.parse(cli('getblockheader', cli('getblockhash', String(h)))).mediantime) * 1000n;
const H = live.censusHeight;
const { censusLeadMs: SERIES_CENSUS_LEAD_MS } = seriesClockFor(live.networkId);   // testnet4: 36 h (TN24-1405 + 36 h census)
// SERIES k STARTS AT genesis_series_start + k * 24 h (ALL-BUT-MIN-1727): the first series whose census cut is at or after
// block H's median, and H must be the highest block at or below that cut - otherwise the census names another height
const k = seriesIndexAt(live.networkId, mtpOf(H) + SERIES_CENSUS_LEAD_MS);
const template = seriesTemplate(live, k);
const cut = template.startTimeMs - SERIES_CENSUS_LEAD_MS;
if (!(mtpOf(H) <= cut && mtpOf(H + 1) > cut))
  throw new Error(`series ${k} cuts its census at ${cut}; block ${H} is not the highest block at or below it, so that round's census names another series`);
const lead = seriesLeadIsValid(template);
if (!lead.ok) throw new Error(lead.why);
const tip = JSON.parse(cli('getblockchaininfo'));
const tipMtp = BigInt(tip.mediantime) * 1000n;
if (template.committeeTimeMs <= tipMtp + 3600000n)
  throw new Error(`committee_time ${template.committeeTimeMs} is not an hour past the tip's median ${tipMtp}: the publication could miss its beacon`);
const id = seriesId(template);
const payload = seriesPublicationPayload(id);
const last = seriesRound(template, ROUNDS_PER_SERIES - 1);
say({ step: 'series', id: toHex(id), census: H, seriesStart: new Date(Number(template.startTimeMs)).toISOString(),
  committeeTime: new Date(Number(template.committeeTimeMs)).toISOString(), lastRound: new Date(Number(last.startTimeMs)).toISOString(),
  leadHours: Number(lead.leadMs) / 3600000, tip: tip.blocks, tipMtp: new Date(Number(tipMtp)).toISOString(), payload: toHex(payload) });

// 3. ONE WALLET OUTPUT, NEVER A BOND: confirmed, spendable, not 50000 sat (a bond) nor 1670 sat (a marker)
const utxos = JSON.parse(wallet('listunspent', '1')).filter((u) => u.spendable && u.solvable
  && ![50000, 1670].includes(Math.round(u.amount * 1e8)) && u.amount * 1e8 >= 5000).sort((a, b) => a.amount - b.amount);
if (!utxos.length) throw new Error('no confirmed non-bond output of at least 5000 sat in the wallet');
const input = utxos[0];
const raw = wallet('createrawtransaction', JSON.stringify([{ txid: input.txid, vout: input.vout }]), JSON.stringify([{ data: toHex(payload) }]));
const funded = JSON.parse(wallet('fundrawtransaction', raw, JSON.stringify({ add_inputs: false, fee_rate: 2, changePosition: 1 })));
const signed = JSON.parse(wallet('signrawtransactionwithwallet', funded.hex));
if (!signed.complete) throw new Error('the wallet could not sign the publication');
const decoded = JSON.parse(cli('decoderawtransaction', signed.hex));
if (decoded.vin.length !== 1 || decoded.vin[0].txid !== input.txid || decoded.vin[0].vout !== input.vout)
  throw new Error('the publication spends something other than the one output chosen');
const accept = JSON.parse(cli('testmempoolaccept', JSON.stringify([signed.hex])))[0];
say({ step: 'publication', input: `${input.txid}:${input.vout}`, inputSats: Math.round(input.amount * 1e8), feeSats: Math.round(funded.fee * 1e8),
  txid: decoded.txid, vsize: decoded.vsize, mempoolAccept: accept.allowed, reject: accept['reject-reason'] || null });
const record = { series: toHex(id), template: toHex(encodeRoundContract(template)), seriesStartMs: String(template.startTimeMs),
  committeeTimeMs: String(template.committeeTimeMs), censusHeight: H, fromRound: roundHex, payload: toHex(payload),
  txid: decoded.txid, hex: signed.hex, broadcast: false };
if (send === '--send') {
  if (!accept.allowed) throw new Error(`the mempool refuses the publication: ${accept['reject-reason']}`);
  record.txid = cli('sendrawtransaction', signed.hex);
  record.broadcast = true;
  record.broadcastAt = new Date().toISOString();
  say({ step: 'broadcast', txid: record.txid });
}
writeFileSync(join(outDir, `series-${toHex(id).slice(0, 16)}.json`), JSON.stringify(record, null, 2) + '\n');
say({ step: 'written', file: join(outDir, `series-${toHex(id).slice(0, 16)}.json`) });
