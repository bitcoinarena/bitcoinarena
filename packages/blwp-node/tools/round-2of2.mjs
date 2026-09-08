#!/usr/bin/env node
/**
 * ONE ROUND THE TWO DAEMONS AGREE ON, AND THE URL THAT OPENS IT.
 *
 *   node packages/blwp-node/tools/round-2of2.mjs
 *
 * The page can be SENT to a round now - `?round=` names an id and the client
 * refuses a contract that does not hash to it - and it names three other
 * things: who holds the round, where a chain is read, and where the bond
 * proof is asked for. The daemons publish the first. THEY PUBLISH NEITHER OF
 * THE OTHER TWO, and they should not: section 25.1 wants block headers "from
 * several independent sources", and a node serving the chain that proves its
 * own bond is one source wearing two hats. So the providers stand beside the
 * daemons, on their own ports, which is what an operator runs.
 *
 * WHAT THIS IS NOT. It is not a lobby: it agrees one round between two daemons
 * that already exist and prints the address of it. Nothing here is in the
 * page, and the page still invents nothing - it is handed names and it checks
 * them.
 *
 * THE CHAIN IS A FIXTURE AND IS SAID SO. Bitcoin's real genesis header with
 * one block mined on top of it at trivial difficulty, carrying the bond. That
 * is enough for `Client.at` to do every check it makes - the anchor is
 * genesis and comes from the client, the header must link and be mined, the
 * bond must be proven into it by a merkle branch, and the advertisement must
 * be signed by the key the committee names - and it is not a claim about
 * Bitcoin. A round played on it is a local test round. Reading a real chain is
 * the operator's own bitcoind, and no live node is touched from here.
 */
import { schnorr } from '@noble/curves/secp256k1.js';

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import { openStore, nodeIdentity } from '../src/store.js';
import { serve } from '../src/server.js';
import { toHex } from '../../protocol/src/hash.js';
import { BITCOIN_MAINNET_GENESIS_HEADER, blockHashOf } from '../../protocol/src/chain.js';
import { hash256, parseTransaction } from '../../protocol/src/tx.js';
import { advertId } from '../../protocol/src/advert.js';
import { bondTransaction, blockOf } from '../../protocol/tools/bond.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';

const b32 = (n) => new Uint8Array(32).fill(n);
/**
 * Two daemons, one agreed round, and the providers a page needs to check it.
 *
 * Exported so the test can drive exactly what an operator runs, rather than a
 * second arrangement that looks like it.
 */
