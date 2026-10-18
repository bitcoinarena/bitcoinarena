// THE CHAIN BRIDGE (kanban #471, Electrum mode): the seat's bitcoind calls answered from an Electrum server's headers and Esplora's
// blocks - a block kept only when its header, merkle root and witness commitment say it is that block; a wallet call refused by name.
// Live, 2026-10-18: 27 blocks (4.5 MB) byte-identical to Bitcoin Core through mempool.space; 301 real blocks accepted and 903
// tampered copies refused by blockMatches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, blockMatches, powOk, readTx } from '../src/chain-bridge.js';
import { TESTNET4_GENESIS } from '../src/chain-test.js';

const G_HEADER = '0100000000000000000000000000000000000000000000000000000000000000000000004e7b2b9128fe0291db0693af2ae418b767e657cd407e80cb1434221eaea7a07a046f3566ffff001dbb0c7817';
const G_BLOCK = G_HEADER + '0101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff5504ffff001d01044c4c30332f4d61792f323032342030303030303030303030303030303030303030303165626435386332343439373062336161396437383362623030313031316662653865613865393865303065ffffffff0100f2052a010000002321000000000000000000000000000000000000000000000000000000000000000000ac00000000';

test('a block is its header\'s: hash, merkle root, proof of work; a changed byte is refused', () => {
  const raw = Buffer.from(G_BLOCK, 'hex');
  assert.equal(blockMatches(raw, TESTNET4_GENESIS), true);
  assert.equal(powOk(raw.subarray(0, 80)), true);
  for (const at of [100, 150, raw.length - 3]) { const bad = Buffer.from(raw); bad[at] ^= 1; assert.equal(blockMatches(bad, TESTNET4_GENESIS), false, `byte ${at}`); }
  assert.equal(blockMatches(raw, '00'.repeat(32)), false, 'another hash');
  const weak = Buffer.from(raw.subarray(0, 80)); weak[79] ^= 0x55; assert.equal(powOk(weak), false, 'a changed nonce fails the work');
  assert.equal(Buffer.from(readTx(raw, 81).txid).reverse().toString('hex'), '7aa0a7ae1e223414cb807e40cd57e667b718e42aaf9306db9102fe28912b7b4e', 'the coinbase txid');
});

test('the seat\'s calls through the bridge: tip, hash, header (verbose and raw), raw block from Esplora once, then from disk; wallet calls refused', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-bridge-'));
  let esploraReads = 0;
  const session = async () => ({
    call: async (m, p) => (m === 'blockchain.headers.subscribe' ? { height: 0, hex: G_HEADER } : m === 'blockchain.block.header' && p[0] === 0 ? G_HEADER : (() => { throw new Error('no such'); })()),
    close: () => {},
  });
  const fetcher = async (url) => {
    if (url.endsWith('/status')) return new Response(JSON.stringify({ in_best_chain: true, height: 0 }));
    esploraReads += 1; return new Response(Buffer.from(G_BLOCK, 'hex'));
  };
  const b = createBridge({ electrum: { host: 'e', port: 1, tls: false }, home, session, fetcher });
  t.after(() => { b.close(); rmSync(home, { recursive: true, force: true }); });
  assert.equal(await b.call('getblockcount'), 0);
  assert.equal(await b.call('getblockhash', [0]), TESTNET4_GENESIS);
  await assert.rejects(b.call('getblockhash', [1]), /out of range/);
  const v = await b.call('getblockheader', [TESTNET4_GENESIS]);
  assert.deepEqual([v.height, v.time, v.mediantime, v.confirmations], [0, 1714777860, 1714777860, 1]);
  assert.equal(await b.call('getblockheader', [TESTNET4_GENESIS, false]), G_HEADER);
  assert.equal(await b.call('getblock', [TESTNET4_GENESIS, 0]), G_BLOCK);
  assert.equal(await b.call('getblock', [TESTNET4_GENESIS, 0]), G_BLOCK);
  assert.equal(esploraReads, 1, 'the second read is from disk');
  await assert.rejects(b.call('listunspent'), /not served in Electrum mode/);
  const info = await b.call('getblockchaininfo');
  assert.deepEqual([info.chain, info.blocks, info.bestblockhash], ['testnet4', 0, TESTNET4_GENESIS]);
  // over HTTP with the cookie it wrote, as main.js calls it
  const port = await b.listen(0);
  const cookie = readFileSync(b.cookiePath, 'utf8').trim();
  assert.equal(statSync(b.cookiePath).mode & 0o777, 0o600);
  const ask = (auth) => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}` }, body: JSON.stringify({ id: 1, method: 'getblockhash', params: [0] }) });
  assert.equal((await ask('__cookie__:wrong')).status, 401);
  assert.equal((await (await ask(cookie)).json()).result, TESTNET4_GENESIS);
});

test('a block Esplora changed is never handed on', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-bridge-'));
  const session = async () => ({ call: async (m) => (m === 'blockchain.headers.subscribe' ? { height: 0, hex: G_HEADER } : G_HEADER), close: () => {} });
  const bad = Buffer.from(G_BLOCK, 'hex'); bad[120] ^= 1;
  const fetcher = async (url) => (url.endsWith('/status') ? new Response(JSON.stringify({ in_best_chain: true, height: 0 })) : new Response(bad));
  const b = createBridge({ electrum: { host: 'e', port: 1, tls: false }, home, session, fetcher });
  t.after(() => { b.close(); rmSync(home, { recursive: true, force: true }); });
  await assert.rejects(b.call('getblock', [TESTNET4_GENESIS, 0]), /does not match its header/);
});
