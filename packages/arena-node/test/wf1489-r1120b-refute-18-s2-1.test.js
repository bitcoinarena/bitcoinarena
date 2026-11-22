// Refute of kanban #3016 / #3152 (wf1489 r1120b item 18, skeptic 2): the fix says "every update, re-bond and roles change is built on what
// inForceOf answers" - but the RE-BOND tool (tools/testnet4-rebond.mjs, the operator's move of each seat's bond into template 2) does not use
// inForceOf. It takes rt.bondsOf(secret)[0] - the newest OUTPUT by height, signed or not - and signs `{ ...bond.advert, timestamp: now }` with
// the node key (rt.prepareRebond), spending that output into the new bond. A stranger's 330-sat dust bond to the node's template-1 bond key,
// committing an UNSIGNED copy of the node's advertisement with HIS payout key, mined after the node's own bond, is bonds[0]: the operator's
// re-bond signs the stranger's payout key as the node's own advertisement (the original #3016 attack, on the re-bond path), and moves the
// stranger's 330 sat in place of the node's real bond.
// Run as the operator runs it (a child process, a fake bitcoin-cli answering from a fixture, the seat's store holding the node key), with no
// --publish: nothing past the build is reached (gettxout of the funding input answers null).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { regtest } from '../tools/regtest-bond.mjs';
import { openStore } from '../src/store.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const here = dirname(fileURLToPath(import.meta.url));
const b32 = (n) => new Uint8Array(32).fill(n);
const SECRET = b32(0x11);
const NODE = schnorr.getPublicKey(SECRET);
const OWN_PAYOUT = schnorr.getPublicKey(b32(0x21));
const ATTACKER_PAYOUT = schnorr.getPublicKey(b32(0x66));
const advertFor = (over = {}) => ({
  nodePubkey: NODE, operatorId: 'op-victim', protocolVersions: [19],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], endpoint: 'wss://victim.example', region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: OWN_PAYOUT, guardianOf: [], timestamp: 1000n, ...over,
});
const displayTxid = (hex) => toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse());

test('refute #3016: the re-bond tool signs a stranger\'s unsigned dust bond body as the node\'s own advertisement', () => {
  // testnet4's template-1 bond key of the node (genesis maturity), as bondsOf scans it
  const keyRt = regtest((m) => (m === 'listwallets' ? '["x"]' : ''), { network: 'testnet4', wallet: 'x' });
  const outputKey = keyRt.keyAt(NODE, keyRt.genesis.bondMaturity).outputKey;
  const SPK = `5120${toHex(outputKey)}`;
  const real = advertFor();
  const realHex = toHex(bondTransaction(real, { previousTxid: b32(0xa1), outputKey, value: 60000, signature: schnorr.sign(advertId(real), SECRET) }));
  const forgedHex = toHex(bondTransaction(advertFor({ payoutPubkey: ATTACKER_PAYOUT, timestamp: 1001n }), { previousTxid: b32(0xee), outputKey, value: 330 }));
  const realTxid = displayTxid(realHex), forgedTxid = displayTxid(forgedHex);

  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r18s2-'));
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ spk: SPK, tip: 130000,
    txs: { [realTxid]: { hex: realHex, height: 120000, sats: 60000 }, [forgedTxid]: { hex: forgedHex, height: 125000, sats: 330 } } }));
  const fake = join(dir, 'bitcoin-cli');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs');
const f = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'fixture.json'))}, 'utf8'));
const [m, ...a] = process.argv.slice(2).filter((x) => !/^-(datadir|rpcwallet)=/.test(x));
const out = (s) => { process.stdout.write(String(s)); process.exit(0); };
switch (m) {
  case 'listwallets': out('["blwp-tn4-bonds"]');
  case 'getblockcount': out(String(f.tip));
  case 'getblockhash': out('hash-' + a[0]);
  case 'getblock': out(JSON.stringify({ tx: [] }));
  case 'scantxoutset': {
    const d = JSON.parse(a[1]);
    out(JSON.stringify({ success: true, unspents: d.includes('raw(' + f.spk + ')')
      ? Object.entries(f.txs).map(([txid, t]) => ({ txid, vout: 0, height: t.height, amount: t.sats / 1e8, scriptPubKey: f.spk })) : [] }));
  }
  case 'getrawtransaction': { const t = f.txs[a[0]]; if (!t) { process.stderr.write('No such mempool or blockchain transaction'); process.exit(5); } out(t.hex); }
  case 'gettxout': out('null');
  default: process.stderr.write('fake bitcoin-cli: no ' + m); process.exit(1);
}
`, { mode: 0o755 });
  // the seat's store, holding the node key the tool reads
  const db = openStore(join(dir, 'node-1.db'));
  db.prepare('INSERT INTO identity (one, secret, pubkey) VALUES (0, ?, ?)').run(SECRET, NODE);
  db.close?.();

  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [join(here, '..', 'tools', 'testnet4-rebond.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BITCOIN_CLI: fake, ARENA_TESTNET4_DIR: dir, ARENA_TN4_DATADIR: dir, ARENA_REBOND_NODES: '1',
        ARENA_FUND_INPUT: `${'ab'.repeat(32)}:0` } });
  } catch (e) { stdout = String(e.stdout || ''); }
  const first = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o && o.bond);
  assert.ok(first, `the tool named the bond it moves: ${stdout}`);
  const keysFile = readdirSync(dir).find((n) => n.startsWith('rebond-carriers-'));
  const planned = keysFile ? JSON.parse(readFileSync(join(dir, keysFile), 'utf8')) : [];
  // the record the tool built the node-signed re-bond body from
  const rec = regtest((...args) => execFileSync(fake, args, { encoding: 'utf8' }).trim(), { network: 'testnet4', wallet: 'blwp-tn4-bonds' })
    .bondsOf(SECRET).find((b) => `${b.txid}:${b.vout}` === first.bond);
  console.log(`  MEASURED: re-bond moves ${first.bond === `${forgedTxid}:0` ? 'the STRANGER\'s dust bond' : 'the node\'s own bond'} (${first.sats} sat), `
    + `planned=${planned.map((p) => p.bond).join(',')}, its body signed=${rec && rec.signed}, `
    + `payoutPubkey the node signs=${rec && toHex(rec.advert.payoutPubkey) === toHex(ATTACKER_PAYOUT) ? 'ATTACKER\'s' : 'own'}`);
  assert.notEqual(first.bond, `${forgedTxid}:0`, 'the re-bond is built on the stranger\'s unsigned dust bond');
  assert.equal(first.bond, `${realTxid}:0`);
});