export async function standUpRound({ host = '127.0.0.1', portA = 8080, portB = 8081,
                                     store = ':memory:', page = 'https://btc-logistics-core.pages.dev' } = {}) {
  const funded = () => true;
  const randomnessFor = () => ({ hash: b32(0xbe), height: 900005, timeMs: 900n });

  // THE KEY BEFORE THE DAEMON. The advertisement names the key that signs it,
  // the bond commits to the advertisement, and the daemon serves the chain
  // that bond is mined into - so the identity has to be in hand before any of
  // it is built. It comes out of the store, which is where it lives.
  const dbA = openStore(store === ':memory:' ? ':memory:' : store + '/a.db');
  const dbB = openStore(store === ':memory:' ? ':memory:' : store + '/b.db');
  const idA = nodeIdentity(dbA);

  // THE ADVERTISEMENT IS SIGNED BY THE NODE IT NAMES. A stranger's signature
  // is refused at the door - the committee is the round's, and the key that
  // wrote the advertisement has to be the key the committee names.
  // THE ENDPOINT IS DECIDED BEFORE THE PORT IS BOUND, because the bond commits
  // to the advertisement and the advertisement carries the address. So a fixed
  // port is asked for and the daemon must get it; port 0 would name an address
  // nobody can put in a bond that is already mined.
  if (!portA) throw new Error('this needs a fixed port for node A: the bond commits to its address');
  const endpointA = `ws://${host}:${portA}`;
  const advert = {
    nodePubkey: idA.pubkey, operatorId: '2of2', protocolVersions: [1],
    roles: ['game', 'verify'], endpoint: endpointA,
    region: 'eu-west', capacityClass: 2, softwareHash: b32(3),
    settlementCapabilities: 0, lightningCapabilities: 0,
    bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
    payoutPubkey: b32(4), timestamp: BigInt(Date.now()),
  };
  // BIP-340, because letter 26 made a node's identity ITS BOND KEY: every
  // signature a node makes is schnorr under the key its bond was posted with,
  // and an ed25519 signature here is refused at the door by name.
  const signedAdvert = schnorr.sign(advertId(advert), idA.secret);
  const transaction = bondTransaction(advert, { signature: signedAdvert });

  const sibling = b32(0x99);
  const txid = parseTransaction(transaction).txid;
  const { header } = blockOf(hash256, [txid, sibling],
    { previous: blockHashOf(BITCOIN_MAINNET_GENESIS_HEADER) });
  const chain = [BITCOIN_MAINNET_GENESIS_HEADER, header];
  const headerBytes = new Uint8Array(chain.length * 80);
  chain.forEach((h, i) => headerBytes.set(h, i * 80));

  // THE TWO DOORS THE JOIN URL NEEDS, on the daemons themselves.
  //
  // the owner's ruling, and the objection is recorded rather than argued: a node
  // serving the chain that proves its own bond is one source wearing two hats,
  // and 25.1 asks for independent ones. What makes it hold here is that there
  // are TWO daemons and `agreedChain` counts ORIGINS - and that this is a
  // local test round on a fixture chain, not a claim about Bitcoin.
  const bondProof = { hex: toHex(transaction), merkle: [toHex(sibling)], pos: 0 };
  const a = await serve(dbA, { port: portA, host, funded, randomnessFor, headerBytes, bondProof });
  const b = await serve(dbB, { port: portB, host, funded, randomnessFor, headerBytes, bondProof });
  if (a.port !== portA)
    throw new Error(`node A came up on ${a.port} and the bond names ${portA}`);

  // THE ROUND. Its times are real instants, because a node refuses an entry
  // before committee_time and refuses a round whose entry window is shorter
  // than the protocol's own minimum. Thirty seconds of driving: `blockTicks`
  // is how long the round IS, and a person looking at two tabs should not
  // have to wait out a full one.
  const committeeTimeMs = BigInt(Date.now());
  const contract = {
    networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
    gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
    committeeTimeMs, randomnessRule: 'bitcoin-block-hash',
    startTimeMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS,
    entryCloseMs: committeeTimeMs + MIN_ENTRY_WINDOW_MS + 120000n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 1800,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
    nodes: [a.round.pubkey, b.round.pubkey],
  };
  const body = encodeRoundContract(contract);
  const opened = [];
  for (const node of [a, b]) {
    const r = await fetch(`http://${host}:${node.port}/round`, { method: 'POST', body });
    if (!r.ok) throw new Error(`${node.port} refused the round: ${await r.text()}`);
    opened.push(toHex(new Uint8Array(await r.arrayBuffer())));
  }
  const id = toHex(roundId(contract));
  if (opened.some((o) => o !== id))
    throw new Error('the two daemons named the round differently: ' + opened.join(' '));

  // `headers=` is not named: the client already forms `<node>/headers` from
  // the nodes, and a URL that repeats what the default already says is a
  // second place to get it wrong.
  const url = `${page}/?round=${id}`
    + `&node=http://${host}:${a.port},http://${host}:${b.port}`
    + `&bond=http://${host}:${a.port}/bond`
    + `&advert=${toHex(signedAdvert)}`;

  return {
    id, url, contract, a, b,
    nodes: [`http://${host}:${a.port}`, `http://${host}:${b.port}`],
    headers: [`http://${host}:${a.port}/headers`, `http://${host}:${b.port}/headers`],
    bond: `http://${host}:${a.port}/bond`,
    advert: toHex(signedAdvert),
    async close() { await a.close(); await b.close(); },
  };
}

