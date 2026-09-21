// A LAUNCHED DAEMON OPENS A PAYING ROUND THE OPERATOR NAMED, AND SIGNER NODES ITS ENTRIES (M3.3-31).
//
// Measured before: `main.js` passed `serve` no `funded`, so the default refused
// every round and every entry with 402 - a daemon started the way an operator
// starts one held no stake at all, and a round for testnet sats could not
// exist outside a harness that passed `() => true`.
//
// The rule (the owner's pick): a ROUND is funded when the operator named it and it
// asks a stake - an explicit launcher setting, off by default, so a stranger
// still cannot open 200 free rounds; an ENTRY is funded when it names a round
// this node already holds, that round asks a stake, and this node reaches
// Lightning to hold it. Not "the invoice is paid": the hold is issued after the
// entry is stored. Input batches stay gated on the stake being seen paid.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { WebSocket } from 'ws';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { fundingFromEnv, freeOrOperatorFunding } from '../src/funding.js';
import { HELD } from '../src/custody.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch } from '../../protocol/src/batch.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { assumeAssigned } from './assignment.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const READY = { preflight: async () => ({ ready: true, why: 'test port' }) };
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;
const session = ed25519.utils.randomSecretKey();

const contractFor = (nodes, stakeMsat = 100000n, tag = 0x43) => ({
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN',
  slashMinimumServed: 20 + (tag - 0x43), slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'] /* a paying round names a relay (§13A); never posted to here */, donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});
const entryFor = (rid, stakeMsat = 100000n) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
  stakeCommitment: sha256(b32(65)), stakeMsat, feeMsat: entryFeeMsat(stakeMsat),
  donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});

/** A Lightning node that issues holds and has been paid nothing. */
function unpaidPort() {
  return {
    async createHeld({ paymentHash, amountMsat }) { return { paymentHash, amountMsat, request: 'lnbcrt-x' }; },
    async look() { return { state: HELD, amountMsat: 0n, paidMsat: 0n }; },
    async settle() {}, async cancel() {},
  };
}

const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
  return { status: r.status, text: (await r.text()).trim(), hold: r.headers.get('x-hold') };
};

test('the launcher\'s rule with nothing named refuses a paying round and an entry, 402 - as before', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...READY, lightning: unpaidPort(), funded: fundingFromEnv({}) });
  try {
    const c = contractFor([node.round.pubkey, schnorr.getPublicKey(b32(9))]);
    const round = await post(node.port, '/round', encodeRoundContract(c));
    assert.equal(round.status, 402, `an unnamed paying round was opened: ${round.status} ${round.text}`);
    const entry = await post(node.port, '/entry', encodeEntryContract(entryFor(roundId(c))));
    assert.equal(entry.status, 402, `an entry was taken with nothing named: ${entry.status} ${entry.text}`);
  } finally { await node.close(); }
});

test('once the operator names a paying round it is opened and its entry taken with a hold; an unheld round\'s entry, a free round and an unpaid batch stay refused', async () => {
  const peer = schnorr.getPublicKey(b32(9));
  // The round is named by id, and its id is the hash of a contract that names
  // this node - so the node comes up first and the setting is read per ask.
  let named = '';
  const funded = fundingFromEnv({ get BLWP_FUNDED_ROUNDS() { return named; } });
  const node = await serve(openStore(':memory:'), { port: 0, ...READY, lightning: unpaidPort(), funded });
  try {
    const c = contractFor([node.round.pubkey, peer]);
    const rid = roundId(c);
    const free = contractFor([node.round.pubkey, peer], 0n, 0x44);
    const other = contractFor([node.round.pubkey, peer], 100000n, 0x45);
    named = [rid, roundId(free)].map(toHex).join(',');

    const round = await post(node.port, '/round', encodeRoundContract(c));
    assert.equal(round.status, 201, `the named paying round was refused: ${round.status} ${round.text}`);
    assumeAssigned(node.round, rid, c.nodes);
    const entry = entryFor(rid);
    const joined = await post(node.port, '/entry', encodeEntryContract(entry));
    assert.equal(joined.status, 201, `an entry into the named paying round was refused: ${joined.status} ${joined.text}`);
    assert.equal(joined.hold, HELD, 'the joined entry got no hold');

    const freeRound = await post(node.port, '/round', encodeRoundContract(free));
    assert.equal(freeRound.status, 402, `a named FREE round was opened on a launched daemon: ${freeRound.status}`);
    const unheld = await post(node.port, '/entry', encodeEntryContract(entryFor(roundId(other))));
    assert.equal(unheld.status, 402, `an entry for a round this node does not hold was taken: ${unheld.status} ${unheld.text}`);

    // AND THE TRANSCRIPT STILL WAITS FOR THE MONEY: the stake is not paid.
    const ws = new WebSocket(`ws://127.0.0.1:${node.port}/play`);
    await new Promise((r) => ws.once('open', r));
    const said = await new Promise((resolve) => {
      ws.once('message', (d) => resolve(d.toString()));
      ws.send(encodeInputBatch({ roundId: rid, entryId: entryId(entry), previousHash: GENESIS_HASH,
        firstTick: 0, ticks: [[45875, 0, 0, 0, 0]], liquidations: [] }));
    });
    ws.close();
    assert.match(said, /not (been )?(seen|paid)|nobody paid|stake/i, `an input batch for an unpaid stake was taken: ${said}`);
  } finally { await node.close(); }
});

