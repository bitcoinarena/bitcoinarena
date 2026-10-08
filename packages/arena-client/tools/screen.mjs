// THE BUILT PAGE, A REAL NODE, AND A REAL BROWSER.
//
// Run it with: node tools/screen.mjs  (after a WebGL build). It is a TOOL and
// not a test: it wants a 35 MB player on disk and takes about five minutes,
// because the hold it is waiting to fill is the round's own length. It found
// two faults no suite could - a session that VOIDed on its first tick, and a
// banner drawn across the block clock - which is why it is kept.
//
// PlayMode shows the truck at rest under real physics and EditMode shows the
// wording; neither is a browser, and the jslib and the C# only take effect in
// a WebGL build. This is that check.
import { createServer } from 'node:http';
// FEDERATION since §23.6's ruling (2026-09-22 22:59): the custody field has one value, and a paying round
// names its federation and a publication relay. The page it renders shows the lock panel, the only wallet
// a paying round has now.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { ed25519 } from '@noble/curves/ed25519.js';
import WebSocket from 'ws';

import { openStore } from '../../arena-node/src/store.js';
import { serve } from '../../arena-node/src/server.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { BITCOIN_MAINNET_GENESIS_HEADER, blockHashOf } from '../../arena-protocol/src/chain.js';
import { hash256, parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { bondTransaction, blockOf } from '../../arena-protocol/tools/bond.js';
import { roundId } from '../../arena-protocol/src/contracts.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const OUT = '/tmp/claude-1000/-tmp-btc-phase0/50a57200-8210-47c2-a393-919f0e1ea289/scratchpad/shot';
const BUILD = '/tmp/btc-phase0/unity-proto/build/webgl';
const CHROME = '/home/operator/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const b32 = (n) => new Uint8Array(32).fill(n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the node
const node = await serve(openStore(), { plugins: [NEXTBLOCK], port: 0, funded: () => true });
// SIGNED BY THE NODE IT NAMES. The first run of this harness was refused for
// exactly that - an advertisement signed by a stranger - which is the door
// doing its job: the committee is the round's, and the key that wrote the
// advertisement has to be the key the committee names.
const operator = node.round.identity.secret;
const advert = {
  nodePubkey: node.round.pubkey, operatorId: 'screen', protocolVersions: [1],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify'], endpoint: `ws://127.0.0.1:${node.port}`,
  region: 'eu-west', capacityClass: 2, softwareHash: b32(3),
  settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(4), guardianOf: [], timestamp: 1788700000000n,
};
const signedAdvert = ed25519.sign(advertId(advert), operator);
const transaction = bondTransaction(advert, { signature: signedAdvert });

// A CHAIN THAT REACHES THE ANCHOR. `discover` anchors on Bitcoin's real
// genesis and refuses one the page supplies, so the fixture chain starts at
// the genuine genesis header and the bond is mined into a block on top of it.
const sibling = b32(0x99);
const txid = parseTransaction(transaction).txid;
const { header } = blockOf(hash256, [txid, sibling],
  { previous: blockHashOf(BITCOIN_MAINNET_GENESIS_HEADER) });
const chain = [BITCOIN_MAINNET_GENESIS_HEADER, header];
const headerBytes = new Uint8Array(chain.length * 80);
chain.forEach((h, i) => headerBytes.set(h, i * 80));

// -------------------------------------------------- providers, on two ports
const listen = (handler) => new Promise((r) => {
  const s = createServer(handler);
  s.listen(0, '127.0.0.1', () => r({ server: s, port: s.address().port }));
});
const cors = { 'access-control-allow-origin': '*' };
const headerApi = () => listen((req, res) => {
  res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' });
  res.end(Buffer.from(headerBytes));
});
const a = await headerApi();
const b = await headerApi();          // a second ORIGIN, so two tags, not one
const bondApi = await listen((req, res) => {
  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ hex: toHex(transaction), merkle: [toHex(sibling)], pos: 0 }));
});

// ------------------------------------------------------------ the contract
// A SHORT ROUND, and that is the only thing tuned here: `blockTicks` is how
// long the round IS, the hold is bounded by it, and a 9000-tick round would
// need 150 seconds of outage before the hold filled. 1800 ticks is a
// thirty-second round. No rule is changed - the bound is still the round's
// own length, which is the whole point of it.
const contract = {
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:1'], donationSetId: new Uint8Array(32).fill(0xd0), censusHeight: 900000,
  censusRoot: b32(2), committeeSeed: b32(3), stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: 1800, exposureReference: 1000,
  corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [node.round.pubkey],
};
const rid = roundId(contract);
const hex = (u8) => toHex(u8);
const j = (v) => JSON.stringify(v);

