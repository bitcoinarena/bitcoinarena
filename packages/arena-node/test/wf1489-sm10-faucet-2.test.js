// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm10-faucet-2 (state-machine audit, the e-cash pool, SM-19, two runs at once): tools/faucet-ecash.mjs reads the whole wallet
// (ECASH_DIR/wallet.json) into memory when it starts - BEFORE the federation join, which takes seconds - and writes its whole copy back at its end
// (flush), with no lock. The tool is one wallet run by several commands: the `keep` service mints notes into the pool, the operator asks `balance`.
// A `balance` (or a second `mint`) that started before a mint finished writes its old copy over the minted state: the wallet again holds the notes
// that are already in the pool, and the next mint hands the same notes out a second time. The federation redeems a note once: one of the two
// welcomes is "Rejected (already spent)" in the player's wallet while the faucet's book says it was given.
// Invariant: no note of the wallet is in two pool notes (a note the wallet spent is never in the wallet again).
// The real tools/faucet-ecash.mjs against a stand-in lock client (WASM_PKG): its notes live in the tool's own wallet store; its join takes FAKE_JOIN_MS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet-ecash.mjs');
const FED = '66'.repeat(32), NOTE_MSAT = 3000000;
const FAKE_CLIENT = `
export default async function init() {}
const NOTE = ${NOTE_MSAT};
export class LockClient {
  static federationIdOf() { return '${FED}'; }
  // the federation join (seconds live: the client asks the guardians); the wallet's store was read before it
  static async join(invite, fed, seed, store) { await new Promise((ok) => setTimeout(ok, Number(process.env.FAKE_JOIN_MS || 0))); return new LockClient(store); }
  constructor(store) { this.store = store; this.notes = JSON.parse(new Map(JSON.parse(store.entries())).get('notes') || '[]'); }
  async balanceMsat() { return String(this.notes.length * NOTE); }
  // the stock send: the wallet's own notes out of the wallet, as one string (no guardian is asked)
  async sendEcash(msat) { const n = Number(msat) / NOTE; if (n > this.notes.length) throw new Error('short');
    const out = this.notes.slice(0, n); this.notes = this.notes.slice(n); this.store.put('notes', JSON.stringify(this.notes));
    return JSON.stringify({ msat: String(msat), ecash: 'fakeecash:' + out.join(',') }); }
}
`;
const filesUnder = (d) => { const out = []; let names = []; try { names = readdirSync(d); } catch { return out; }
  for (const n of names) { const p = join(d, n); if (statSync(p).isDirectory()) out.push(...filesUnder(p)); else out.push(p); } return out; };

test('#1489 sm10-faucet-2: a balance asked while a mint runs does not give the minted notes back to the wallet', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm10-faucet-2-'));
  const pkg = join(dir, 'pkg'); mkdirSync(pkg);
  writeFileSync(join(pkg, 'blwp_lock_client.js'), FAKE_CLIENT); writeFileSync(join(pkg, 'blwp_lock_client_bg.wasm'), Buffer.from([0, 97, 115, 109]));
  writeFileSync(join(dir, 'invite'), 'fed1fakeinvite');
  const wallet = join(dir, 'wallet'); mkdirSync(wallet);
  // the faucet's e-cash wallet: four notes of 3,000 sat
  writeFileSync(join(wallet, 'wallet.json'), JSON.stringify([['notes', JSON.stringify(['note-a', 'note-b', 'note-c', 'note-d'])]]));
  const pool = join(dir, 'pool');
  const run = (args, joinMs) => new Promise((ok) => { let out = '';
    const c = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, ECASH_DIR: wallet, INVITE_FILE: join(dir, 'invite'), WASM_PKG: pkg, POOL: pool, FAKE_JOIN_MS: String(joinMs) }, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { out += x; }); c.on('exit', (code) => ok({ code, out })); });
  // the keep service's mint and the operator's balance, at once (the balance's join is the slower one)
  const [mint1, balance] = await Promise.all([run(['mint', '1', String(NOTE_MSAT)], 1000), run(['balance'], 2500)]);
  // the next mint (the keep loop's next pass, or its restart)
  const mint2 = await run(['mint', '1', String(NOTE_MSAT)], 0);
  const pooled = filesUnder(pool).map((f) => JSON.parse(readFileSync(f, 'utf8')).ecash);
  const uses = new Map();
  for (const e of pooled) for (const n of String(e).replace(/^fakeecash:/, '').split(',')) uses.set(n, (uses.get(n) || 0) + 1);
  const twice = [...uses].filter(([, k]) => k > 1).map(([n]) => n);
  const facts = { exits: [mint1.code, balance.code, mint2.code], poolNotes: pooled, walletAfter: JSON.parse(new Map(JSON.parse(readFileSync(join(wallet, 'wallet.json'), 'utf8'))).get('notes')), notesInTwoPoolNotes: twice };
  console.log('  FACTS sm10-faucet-2:', JSON.stringify(facts));
  assert.deepEqual([mint1.code, balance.code, mint2.code], [0, 0, 0], 'every run ended normally');
  assert.deepEqual(twice, [], `the pool holds ${twice.join(', ')} in two notes: the second welcome given from it is refused by the federation as already spent`);
});