test('a daemon that reaches no Lightning takes no entry, even into a named paying round', () => {
  const c = contractFor([schnorr.getPublicKey(b32(1)), schnorr.getPublicKey(b32(9))]);
  const funded = fundingFromEnv({ BLWP_FUNDED_ROUNDS: toHex(roundId(c)) });
  const held = { contract: encodeRoundContract(c) };
  assert.equal(funded({ kind: 'entry', contract: entryFor(roundId(c)), node: { holds: () => held, reachesLightning: true } }), true);
  assert.equal(funded({ kind: 'entry', contract: entryFor(roundId(c)), node: { holds: () => held, reachesLightning: false } }), false,
    'an entry was funded on a node that cannot hold its stake');
});

// A ROUND NAMING A FEDERATION TAKES ITS STAKE AS A LOCK THERE (§23.1, W1b), and
// the signer node verifies that lock in the federation - so what a node needs to hold
// such a stake is the federation, not Lightning. Measured before: a lock
// round's entry on a node reaching only the federation was 402 by this rule,
// so no page could be joined in one on a launched daemon.
test('a lock round\'s entry is funded on a node that reaches its federation, and not on one that reaches only Lightning', () => {
  const nodes = [schnorr.getPublicKey(b32(1)), schnorr.getPublicKey(b32(9))];
  const lockRound = { ...contractFor(nodes), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID };
  const holdRound = contractFor(nodes);
  const funded = fundingFromEnv({ BLWP_FUNDED_ROUNDS: [roundId(lockRound), roundId(holdRound)].map(toHex).join(',') });
  const ask = (c, node) => funded({ kind: 'entry', contract: entryFor(roundId(c)),
    node: { holds: () => ({ contract: encodeRoundContract(c) }), ...node } });
  assert.equal(ask(lockRound, { reachesFederation: true, reachesLightning: false }), true,
    'a lock round\'s entry was refused on a node that can verify its lock');
  assert.equal(ask(lockRound, { reachesFederation: false, reachesLightning: true }), false,
    'a lock round\'s entry was funded on a node that cannot verify its lock');
  assert.equal(ask(lockRound, { reachesFederation: false, reachesLightning: false }), false);
  assert.equal(ask(holdRound, { reachesFederation: true, reachesLightning: false }), false,
    'a hold round\'s entry was funded on a node with no Lightning to hold it');
});