const INJECT = `
<script>
  window.BLWP_CHAIN = {
    headers: [BLWPCLIENT.httpProvider('http://127.0.0.1:${a.port}/'),
              BLWPCLIENT.httpProvider('http://127.0.0.1:${b.port}/')],
    bonds: [(function () {
      // A DECLARED TAG, like the header providers. The door refuses an
      // untagged provider by name - measured on the first run of this
      // harness - because two functions closing over one address are one
      // source however they are listed, and on this path the page writes
      // the functions.
      var get = function () {
        return fetch('http://127.0.0.1:${bondApi.port}/').then(function (r) { return r.json(); })
          .then(function (o) {
            return { transaction: BLWPCLIENT.fromHex(o.hex),
                     branch: o.merkle.map(BLWPCLIENT.fromHex), position: o.pos };
          });
      };
      get.tag = 'http://127.0.0.1:${bondApi.port}';
      return get;
    })()],
  };
  window.BLWP_ADVERT = { signedAdvert: '${hex(signedAdvert)}' };
  window.BLWP_ROUND = ${j({
    ...contract,
    startTimeMs: '1000n', entryCloseMs: '2000n', objectionWindowMs: '600000n',
    stakeMsat: '100000n', bondMinSats: '50000n',
    censusRoot: hex(b32(2)), committeeSeed: hex(b32(3)), gameId: NEXTBLOCK_GAME_ID, simCoreHash: hex(b32(1)),
    nodes: [hex(node.round.pubkey)],
  })};
  BLWP_ROUND.startTimeMs = 1000n; BLWP_ROUND.entryCloseMs = 2000n;
  BLWP_ROUND.objectionWindowMs = 600000n;
  BLWP_ROUND.stakeMsat = 100000n; BLWP_ROUND.bondMinSats = 50000n;
  BLWP_ROUND.simCoreHash = BLWPCLIENT.fromHex(BLWP_ROUND.simCoreHash);
  BLWP_ROUND.censusRoot = BLWPCLIENT.fromHex(BLWP_ROUND.censusRoot);
  BLWP_ROUND.committeeSeed = BLWPCLIENT.fromHex(BLWP_ROUND.committeeSeed);
  BLWP_ROUND.nodes = BLWP_ROUND.nodes.map(BLWPCLIENT.fromHex);
  // HARNESS INSTRUMENTATION, in the page and not in the shipped client:
  // Unity's Module lives inside the loader closure, so the only handle on the
  // session from out here is the page global the jslib calls into. Wrapped,
  // not replaced - the real door runs and its answer is kept.
  // (No backticks in here: this whole block is a template literal, and a
  // backtick closes it. Third time in this repo.)
  (function () {
    var real = BLWPCLIENT.Client.at;
    BLWPCLIENT.Client.at = function () {
      return real.apply(this, arguments).then(function (c) { window.__client = c; return c; });
    };
  })();
  window.BLWP_ENTRY = {
    playerPubkey: BLWPCLIENT.fromHex('${hex(b32(5))}'),
    stakeCommitment: BLWPCLIENT.fromHex('${hex(b32(7))}'),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  };
</script>
`;

// ---------------------------------------------------------- the built page
const MIME = { '.html': 'text/html', '.js': 'application/javascript',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.symbols': 'application/octet-stream' };
const page = await listen((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = join(BUILD, p);
  if (!existsSync(file)) { res.writeHead(404); res.end('no'); return; }
  if (p === '/index.html') {
    let html = readFileSync(file, 'utf8');
    // AFTER the client bundle, because the injected script calls into it.
    html = html.replace('<script src="arena-client.js"></script>',
                        '<script src="arena-client.js"></script>' + INJECT);
    res.writeHead(200, { ...cors, 'content-type': 'text/html' });
    res.end(html);
    return;
  }
  res.writeHead(200, { ...cors, 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

const url = `http://127.0.0.1:${page.port}/?round=${toHex(rid)}`;
console.log('page:', url);
console.log('node:', node.port, 'headers:', a.port, b.port, 'bond:', bondApi.port);

// ------------------------------------------------------------- the browser
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9333', '--no-sandbox',
  '--window-size=1280,800', '--hide-scrollbars',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage', url,
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stderr.on('data', () => {});
await wait(3000);

const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const target = targets.find((t) => t.type === 'page' && t.url.includes('round='));
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
const logs = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled')
    logs.push(m.params.args.map((x) => x.value ?? x.description ?? '').join(' '));
});
const send = (method, params = {}) => new Promise((r) => {
  const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params }));
});
await send('Runtime.enable');
await send('Page.enable');

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
};
const key = (type, code, keyCode, text) => send('Input.dispatchKeyEvent', {
  type, code, key: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  ...(type === 'keyDown' ? { text } : {}),
});

const bye = async (code) => {
  try { ws.close(); } catch {}
  try { chrome.kill('SIGKILL'); } catch {}
  try { await node.close(); } catch {}
  for (const s of [a.server, b.server, bondApi.server, page.server]) try { s.close(); } catch {}
  console.log('--- page console ---');
  for (const l of logs) console.log('   ', l);
  process.exit(code);
};

