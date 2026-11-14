#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * DEAD NOTES IN A GATEWAY'S WALLET (kanban #2773, after #2771): the notes a gateway holds as spendable that the federation already counts
 * as spent. gw-c held 62 of them for two weeks (its database rolled back 13 h by a copy); each payment funded with one was rejected, and
 * the stock refund stranded the rest. The gateway API lists no notes, so this reads a COPY of the gateway's database - never the live
 * one, nothing is written to the gateway - and the guardians' spent set:
 *
 *   node tools/gateway-dead-notes.mjs --data-dir <gateway data dir> --federation <id hex> --client-dir <a fedimint-cli client of that
 *        federation> --work <dir> --out <file.json> [--fedimint-cli <path>] [--dbtool <path>] [--module <mintv2 instance, 2>]
 *
 *   1. rsync -a --inplace <data-dir>/gatewayd.db/ into <work>/copy/ - the WHOLE database, its write-ahead logs (*.log) included (#2771:
 *      a copy without them is a rollback); RocksDB itself drops the files of an older copy that no longer belong
 *   2. fedimint-dbtool list of the copy; the mintv2 spendable notes in it (gateway-loss.js notesInDump)
 *   3. the guardians' spent set: mintv2 recovery items, read once and then only the new ones (<work>/spent-<fed>.txt, its count beside it)
 *   4. { atMs, federation, notes, dead, deadMsat } to --out - the file a node's ARENA_HOSTS_GATEWAY and the health watcher's HW_GATEWAYS
 *      name as the gateway's dead-notes file
 * Run it from a timer, a few times a day: a pass reads the whole database once.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { notesInDump, deadNotes } from '../src/gateway-loss.js';

/** A note's nonce hash as the mintv2 server keys its spent set: hash160 of the compressed public key of its spend key. */
export const nonceOf = (sk) => createHash('ripemd160').update(createHash('sha256').update(secp256k1.getPublicKey(Buffer.from(sk, 'hex'), true)).digest()).digest('hex');

const arg = (argv, k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };

/** The spent set, brought up to the guardians' count: `api(method, params)` answers fedimint-cli's `dev api --module mintv2` value. */
export function spentSet({ work, fed, api, slice = 25000 }) {
  const file = `${work}/spent-${fed.slice(0, 16)}.txt`, countFile = `${file}.count`;
  let from = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) || 0 : 0;
  const to = Number(api('recovery_count', null));
  if (!(to >= 0)) throw new Error('the guardians gave no recovery count');
  if (from > to) from = 0;
  if (from === 0) writeFileSync(file, '');
  while (from < to) {
    const end = Math.min(to, from + slice);
    const items = api('recovery_slice', `[${from},${end}]`);
    appendFileSync(file, items.filter((x) => x && x.Input).map((x) => `${x.Input.nonce_hash}\n`).join(''));
    from = end; writeFileSync(countFile + '.tmp', String(from)); renameSync(countFile + '.tmp', countFile);
  }
  return new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean));
}

export function main(argv = process.argv.slice(2)) {
  const dataDir = arg(argv, '--data-dir'), fed = String(arg(argv, '--federation', '')).toLowerCase(), work = arg(argv, '--work'), out = arg(argv, '--out');
  const clientDir = arg(argv, '--client-dir'), cli = arg(argv, '--fedimint-cli', 'fedimint-cli'), dbtool = arg(argv, '--dbtool', 'fedimint-dbtool');
  const module = Number(arg(argv, '--module', '2'));
  if (!dataDir || !/^[0-9a-f]{64}$/.test(fed) || !work || !out || !clientDir) { console.error('usage: gateway-dead-notes.mjs --data-dir D --federation ID --client-dir C --work W --out F.json'); process.exit(2); }
  mkdirSync(`${work}/copy`, { recursive: true });
  execFileSync('rsync', ['-a', '--inplace', `${dataDir.replace(/\/+$/, '')}/gatewayd.db/`, `${work}/copy/`], { stdio: 'inherit' });
  const dump = execFileSync(dbtool, ['--database-dir', `${work}/copy`, 'list', '--prefix', ''], { maxBuffer: 1 << 30, encoding: 'utf8' }).split('\n');
  const notes = notesInDump(dump, fed, module);
  const api = (method, params) => JSON.parse(execFileSync(cli, ['--data-dir', clientDir, 'dev', 'api', '--module', 'mintv2', '--peer-id', '0', method, ...(params ? [params] : [])],
    { maxBuffer: 1 << 30, encoding: 'utf8', timeout: 120000 })).value;
  const spent = spentSet({ work, fed, api });
  const r = { atMs: Date.now(), federation: fed, ...deadNotes(notes, spent, nonceOf) };
  writeFileSync(out + '.tmp', JSON.stringify(r)); renameSync(out + '.tmp', out);
  console.log(JSON.stringify(r));
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
