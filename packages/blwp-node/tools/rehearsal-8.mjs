// FEDERATION.md REHEARSAL ITEM 8, MEASURED ON THE SHIPPED PAGE PATH: "deposit into the player wallet; a stake spent from
// it into a lock with no Lightning payment between; the lock verified by the seats as in item 1". Run by
// rehearsal-8-regtest.sh after the federation is up (stock fedimintd 0.12.0, 4 guardians, 3 of 4).
//
// One player, a paying round naming the federation on seven bonded signer nodes, the seats making their own claim key. The stake is locked
// by page-lock.js's lockStake - the page's own code - and every Lightning payment the player's lnd makes while it runs
// is counted. Recorded: the wallet the stake is funded from (its key and balance before), each deposit invoice lockStake
// asks lnd to pay, the msat leaving that wallet and the msat arriving in the lock, and the seats' verdict on the lock.
// Item 8 passes only with ZERO Lightning payments between the deposit into the player wallet and the lock.
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';

import { standUpRound } from './round-2of2.mjs';
import { stakeLockPort } from '../src/stake-lock-port.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { awaitAttestedClaimKey, stakeFor, postHandout, entryFor, playerFor, sharesNeededFor } from '../../blwp-client/src/join.js';
import { lockStake, handLock } from '../../blwp-client/src/page-lock.js';
import { pageCurve } from '../../blwp-client/src/page-curve.js';
import { encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const random = (n) => new Uint8Array(randomBytes(n));

// THE LOCK CLIENT, as the page loads it (the glue is ESM; dist is CommonJS).
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const dist = new URL('../../blwp-client/dist/', import.meta.url).pathname;
const glueDir = mkdtempSync(join(tmpdir(), 'rehearsal8-glue-'));
copyFileSync(join(dist, 'blwp_lock_client.js'), join(glueDir, 'blwp_lock_client.mjs'));
const glue = await import(join(glueDir, 'blwp_lock_client.mjs'));
await glue.default({ module_or_path: readFileSync(join(dist, 'blwp_lock_client_bg.wasm')) });
const { LockClient } = glue;
const federationId = fromHex(LockClient.federationIdOf(env.INVITE));

const lncli = (...a) => new Promise((done) => execFile(`${env.LND_BIN}/lncli`,
  [`--lnddir=${P}/alice`, '--rpcserver=127.0.0.1:30107', '--network=regtest', ...a],
  { timeout: 120000 }, (err, out) => done({ err: err ? err.message.slice(0, 160) : null, out: String(out) })));
const payments = async () => (JSON.parse((await lncli('listpayments')).out || '{"payments":[]}').payments || []);
const tab = () => {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};

// THE ROUND ON THE CHAIN, as federation-round-3.mjs stands it: a paying FEDERATION round opens only on nodes that read
// the chain (census, beacon) and whose bonds cover the federation's threshold. SEVEN signer nodes, not three: the
// committee sizes are 2 and 7 (f2759068 refuses any other), and two nodes cannot cover a 3-of-4 federation. The first
// four bond one guardian each, read off the federation itself through the signer nodes' own lock port; three bond none.
const rpcport = env.RPCPORT || '30101';
const BIN = `${env.BITCOIN_BIN}/bitcoin-cli`;
const base = ['-regtest', `-datadir=${P}/btc`, `-rpcport=${rpcport}`, '-rpcuser=blwp', '-rpcpassword=blwp'];
const cliRaw = (...a) => execFileSync(BIN, [...base, ...a], { encoding: 'utf8' }).trim();
const cli = (...a) => execFileSync(BIN, [...base, '-rpcwallet=blwp', ...a], { encoding: 'utf8' }).trim();
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${rpcport}/wallet/blwp`, readCookie: () => 'blwp:blwp' });
try { cliRaw('createwallet', 'blwp'); } catch { try { cliRaw('loadwallet', 'blwp'); } catch { /* already loaded */ } }
cli('generatetoaddress', '101', cli('getnewaddress'));
const port = stakeLockPort({ bin: env.LOCK_BIN, dataDir: `${P}/client` });
const fed = await port.guardians();
const perNode = [0, 1, 2, 3, 4, 5, 6].map((i) => (i < fed.keys.length ? [{ federationId: fed.federationId, guardianKey: fed.keys[i] }] : []));
const round = await standUpRound({ host: '127.0.0.1', portA: 18571, portB: 18572, portC: 18573, extraPorts: [18574, 18575, 18576, 18577], stakeMsat: 1000000n,
  rpc, cli, federationId, invite: env.INVITE, signerNode: { stakeLocks: port }, guardianOf: perNode,
  donationRecipients: { port: 18788 } });
const rid = fromHex(round.id);
const contract = round.contract;
const withId = { ...contract, id: rid };
let code = 0;
try {
  const claimKey = await awaitAttestedClaimKey({ round: withId, signerNodes: contract.nodes, nodes: round.nodes, curve: pageCurve });
  say({ step: 'claim key', ok: claimKey.ok, attested: claimKey.attested, needed: claimKey.needed });
  if (!claimKey.ok) throw new Error(claimKey.why);

  const seed = random(32);
  const player = playerFor(withId, { seed, curve: pageCurve });
  const needed = sharesNeededFor(contract);
  const stake = await stakeFor(withId, { signerNodes: contract.nodes, curve: pageCurve, random, playerPubkey: player.pubkey });
  const put = await postHandout(stake, round.nodes);
  say({ step: 'handout', ok: put.ok, accepted: put.accepted, needed });

  const before = await payments();
  const steps = [];
  const deposits = [];
  let paying = Promise.resolve();
  const lock = await lockStake({ round: contract, roundId: rid, invite: env.INVITE, seed, stake, claimKey,
    playerPubkey: player.pubkey, LockClient, storage: tab(),
    onStep: (s) => steps.push(s),
    onDeposit: (d) => {
      paying = paying.then(async () => {
        const paid = await lncli('payinvoice', '--force', d.invoice);
        deposits.push({ invoiceMsat: d.amountMsat, creditsMsat: d.creditsMsat,
          lnd: (paid.out.match(/Payment status: [A-Z_]+/) || [paid.err || '?'])[0] });
      });
    } });
  await paying;
  const after = await payments();
  const heldBefore = steps.filter((s) => /^holding \d+ msat$/.test(s)).map((s) => s.match(/\d+/)[0]);
  const heldAtLock = (steps.find((s) => s.startsWith('holding ') && s.includes('before locking')) || '').match(/holding (\d+) msat/);
  const leftAfter = BigInt(await lock.client.balanceMsat());
  const entry = { roundId: rid, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    ...entryFor(withId, { seed, curve: pageCurve, random, stake, claimKey, stakeLock: lock }) };
  const joined = [];
  for (const base of round.nodes) joined.push((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status);
  const handed = await handLock({ entryId: entryId(entry), fields: lock.fields, nodes: round.nodes, needed });
  const lightningBetween = after.length - before.length;
  say({ step: 'item 8', wallet: 'the lock client lockStake joins, keyed by lockSecretFor(seed, roundId): one per round',
    walletBalanceBeforeMsat: heldBefore[0] ?? null, deposits, lightningPaymentsDuringStake: lightningBetween,
    heldAtLockMsat: heldAtLock ? heldAtLock[1] : null, leftAfterLocksMsat: leftAfter,
    stakeLockMsat: lock.fields.amountMsat, feeLockMsat: lock.feeLock ? lock.feeLock.fields.amountMsat : 0n,
    outpoint: `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`, entries: joined,
    seatsVerify: handed.said.map((s) => s.status), committed: handed.committed,
    verdict: lightningBetween === 0 ? 'PASS: no Lightning payment between the deposit and the lock'
      : `RED: ${lightningBetween} Lightning payment(s) made inside the stake path` });
  say({ step: 'page steps', steps });
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  await round.close();
}
process.exit(code);