// THE DAILY'S LAUNCHER WITH A FREE ROUND AND A PAYING ONE BESIDE IT (the owner 2026-09-15 12:54, option
// B): the free round and its entries stay funded as `() => true` had them, and the paying rounds go
// through the operator's rule unchanged - named, and their entries only where the stake can be held.
test('beside a free round, the launcher funds the free round and its entries, and a paying round only as the operator\'s rule does', () => {
  const nodes = [schnorr.getPublicKey(b32(1)), schnorr.getPublicKey(b32(9))];
  const free = contractFor(nodes, 0n, 0x46);
  const paying = contractFor(nodes, 100000n, 0x47);
  const unnamed = contractFor(nodes, 100000n, 0x48);
  const funded = freeOrOperatorFunding();
  funded.nameRound(roundId(paying));
  const holds = (c) => ({ holds: () => ({ contract: encodeRoundContract(c) }) });
  assert.equal(funded({ kind: 'round', contract: free }), true, 'the free round beside the paying one was refused');
  assert.equal(funded({ kind: 'entry', contract: entryFor(roundId(free), 0n), node: { ...holds(free), reachesLightning: false } }), true,
    'an entry into the free round was refused');
  assert.equal(funded({ kind: 'round', contract: paying }), true, 'the paying round this launcher named was refused');
  assert.equal(funded({ kind: 'round', contract: unnamed }), false, 'a paying round nobody named was funded');
  assert.equal(funded({ kind: 'entry', contract: entryFor(roundId(paying)), node: { ...holds(paying), reachesLightning: true } }), true);
  assert.equal(funded({ kind: 'entry', contract: entryFor(roundId(paying)), node: { ...holds(paying), reachesLightning: false } }), false,
    'an entry into the paying round was funded on a node with no Lightning to hold it');
  assert.equal(funded({ kind: 'entry', contract: entryFor(roundId(unnamed)), node: { holds: () => null } }), false,
    'an entry for a round this node does not hold was funded');
});

test('main.js itself wires the rule: an unnamed paying round is 402; a named one is opened, and with no lnd its entries are 402', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-funded-'));
  const PORT = 18902;   // never 8080: main.js defaults to it and signal-cli owns it
  const c = contractFor([schnorr.getPublicKey(b32(1)), schnorr.getPublicKey(b32(9))]);
  const start = async (env) => {
    const child = spawn(process.execPath, [new URL('../src/main.js', import.meta.url).pathname, String(PORT), join(dir, `${Object.keys(env).length}.db`)],
      { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    for (let i = 0; i < 100 && !/blwp-node on/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    return { child, out: () => out };
  };
  const stop = async (p) => { p.child.kill('SIGTERM'); await new Promise((r) => p.child.once('exit', r)); };
  try {
    const plain = await start({});
    let unnamed;
    try { unnamed = await post(PORT, '/round', encodeRoundContract(c)); } finally { await stop(plain); }
    assert.equal(unnamed.status, 402, `main.js opened an unnamed paying round: ${unnamed.status} ${unnamed.text}`);

    // MEASURED: a daemon with no lnd is not "a node that holds stakes", so the
    // round door's Lightning gate does not apply and the named round opens -
    // and the rule then refuses every entry into it: this node cannot hold one.
    const naming = await start({ BLWP_FUNDED_ROUNDS: toHex(roundId(c)) });
    let named;
    let entry;
    try {
      named = await post(PORT, '/round', encodeRoundContract(c));
      entry = await post(PORT, '/entry', encodeEntryContract(entryFor(roundId(c))));
    } finally { await stop(naming); }
    assert.equal(named.status, 201, `main.js refused a paying round its operator named: ${named.status} ${named.text}`);
    assert.equal(entry.status, 402, `main.js with no lnd joined an entry it cannot hold the stake of: ${entry.status} ${entry.text}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a round named in BLWP_FUNDED_ROUNDS_FILE is funded without a restart - the file is read on every ask', async () => {
  const { writeFileSync, appendFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'funded-file-'));
  const file = join(dir, 'rounds');
  writeFileSync(file, '# rounds this operator funds, one id per line\n');
  const node = await serve(openStore(':memory:'), {
    port: 0, ...READY, lightning: unpaidPort(), funded: fundingFromEnv({ BLWP_FUNDED_ROUNDS_FILE: file }),
  });
  try {
    const c = contractFor([node.round.pubkey, schnorr.getPublicKey(b32(9))]);
    const before = await post(node.port, '/round', encodeRoundContract(c));
    assert.equal(before.status, 402, `a round the file does not name was opened: ${before.status}`);
    appendFileSync(file, `${toHex(roundId(c)).toUpperCase()}\n`);   // named after start, in capitals
    const after = await post(node.port, '/round', encodeRoundContract(c));
    assert.equal(after.status, 201, `a round named in the file after start was refused: ${after.status} ${after.text}`);
  } finally { await node.close(); rmSync(dir, { recursive: true, force: true }); }
});
