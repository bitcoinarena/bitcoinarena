// THE SEVEN TESTNET4 ADVERTISEMENT UPDATES, BUILT OFF THE CHAIN (kanban #148, plan comment 222). tools/testnet4-advert-update.mjs
// runs as it is run, against the fake bitcoin-cli (test/fake-bitcoin-cli.mjs), over a home dir built here the way
// ~/blwp-testnet4 is: seven node stores, each guardian's local.json and consensus.json, the invite. Each node's bond is a real
// bond transaction to that node's testnet4 bond key, committing to an advertisement that names its old guardian key. Without
// --publish the tool must build and check everything and broadcast nothing; with it, the funding first and then the seven
// updates. Every update must read back as an update of its node's bond carrying the guardian's current key, the funding must
// spend the named input and nothing else, and no bond-sized output may appear anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { runTool } from './tn4-tool-harness.js';
import { openStore, nodeIdentity } from '../src/store.js';
import { inviteForGuardians } from '../src/invite.js';
import { tweakPoint, combine } from '../src/curve.js';
import { genesisFor } from '../../protocol/src/genesis.js';
import { bondOutputKey, bondInternalKey } from '../../protocol/src/bond-script.js';
import { advertId } from '../../protocol/src/advert.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { readAdvertUpdate } from '../../protocol/src/advert-update.js';
import { bondTransaction } from '../../protocol/tools/bond.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const TOOL = new URL('../tools/testnet4-advert-update.mjs', import.meta.url).pathname;
const b32 = (n) => new Uint8Array(32).fill(n);
const FED = b32(0x33);
const FUND = { txid: 'ab'.repeat(32), vout: 1 };
const g = genesisFor('testnet4');
const oldKey = (n) => '03' + toHex(b32(0x40 + n));
const newKey = (n) => '02' + toHex(b32(0x70 + n));
const display = (tx) => toHex(Uint8Array.from(parseTransaction(tx).txid).reverse());

function bondKey(nodeKey) {
  return bondOutputKey({ nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: g.bondMaturity,
    internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey }, { tweakPoint, combine }).outputKey;
}
const advert = (nodePubkey, guardianKey, n) => ({
  nodePubkey, operatorId: '2of2', protocolVersions: [1], roles: ['game', 'verify', 'settlement'],
  endpoint: `wss://node-${n}.example/`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0,
  bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [{ federationId: FED, guardianKey: fromHex(guardianKey) }],
  guardianCapable: true, guardianEndpoint: `wss://node-${n}.example/guardian`, timestamp: 1788700000000n,
});

// ~/blwp-testnet4 as the tool reads it, and the chain as the fake answers it. `current`: the nodes whose bond already names
// their guardian's key; `unbonded`: nodes with no bond on chain.
function home({ current = [], unbonded = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tn4-home-'));
  const consensus = { broadcast_public_keys: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [String(n - 1), newKey(n)])) };
  const spec = { wallets: ['blwp-tn4-bonds'], scan: {}, raw: {}, txout: { [`${FUND.txid}:${FUND.vout}`]: { value: 0.001, confirmations: 3 } }, send: true };
  const nodes = [];
  for (let n = 1; n <= 7; n++) {
    const store = join(dir, `node-${n}.db`);
    const db = openStore(store);
    const { secret, pubkey } = nodeIdentity(db);
    db.close?.();
    mkdirSync(`${store}.guardian`);
    writeFileSync(`${store}.guardian/local.json`, JSON.stringify({ identity: n - 1 }));
    writeFileSync(`${store}.guardian/consensus.json`, JSON.stringify(consensus));
    const a = advert(pubkey, current.includes(n) ? newKey(n) : oldKey(n), n);
    const tx = bondTransaction(a, { value: 50000, signature: schnorr.sign(advertId(a), secret), outputKey: bondKey(pubkey),
      previousTxid: b32(0x90 + n), network: 'testnet4' });
    const txid = display(tx);
    if (!unbonded.includes(n)) {
      spec.scan[`raw(5120${toHex(bondKey(pubkey))})`] = [{ txid, vout: 0, height: 125000 + n, amount: 0.0005 }];
      spec.raw[txid] = toHex(tx);
    }
    nodes.push({ n, pubkey, bond: { txid, vout: 0 } });
  }
  writeFileSync(join(dir, 'invite-code'), inviteForGuardians(FED, [{ url: 'wss://guardian-0.example/', peer: 0 }]));
  return { dir, spec, nodes };
}
const run = (h, { publish = false, fund = `${FUND.txid}:${FUND.vout}`, spec = {} } = {}) =>
  runTool(TOOL, { spec: { ...h.spec, ...spec }, args: () => (publish ? ['--publish'] : []),
    env: { BLWP_TESTNET4_DIR: h.dir, BLWP_FUND_INPUT: fund } });
const carrierFiles = (h) => readdirSync(h.dir).filter((f) => f.startsWith('advert-update-carriers-'));
const accepted = (r) => JSON.parse(r.calls.find((c) => c.method === 'testmempoolaccept').params[0]);

