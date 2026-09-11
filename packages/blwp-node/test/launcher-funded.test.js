// A LAUNCHED DAEMON OPENS A PAYING ROUND THE OPERATOR NAMED, AND SEATS ITS ENTRIES (M3.3-31).
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
import { test } from 'node:test';
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
import { fundingFromEnv } from '../src/funding.js';
import { HELD } from '../src/custody.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch } from '../../protocol/src/batch.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { assumeSeated } from './seating.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const READY = { preflight: async () => ({ ready: true, why: 'test port' }) };
const GENESIS_HASH = (await import('../../protocol/src/transcript.js')).GENESIS;
const session = ed25519.utils.randomSecretKey();

const contractFor = (nodes, stakeMsat = 100000n, tag = 0x43) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(tag), censusConfirmations: 1,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1), startTimeMs: 60500n,
  entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION',
  slashMinimumServed: 20, slashRemainder: 'BURN', donationSetId: b32(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat, bondMinSats: 50000n,
  blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});
const entryFor = (rid, stakeMsat = 100000n) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session),
  stakeCommitment: sha256(b32(65)), stakeMsat, feeMsat: entryFeeMsat(stakeMsat),
  donationMsat: 0n, joinTick: 0, worldSecret: b32(0x16), vssSharesRef: new Uint8Array(32),
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
    assert.equal(entry.status, 402, `an entry was seated with nothing named: ${entry.status} ${entry.text}`);
  } finally { await node.close(); }
});

test('once the operator names a paying round it is opened and its entry seated with a hold; an unheld round\'s entry, a free round and an unpaid batch stay refused', async () => {
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
    assumeSeated(node.round, rid, c.nodes);
    const entry = entryFor(rid);
    const seated = await post(node.port, '/entry', encodeEntryContract(entry));
    assert.equal(seated.status, 201, `an entry into the named paying round was refused: ${seated.status} ${seated.text}`);
    assert.equal(seated.hold, HELD, 'the seated entry got no hold');

    const freeRound = await post(node.port, '/round', encodeRoundContract(free));
    assert.equal(freeRound.status, 402, `a named FREE round was opened on a launched daemon: ${freeRound.status}`);
    const unheld = await post(node.port, '/entry', encodeEntryContract(entryFor(roundId(other))));
    assert.equal(unheld.status, 402, `an entry for a round this node does not hold was seated: ${unheld.status} ${unheld.text}`);

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

test('a daemon that reaches no Lightning seats no entry, even into a named paying round', () => {
  const c = contractFor([schnorr.getPublicKey(b32(1)), schnorr.getPublicKey(b32(9))]);
  const funded = fundingFromEnv({ BLWP_FUNDED_ROUNDS: toHex(roundId(c)) });
  const held = { contract: encodeRoundContract(c) };
  assert.equal(funded({ kind: 'entry', contract: entryFor(roundId(c)), node: { holds: () => held, reachesLightning: true } }), true);
  assert.equal(funded({ kind: 'entry', contract: entryFor(roundId(c)), node: { holds: () => held, reachesLightning: false } }), false,
    'an entry was funded on a node that cannot hold its stake');
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
    assert.equal(entry.status, 402, `main.js with no lnd seated an entry it cannot hold the stake of: ${entry.status} ${entry.text}`);
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