try {
  // The player is 35 MB and builds a battlefield; give it the time the boot
  // screen itself says it needs rather than a guess.
  for (let i = 0; i < 60; i++) {
    const gone = await evaluate("document.getElementById('boot') ? getComputedStyle(document.getElementById('boot')).display : 'none'");
    if (gone === 'none') break;
    await wait(2000);
  }
  await wait(10000);
  await shot('01-title.png');

  const line = () => evaluate("(function(){var n=Module&&Module.blwpNet;var c=n&&n.client;"
    + "return n?((c?c.status(n.seen):n.state)+' | '+(n.error||'')):'no net';})()");
  const ended = () => evaluate("(function(){var n=Module&&Module.blwpNet;var c=n&&n.client;"
    + "return (c&&c.ended)?(c.ending+' '+c.endingReason):'';})()");

  // PAST THE TITLE AND OUT OF THE BAY, the way a player does it: the splash
  // holds the truck until PLAY, and the bay holds it until freight is aboard.
  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent',
        { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
    await wait(600);
  };
  await click(486, 554);                 // PLAY
  await wait(3000);
  await shot('02-bay.png');

  await click(303, 617);                 // AUTO - fill the bed
  await wait(1200);
  await click(660, 617);                 // and depart
  await wait(2000);

  // F1 opens the diagnostics: Speed, Input and Pos, read off the RIGIDBODY.
  // That is the readout this measurement needs - a truck that has stopped
  // being driven has to be shown not moving while the throttle is down.
  await key('keyDown', 'F1', 112, 'F1');
  await key('keyUp', 'F1', 112, 'F1');
  await wait(500);
  await shot('03-driving-start.png');

  // Alive, and driving: the control measurement, on the page.
  await key('keyDown', 'KeyW', 87, 'w');
  await wait(6000);
  await shot('04-driving.png');
  await key('keyUp', 'KeyW', 87, 'w');
  await wait(2000);
  // WHAT THE NODE ACTUALLY HOLDS, asked of its own store rather than inferred
  // from the absence of an error in a console.
  const held = () => {
    const one = (t) => node.round.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    return `rounds ${one('rounds')} entries ${one('entries')} batches ${one('batches')} `
      + `checkpoints ${one('checkpoints')}`;
  };
  console.log('node holds  :', held());
  const client = () => evaluate("(function(){var c=window.__client;return c?"
    + "(c.state+' held '+c.held+' offered '+c.offered+' next '+c.nextTick"
    + "+' batches '+c.batchesSent+' marks '+c.marksSent+' maxHold '+c.maxHold"
    + "+' tries '+c.tries+(c.ended?(' ENDED '+c.ending):'')):'no client';})()");
  console.log('client      :', await client());


  // THE NODE GOES AWAY. Not the socket - the whole daemon, the way an outage
  // looks to a player. The hold then fills at 60 ticks a second and the round
  // is 1800 ticks long, so it has about thirty seconds.
  // THE NODE GOES AWAY. Not the socket - the whole daemon, the way an outage
  // looks to a player. The core keeps stepping whether or not the truck is
  // moving, so the hold fills at 60 ticks a second on a round 1800 long: about
  // thirty seconds. The truck is left standing for it, because a truck driven
  // into the drop-off would deliver and start a new round instead.
  await node.close();
  console.log('node closed, waiting for the hold to fill');
  // THE HOLD FILLS AT THE RATE THE GAME TICKS, and headless swiftshader draws
  // about eleven frames a second rather than sixty - measured here, 90 held
  // ticks in the first eight seconds. So a 1800-tick round needs some 165
  // seconds of outage, not thirty. Watched rather than assumed.
  let stopped = '';
  for (let i = 0; i < 32 && !stopped; i++) {
    await wait(8000);
    const now = await client();
    console.log(`  +${(i + 1) * 8}s   `, now);
    if (i === 2) await shot('05-outage.png');
    if (/ENDED/.test(now || '')) stopped = now;
  }
  console.log('stopped at  :', stopped || 'NEVER - the hold did not fill');
  await wait(1500);

  await shot('06-stopped.png');

  // AND NOW THE THROTTLE, on a run that has ended. Held down, with a reading
  // of Pos at each end of it.
  await key('keyDown', 'KeyW', 87, 'w');
  await wait(2000);
  await shot('07-throttle-down.png');
  await wait(8000);
  await shot('08-throttle-still-down.png');
  await key('keyUp', 'KeyW', 87, 'w');
  console.log('final       :', await client());
  await bye(0);
} catch (e) {
  console.error('harness failed:', e && e.message);
  await shot('99-failed.png').catch(() => {});
  await bye(1);
}
