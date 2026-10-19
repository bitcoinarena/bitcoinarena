// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEDERATION.md REHEARSAL ITEM 8, MEASURED ON THE SHIPPED PAGE PATH: "deposit into the player wallet; a stake spent from
// it into a lock with no Lightning payment between; the lock verified by the seats as in item 1". Run by
// rehearsal-8-regtest.sh after the federation is up (stock fedimintd 0.12.0, 4 guardians, 3 of 4).
//
// One player, a paying round naming the federation on seven bonded signer nodes, the seats making their own claim key.
// REMEASURED ON THE PLAYER WALLET (§24A.1, 2026-09-25): first a deposit into the player wallet (fundPlayerWallet, its own
// act, paid by the player's lnd), then the stake by page-lock.js's lockStake from that wallet - and every Lightning
// payment the player's lnd makes between the two is counted. Recorded: which wallet the stake left (keyed by seed and
// federation, not round), the deposit into it, the msat leaving it and arriving in the locks, and the seats' verdict.
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
import { awaitAttestedClaimKey, stakeFor, postHandout, entryFor, playerFor, sharesNeededFor } from '../../arena-client/src/join.js';
import { lockStake, fundPlayerWallet, handLock, walletSecretFor, lockSecretFor } from '../../arena-client/src/page-lock.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';

const env = process.env;
const P = env.PROBE;
const say = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
const random = (n) => new Uint8Array(randomBytes(n));

// THE LOCK CLIENT, as the page loads it (the glue is ESM; dist is CommonJS).
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const dist = new URL('../../arena-client/dist/', import.meta.url).pathname;
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
const base = ['-regtest', `-datadir=${P}/btc`, `-rpcport=${rpcport}`, '-rpcuser=arena', '-rpcpassword=arena'];
const cliRaw = (...a) => execFileSync(BIN, [...base, ...a], { encoding: 'utf8' }).trim();
const cli = (...a) => execFileSync(BIN, [...base, '-rpcwallet=arena', ...a], { encoding: 'utf8' }).trim();
const rpc = bitcoindRpc({ url: `http://127.0.0.1:${rpcport}/wallet/arena`, readCookie: () => 'arena:arena' });
try { cliRaw('createwallet', 'arena'); } catch { try { cliRaw('loadwallet', 'arena'); } catch { /* already loaded */ } }
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

  // 1. THE DEPOSIT INTO THE PLAYER WALLET (§24A.1): its own act, paid by the player's lnd - counted apart.
  const tabStore = tab();
  const before = await payments();
  const steps = [];
  const deposits = [];
  let paying = Promise.resolve();
  const topUp = await fundPlayerWallet({ round: contract, invite: env.INVITE, seed, LockClient, storage: tabStore,
    onStep: (s) => steps.push(`top-up: ${s}`),
    onDeposit: (d) => {
      paying = paying.then(async () => {
        const paid = await lncli('payinvoice', '--force', d.invoice);
        deposits.push({ invoiceMsat: d.amountMsat, creditsMsat: d.creditsMsat,
          lnd: (paid.out.match(/Payment status: [A-Z_]+/g) || [paid.err || '?']).pop() });
      });
    } });
  await paying;
  const afterDeposit = await payments();
  // 2. THE STAKE, FROM THE PLAYER WALLET: every Lightning payment the player's lnd makes from here to the lock is counted.
  const lock = await lockStake({ round: contract, roundId: rid, invite: env.INVITE, seed, stake, claimKey,
    playerPubkey: player.pubkey, LockClient, storage: tabStore, onStep: (s) => steps.push(`stake: ${s}`) });
  const afterLock = await payments();
  const lightningBetween = afterLock.length - afterDeposit.length;
  const keys = [];
  for (let i = 0; i < tabStore.length; i++) keys.push(tabStore.key(i));
  const walletId = toHex(sha256(walletSecretFor(seed, contract.federationId))).slice(0, 16);
  const roundWalletId = toHex(sha256(lockSecretFor(seed, rid))).slice(0, 16);
  const entry = { roundId: rid, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    ...entryFor(withId, { seed, curve: pageCurve, random, stake, claimKey, stakeLock: lock }) };
  const joined = [];
  for (const base of round.nodes) joined.push((await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) })).status);
  const handed = await handLock({ entryId: entryId(entry), fields: lock.fields, nodes: round.nodes, needed });
  say({ step: 'item 8',
    wallet: { keyedBy: 'seed and federation (walletSecretFor)', walletId, perRoundWalletId: roundWalletId,
      tabKeysPlayerWallet: keys.filter((k) => k.startsWith(`arena.walletdb.${toHex(contract.federationId).slice(0, 16)}.${walletId}.`)).length,
      tabKeysPerRoundWallet: keys.filter((k) => k.startsWith('arena.lockdb.')).length },
    deposit: { into: 'the player wallet', paymentsByLnd: afterDeposit.length - before.length, deposits, walletHeldAfterMsat: topUp.heldMsat },
    stake: { walletBeforeMsat: lock.walletBeforeMsat, walletAfterMsat: lock.walletAfterMsat,
      leftThePlayerWalletMsat: lock.walletBeforeMsat - lock.walletAfterMsat,
      stakeLockMsat: lock.fields.amountMsat, feeLockMsat: lock.feeLock ? lock.feeLock.fields.amountMsat : 0n,
      outpoint: `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`, contract: 'stock OutgoingContract to claim_pk (§23 stake lock)' },
    lightningBetweenDepositAndLock: lightningBetween,
    entries: joined, seatsVerify: handed.said.map((s) => ({ status: s.status, why: String(s.why || '').slice(0, 200) })), committed: handed.committed,
    verdict: (lightningBetween === 0 && lock.walletBeforeMsat > lock.walletAfterMsat && handed.committed >= needed)
      ? 'PASS: the stake left the player wallet, no Lightning payment sat between the deposit and the lock, and the seats verified it'
      : `RED: ${lightningBetween} Lightning payment(s) between the deposit and the lock; left the player wallet ${lock.walletBeforeMsat - lock.walletAfterMsat} msat; seats committed ${handed.committed} of ${needed}` });
  say({ step: 'page steps', steps });
} catch (e) {
  say({ error: e.message, stack: String(e.stack).split('\n').slice(1, 4).join(' | ') });
  code = 1;
} finally {
  await round.close();
}
process.exit(code);