/**
 * THE BUILT PAGE, FROM THIS MACHINE, OVER http.
 *
 * The daily is https and these daemons are http on loopback or a tailnet. An
 * https page fetching `http://127.0.0.1` is a mixed-content request and a
 * browser may refuse it - and that refusal looks exactly like a chain provider
 * that never answered, which is the worst kind of wall: it fails where the
 * evidence points somewhere else.
 *
 * So the same build is served here, over the same scheme as the daemons. The
 * page is byte for byte the deployed one; only where it is fetched from
 * changes. The daemons are still a different ORIGIN (a different port), which
 * is why their doors carry access-control-allow-origin.
 *
 * The content types matter: Unity's loader will not start a wasm module served
 * as text/plain, and Cloudflare gets them from `_headers`, which is not a
 * thing a plain server reads.
 */
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.data': 'application/octet-stream',
  '.bundle': 'application/octet-stream', '.symbols': 'application/octet-stream',
};
const typeOf = (file) => {
  if (file.endsWith('.wasm.unityweb')) return 'application/wasm';
  if (file.endsWith('.js.unityweb')) return 'application/javascript';
  if (file.endsWith('.data.unityweb')) return 'application/octet-stream';
  return MIME[extname(file)] || 'application/octet-stream';
};

export function servePage(build, { host = '127.0.0.1', port = 8000 } = {}) {
  return new Promise((ok, no) => {
    const s = createServer((req, res) => {
      let path = decodeURIComponent(req.url.split('?')[0]);
      if (path === '/') path = '/index.html';
      // No climbing out of the build directory, even from a local page.
      const file = join(build, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(build) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404); return res.end('no');
      }
      res.writeHead(200, { 'content-type': typeOf(file) });
      res.end(readFileSync(file));
    });
    s.on('error', no);
    s.listen(port, host, () => ok({ server: s, port: s.address().port }));
  });
}

// Run directly: stand it up on the addresses an operator can reach, and print
// the one line a person opens in two tabs.
if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.BLWP_BIND || '127.0.0.1';
  const build = process.env.BLWP_BUILD
    || new URL('../../../unity-proto/build/webgl', import.meta.url).pathname;

  // THE PAGE IS SERVED FROM HERE unless somebody names another one, because
  // the daily is https and these daemons are not. Same build, same scheme as
  // the nodes, no mixed content to lose the evidence in.
  let page = process.env.BLWP_PAGE;
  let pageServer = null;
  if (!page) {
    if (existsSync(join(build, 'index.html'))) {
      pageServer = await servePage(build, { host, port: Number(process.env.BLWP_PAGE_PORT || 8000) });
      page = `http://${host}:${pageServer.port}`;
    } else {
      page = 'https://btc-logistics-core.pages.dev';
      console.log('NOTE: no build at ' + build + ', so the daily is named instead.');
    }
  }

  const round = await standUpRound({
    host,
    portA: Number(process.env.BLWP_PORT_A || 8080),
    portB: Number(process.env.BLWP_PORT_B || 8081),
    page,
  });
  console.log('round     ' + round.id);
  console.log('daemons   ' + round.nodes.join('  '));
  console.log('headers   ' + round.headers.join('  '));
  console.log('bond      ' + round.bond);
  console.log('page      ' + (pageServer ? 'served here from ' + build : page));
  console.log('');
  console.log('Open this in TWO tabs - each tab is its own player, because the');
  console.log('key is kept in sessionStorage:');
  console.log('');
  console.log(round.url);
  console.log('');

  // MIXED CONTENT IS A REAL WALL AND IS NAMED HERE RATHER THAN DISCOVERED.
  // An https page fetching http://127.0.0.1 is a mixed-content request; a
  // browser may treat loopback as trustworthy and may not, and the failure
  // looks like a chain provider that never answered. Two ways out, both the
  // operator's: serve the built page over http from this machine, or put the
  // daemons behind https on the tailnet.
  if (round.url.startsWith('https://') && round.nodes[0].startsWith('http://')) {
    console.log('NOTE: this is an https page asking for http:// nodes, which a browser');
    console.log('may block as mixed content. Serve the build over http and point at it:');
    console.log('  BLWP_PAGE=http://' + host + ':8000 node ' + process.argv[1].split('/').slice(-3).join('/'));
    console.log('');
  }
  console.log('Ctrl-C stops the daemons.');
}
