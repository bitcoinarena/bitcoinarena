// DOES A DAEMON REFUSE TO OPEN A PAYING ROUND ON A NODE THAT CANNOT HOLD IT?
// Measured against the operator's real testnet4 lnd, and nothing is moved.
//
//   node packages/blwp-node/tools/testnet4-gate.mjs [--lnddir /mnt/bitcoin/lnd-testnet4]
//
// The daemon is given the REAL preflight (`lndPreflight`, read-only macaroon)
// and a Lightning port that THROWS on every call - so no spending macaroon is
// loaded by this process at all, and a gate that let a round through could
// still not issue a hold. It opens one round that asks 100000 msat and one
// that asks nothing, in memory, on a loopback port, and prints both answers.
import { CORE_HASH } from './core-hash.mjs';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { lndPreflight } from '../src/preflight.js';
import { encodeRoundContract } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const LNCLI = (process.env.LND_BIN || '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta') + '/lncli';
const lnddir = arg('lnddir', '/mnt/bitcoin/lnd-testnet4');

const refuse = (op) => async () => { throw new Error(`this measurement holds nothing: ${op} was called`); };
const port = { createHeld: refuse('createHeld'), look: refuse('look'), settle: refuse('settle'), cancel: refuse('cancel') };

const NOW = Date.now();
const b32 = (n) => new Uint8Array(32).fill(n);
const contractFor = (nodes, stakeMsat) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS, entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144,
  // a paying round names a relay (§13A, else the door refuses it before the
  // preflight this measures); nothing here ever posts to it
  publicationRelays: ['http://127.0.0.1:9'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

const node = await serve(openStore(':memory:'), {
  port: 0, funded: () => true, lightning: port, preflight: lndPreflight({ lncli: LNCLI, lnddir }),
});
try {
  for (const stake of [100000n, 0n]) {
    const r = await fetch(`http://127.0.0.1:${node.port}/round`,
      { method: 'POST', body: encodeRoundContract(contractFor([node.round.pubkey], stake)) });
    const body = r.status === 201 ? 'opened' : (await r.text()).trim();
    console.log(`round asking ${String(stake).padStart(6)} msat -> ${r.status} ${body}`);
  }
} finally { await node.close(); }