function checkBuilt(r, h, nodes) {
  const [funding, ...updates] = accepted(r);
  const f = parseTransaction(fromHex(funding));
  assert.equal(f.inputs.length, 1, 'the funding spends one input');
  assert.equal(toHex(Uint8Array.from(f.inputs[0].previousTxid).reverse()), FUND.txid);
  assert.equal(f.inputs[0].previousVout, FUND.vout);
  assert.equal(updates.length, nodes.length);
  for (const [i, hex] of updates.entries()) {
    const node = h.nodes.find((x) => x.n === nodes[i]);
    const tx = parseTransaction(fromHex(hex));
    assert.equal(tx.inputs.length, 1);
    assert.equal(toHex(Uint8Array.from(tx.inputs[0].previousTxid).reverse()), display(fromHex(funding)), 'each update spends its carrier');
    assert.ok(tx.outputs.every((o) => o.value < 50000n), 'no bond-sized output');
    const read = readAdvertUpdate(fromHex(hex), { network: 'testnet4' });
    assert.ok(read.ok, read.why);
    assert.equal(toHex(Uint8Array.from(read.bondTxid).reverse()), node.bond.txid, `node ${node.n} updates its own bond`);
    assert.equal(toHex(read.nodePubkey), toHex(node.pubkey));
    assert.ok(schnorr.verify(read.signature, read.advertId, read.nodePubkey), 'signed by the node key');
    assert.equal(toHex(read.advert.guardianOf[0].guardianKey), newKey(node.n), `node ${node.n} now names its guardian's key`);
    assert.equal(read.advert.endpoint, `wss://node-${node.n}.example/`, 'nothing else in the advertisement changes');
  }
  assert.ok(f.outputs.every((o) => o.value < 50000n || o.script[0] === 0x00), 'the funding pays no bond');
}

test('without --publish: seven updates built and checked by testmempoolaccept, nothing broadcast, carrier keys written 0600', async () => {
  const h = home();
  const r = await run(h);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.methods.includes('sendrawtransaction'), false, 'nothing is broadcast');
  assert.match(r.stdout, /"published":false/);
  checkBuilt(r, h, [1, 2, 3, 4, 5, 6, 7]);
  const files = carrierFiles(h);
  assert.equal(files.length, 1);
  assert.equal(statSync(join(h.dir, files[0])).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(h.dir, files[0]), 'utf8')).map((c) => c.node), [1, 2, 3, 4, 5, 6, 7]);
});

test('with --publish: the funding is sent first, then the seven updates, each the one testmempoolaccept checked', async () => {
  const h = home();
  const r = await run(h, { publish: true });
  assert.equal(r.code, 0, r.stderr);
  const sent = r.calls.filter((c) => c.method === 'sendrawtransaction').map((c) => c.params[0]);
  assert.deepEqual(sent, accepted(r), 'the funding, then each update, as checked');
  assert.match(r.stdout, /"published":true/);
  checkBuilt(r, h, [1, 2, 3, 4, 5, 6, 7]);
});

test('a bond that already names its guardian\'s key is left alone; when all do, nothing is funded and no key file is written', async () => {
  const some = home({ current: [3, 5] });
  const r = await run(some);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"node":3,"update":"not needed/);
  checkBuilt(r, some, [1, 2, 4, 6, 7]);
  const all = home({ current: [1, 2, 3, 4, 5, 6, 7] });
  const none = await run(all, { publish: true });
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /nothing posted/);
  for (const m of ['gettxout', 'walletcreatefundedpsbt', 'testmempoolaccept', 'sendrawtransaction']) assert.equal(none.methods.includes(m), false, m);
  assert.deepEqual(carrierFiles(all), []);
});

test('refused before anything is sent: no named input, a bond-valued or spent input, a node with no bond, an unsigned funding, a mempool refusal', async () => {
  const h = home();
  const noInput = await run(h, { publish: true, fund: '' });
  assert.notEqual(noInput.code, 0);
  assert.match(noInput.stderr, /BLWP_FUND_INPUT=<txid>:<vout>/);
  assert.deepEqual(noInput.methods, []);
  const bondValued = await run(h, { publish: true, spec: { txout: { [`${FUND.txid}:${FUND.vout}`]: { value: 0.0005 } } } });
  assert.match(bondValued.stderr, /that input has a bond's or a marker's value/);
  const spent = await run(h, { publish: true, spec: { txout: {} } });
  assert.match(spent.stderr, /is not an unspent output/);
  const unsigned = await run(h, { publish: true, spec: { signs: false } });
  assert.match(unsigned.stderr, /the funding transaction did not sign/);
  const refused = await run(h, { publish: true, spec: { refuse: { 4: 'min relay fee not met' } } });
  assert.match(refused.stderr, /the mempool refuses a transaction above; nothing is broadcast/);
  assert.match(refused.stdout, /min relay fee not met/);
  for (const r of [bondValued, spent, unsigned, refused]) {
    assert.notEqual(r.code, 0);
    assert.equal(r.methods.includes('sendrawtransaction'), false);
  }
  const lone = home({ unbonded: [6] });
  const noBond = await run(lone, { publish: true });
  assert.match(noBond.stderr, /node 6 \([0-9a-f]{8}\) has no confirmed unspent bond: nothing to update, and no bond is posted/);
  assert.equal(noBond.methods.includes('sendrawtransaction'), false);
  assert.deepEqual(carrierFiles(lone), [], 'refused before any carrier key is written');
});
