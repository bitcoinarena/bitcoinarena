// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S LAST STEPS IN REACT (kanban #564, installer slice 3): Lightning set up and watched until it runs, the gateway started
// and its seat's needs measured from the channels, a channel opened; the bond's deposit named whole, found, locked and posted; the summary
// at the end - against the installer's doors, their classes driven.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LightningStep, BondStep, DoneStep, needText, foundText, fedList, gwText } from '../dist/test/finish.mjs';

function driven(Step, props) {
  const c = new Step(props);
  c.setState = (u, after) => { Object.assign(c.state, typeof u === 'function' ? u(c.state) : u); if (after) after(); };
  return c;
}
const tick = () => new Promise((ok) => setTimeout(ok, 5));

test('lightning: LND set up and watched until it runs; the gateway started, its seat\'s needs from the channels; a channel opened', async () => {
  const posts = []; let lnPolls = 0; let gwPolls = 0;
  const funds = { ok: true, seat: { minInboundSats: 100000, minOutboundSats: 100000, minPegInSats: 50000 }, address: 'tb1qlnd', onchainSats: 260000, unconfirmedSats: 0,
    channels: { open: [{}], pending: [], inboundSats: 150000, outboundSats: 40000 } };
  const answers = {
    '/api/lightning/own': () => ({ ok: true }),
    '/api/lightning/status': () => (++lnPolls < 2 ? { ok: false, waiting: true, why: 'the wallet unlocks' } : { ok: true, version: '0.19.2', network: 'testnet4', pubkey: '03' + 'ab'.repeat(32), blockHeight: 157193, syncedToChain: true, created: true }),
    '/api/gateway/setup': () => ({ ok: true }),
    '/api/gateway/status': () => (++gwPolls < 2 ? { ok: false, waiting: true, why: 'gatewayd starts' } : { ok: true, state: 'Running', lightningPubkey: '03' + 'ab'.repeat(32), network: 'testnet4', blockHeight: 157193, federations: [] }),
    '/api/lightning/funds': () => funds, '/api/lightning/channel': () => ({ ok: true, fundingTxid: 'cd'.repeat(32) }),
  };
  const c = driven(LightningStep, { st: {}, pollMs: 1, post: async (p, b) => { posts.push([p, b]); return answers[p](); }, reload() {} });
  assert.doesNotMatch(renderToStaticMarkup(c.render()), /id="ln-gw"/, 'no gateway before LND runs');
  await c.own();
  for (let i = 0; i < 20 && !c.state.lnOk; i++) await tick();
  assert.equal(c.state.lnMsg.text, `LND 0.19.2 runs on testnet4: node 03ababababababab…, block 157193, synced. Its wallet comes from your 24 words.`);
  // the gateway gets its own page once LND runs (playtest 2026-10-25), opened by "Continue to the gateway"
  let lnHtml = renderToStaticMarkup(c.render());
  assert.match(lnHtml, /id="ln-next">Continue to the gateway</);
  assert.doesNotMatch(lnHtml, /id="ln-gw"/, 'LND\'s page holds no gateway');
  c.setState({ gwPage: true });
  assert.doesNotMatch(renderToStaticMarkup(c.render()), /id="ln-own"/, 'the gateway page holds no LND setup');
  // no way back to LND's page, which only led to the gateway again (kanban #730: "this is confusing")
  assert.doesNotMatch(renderToStaticMarkup(c.render()), /Back to LND/);
  await c.gwSetup();
  for (let i = 0; i < 20 && !c.state.funds; i++) await tick();
  assert.equal(c.state.gwMsg.text, 'The gateway runs (Running) on LND 03ababababababab…, testnet4, block 157193. No federation joined yet.');
  let html = renderToStaticMarkup(c.render());
  assert.match(html, /id="need-in"><span class="ok">✓<\/span>[\s\S]*?<i style="width:100%"><\/i><\/span><span class="num">150,000 \/ <b>100,000<\/b> sat/);
  assert.match(html, /id="need-out"><span class="ok">○<\/span>[\s\S]*?<i style="width:40%"><\/i>/);
  assert.match(html, /1 open, 0 opening; inbound 150,000 sat, outbound 40,000 sat \(a gateway seat needs 100,000 each way\)/);
  assert.match(html, /<button type="button">Continue<\/button>/);
  c.setState({ peer: '02aa@h:9735', sats: '120000' });
  await c.openChannel();
  assert.deepEqual(posts.find(([p]) => p === '/api/lightning/channel'), ['/api/lightning/channel', { peer: '02aa@h:9735', sats: 120000 }]);
  assert.match(c.state.gwMsg.text, /^Channel opening: cdcd/);
  c.componentWillUnmount();
  assert.equal(fedList([{ name: 'T' }, { federationId: 'e8741283f199' + '0'.repeat(52) }]), ' Federations: T, e8741283f199.');
});

test('lightning: LND\'s and the gateway\'s progress - the bar, the stages with their hints, the log once slow (kanban #661)', async () => {
  const stages = (now) => ['download', 'reach', 'start', 'wallet', 'answer'].map((id, i) => ({ id, label: `L-${id}`, state: i < now ? 'done' : i === now ? 'now' : 'todo', ms: i === now ? 70000 : 1000 }));
  let prog = { ok: true, lnd: { ok: true, running: true, elapsedMs: 75000, stages: stages(4), log: ['lnd: waiting for the wallet'] }, gateway: { ok: true, running: false, stages: [] } };
  const gets = [];
  const c = driven(LightningStep, { st: {}, pollMs: 1, get: async (p) => { gets.push(p); return prog; }, post: async () => ({ ok: false, waiting: true, why: 'starting' }), reload() {} });
  await c.componentDidMount();
  assert.deepEqual(gets, ['/api/lightning/progress']);
  assert.ok(c.progTimer, 'a running start is followed every second');
  let html = renderToStaticMarkup(c.render());
  assert.match(html, /id="ln-progress"[\s\S]*role="progressbar"[\s\S]*aria-valuenow="9\d"/);
  assert.match(html, /L-answer<\/b> · 70 s<p class="sub">LND answers once it has connected to your Bitcoin Core/);
  assert.match(html, /LND takes longer than usual[\s\S]*LND&#x27;s last messages:[\s\S]*lnd: waiting for the wallet/);
  assert.doesNotMatch(html, /id="gw-progress"/, 'no gateway bar before the gateway starts');
  prog = { ...prog, lnd: { ...prog.lnd, running: false, log: [] } };
  await c.progress();
  assert.equal(c.progTimer, null, 'done: no more polling');
  c.componentWillUnmount();
});

test('lightning: an LND of your own connected by REST, macaroon and certificate; later moves on', async () => {
  const posts = []; let reloaded = 0;
  const c = driven(LightningStep, { st: {}, post: async (p, b) => { posts.push([p, b]); return p === '/api/lightning/connect' ? { ok: true, alias: 'mine', pubkey: '02' + 'cd'.repeat(32), blockHeight: 157193 } : { ok: true }; }, reload: () => { reloaded++; } });
  c.setState({ conn: true, url: 'https://127.0.0.1:8080', mac: '0201', cert: '-----BEGIN CERTIFICATE-----' });
  assert.match(renderToStaticMarkup(c.render()), /id="ln-url"[\s\S]*id="ln-mac"[\s\S]*id="ln-cert"/);
  await c.connect();
  assert.deepEqual(posts[0], ['/api/lightning/connect', { restUrl: 'https://127.0.0.1:8080', macaroonHex: '0201', tlsCertPem: '-----BEGIN CERTIFICATE-----' }]);
  assert.equal(c.state.lnMsg.text, 'Connected: mine 02cdcdcdcdcdcdcd…, block 157193.');
  const l = driven(LightningStep, { st: {}, post: async () => ({ ok: true }), reload: () => { reloaded++; } });
  await l.later();
  assert.equal(reloaded, 1);
});

test('bond: the deposit named whole with its parts, nothing then enough found, the lock said, posted', async () => {
  assert.equal(needText(363000, { bond: 50000, fees: 2000, advertUpdate: 5000, pegIn: 50000, outside: 103000, ring: 153000 }),
    '363,000 (bond 50,000, fees 2,000, advertisement update 5,000, peg-in 50,000, outside channel 103,000, ring channel 153,000)');
  assert.equal(needText(52000, { bond: 50000, fees: 2000 }), '52,000', 'a plain node: just the total');
  const st = { roles: ['custody'], wallet: { address: 'tb1pnode', needSats: 363000, parts: { bond: 50000, fees: 2000, advertUpdate: 5000, pegIn: 50000, outside: 103000, ring: 153000 } } };
  const lock = { maturity: 157483, blocks: 289, estimatedMs: Date.UTC(2026, 9, 23, 8) };
  let asked = 0; const posts = []; let reloaded = 0;
  const c = driven(BondStep, { st, reload: () => { reloaded++; }, post: async (p, b) => {
    posts.push([p, b]);
    if (p === '/api/bond/post') return { ok: true };
    return ++asked < 2 ? { ok: true, coins: [], totalSats: 0, needSats: 363000, enough: false, lock }
      : { ok: true, coins: [{ height: 157192 }], totalSats: 366000, needSats: 363000, enough: true, lock, minimum: { sats: 250000 } };
  } });
  let html = renderToStaticMarkup(c.render());
  // the total in one line, its parts as tiles below (playtest 2026-10-25: "Less wall of text and clearer and more colorful")
  assert.match(html, /Send at least <b>363,000 sat<\/b>/); assert.match(html, /<code>tb1pnode<\/code>/);
  assert.match(html, /class="cover c-bond"><span class="amt">50,000 sat<\/span><span class="what">bond<\/span>[\s\S]*class="cover c-ring"><span class="amt">153,000 sat/);
  assert.match(html, /id="b-pegin" value="50000"/); assert.match(html, /<button type="button" id="b-post" disabled="">Post the bond<\/button>/);
  await c.check();
  assert.deepEqual(posts[0], ['/api/bond/check', { pegInSats: 50000 }]);
  assert.match(c.state.msg.text, /^Nothing has arrived yet\./);
  await c.check();
  assert.equal(c.state.msg.text, 'Found 366,000 sat in 1 deposit(s) (confirmed at 157192). Monitor confirmations on your dashboard. The network asks new nodes for a bond of at least 250,000 sat right now (its federations are filling up), so your node is useful from the start.');
  html = renderToStaticMarkup(c.render());
  assert.match(html, /The bond will be locked until block 157483 - 289 blocks from now/);
  assert.match(html, /<button type="button" id="b-post">Post the bond<\/button>/);
  await c.postBond();
  assert.equal(posts.at(-1)[0], '/api/bond/post'); assert.equal(reloaded, 1);
  const plain = driven(BondStep, { st: { roles: ['verify'], wallet: { address: 'x', needSats: 52000 } }, post: async (p, b) => { posts.push([p, b]); return { ok: true, coins: [], enough: false }; }, reload() {} });
  await plain.check();
  assert.deepEqual(posts.at(-1), ['/api/bond/check', {}], 'no peg-in asked of a node without custody');
  assert.equal(foundText({ coins: [{}], totalSats: 10000, needSats: 52000, enough: false }), 'Found 10,000 sat in 1 deposit(s) (sent, not confirmed yet). Needed: 52,000 sat in all (fees included).');
});

test('done: a headline, the dashboard and Finish, one card per part with links in a new window, the command line folded; Finish opens the dashboard', async () => {
  const st = { seatPort: 9090, reach: { mode: 'permanent', url: 'https://node.example.com' }, service: { boot: true, identity: 'ab'.repeat(32), linger: false },
    launchers: { start: '/home/u/.local/share/arena/bin/arena-start', command: { name: 'arena' } }, owner: { mode: 'seed' },
    lightning: { mode: 'own', pubkey: '03' + 'ab'.repeat(32) }, gateway: { testedMs: 1, publicUrl: 'https://node.example.com/gateway/', federations: [{ name: 'T' }] },
    bond: { txid: 'ef'.repeat(32), sats: 250000, maturity: 157483, lock: { estimatedMs: Date.UTC(2026, 9, 23, 8) } } };
  const tab = { location: { href: '' }, postMessage() {} }; const opened = [];
  const c = driven(DoneStep, { st, post: async () => ({ ok: true, owner: 'https://node.example.com/dashboard/owner' }), get: async () => ({ ok: true, kind: 'seed', seed: 'ab'.repeat(32) }), reload() {},
    open: (u) => { opened.push(u); return tab; } });
  const html = renderToStaticMarkup(c.render());
  assert.match(html, /<h2>Your node runs<\/h2>[\s\S]*It starts again by itself after a reboot/);
  assert.match(html, /<button type="button" id="finish">Open Node Dashboard<\/button>/, 'one button: it ends setup and opens the dashboard');
  assert.match(html, /id="done-address"[\s\S]*<a href="https:\/\/node\.example\.com" target="_blank" rel="noopener noreferrer">https:\/\/node\.example\.com<\/a>[\s\S]*Your Cloudflare tunnel/);
  assert.match(html, /id="done-owner"[\s\S]*href="https:\/\/testnet\.bitcoin-arena\.io\/owner\/#node=abababababababababababababababababababababababababababababababab" target="_blank"[\s\S]*Log in with your 24 words/);
  assert.match(html, /id="done-bond"[\s\S]*250,000 sat[\s\S]*Locked until block 157,483/);
  assert.match(html, /id="done-lightning"[\s\S]*Gateway runs, serving T\./);
  assert.match(html, /<details class="done-more"><summary>Start, stop and the command line<\/summary>[\s\S]*<code>arena status<\/code>/);
  assert.match(html, /sudo loginctl enable-linger/);
  await c.finish();
  assert.deepEqual([opened, tab.location.href], [['about:blank'], 'https://testnet.bitcoin-arena.io/owner/#node=abababababababababababababababababababababababababababababababab&owner-handoff'], 'the tab opened at the click, then the owner page on the Arena site (an address that never changes, the login kept per node key) that takes the owner key');
  assert.match(renderToStaticMarkup(c.render()), /<a class="btn" id="open-dashboard" href="https:\/\/testnet\.bitcoin-arena\.io\/owner\/#node=abababababababababababababababababababababababababababababababab" target="_blank"[^>]*>Open Node Dashboard<\/a>/, 'afterwards a link to it');
  const none = renderToStaticMarkup(React.createElement(DoneStep, { st: { seatPort: 9090, reach: { mode: 'quick' }, service: {}, wallet: { address: 'tb1pnode' } }, post: async () => ({}) }));
  assert.match(none, /the name changes when it restarts/); assert.match(none, /No bond yet\. Send it to <code>tb1pnode<\/code>/);
  assert.match(none, /href="http:\/\/127\.0\.0\.1:9090\/dashboard\/owner"[\s\S]*This computer only/);
});

// KANBAN #635 (2026-10-25): testcoins from the Arena faucet or the guided way; the gateway set up while Bitcoin Core still syncs;
// the Done page names Bitcoin Arena and sends the owner to the dashboard for the confirmations
test('#635: the faucet asked and the deposit checked; a refusal opens the guided way; a syncing gateway counts; the dashboard named', async () => {
  const posts = [];
  let faucet = { ok: true, txid: 'ab'.repeat(32), sats: 52000 };
  const c = driven(BondStep, { st: { roles: ['verify'], wallet: { address: 'tb1pnode', needSats: 52000 } }, post: async (p, b) => {
    posts.push([p, b]);
    if (p === '/api/coins/auto') return faucet;
    return { ok: true, coins: [{ height: 0 }], totalSats: 52000, needSats: 52000, enough: true };
  } });
  let html = renderToStaticMarkup(c.render());
  assert.match(html, /Get test coins automatically[\s\S]*id="coins-auto"/); assert.doesNotMatch(html, /coinfaucet/, 'the guided way folded');
  await c.autoCoins();
  assert.deepEqual(posts.map(([p]) => p), ['/api/coins/auto', '/api/bond/check']);
  assert.match(c.state.msg.text, /\(sent, not confirmed yet\)\. Monitor confirmations on your dashboard\.$/);
  faucet = { ok: false, why: 'this address got coins from the faucet already', guided: true };
  await c.autoCoins();
  assert.equal(c.state.coins, 'guided');
  html = renderToStaticMarkup(c.render());
  assert.match(html, /mempool\.space\/testnet4\/faucet[\s\S]*coinfaucet\.eu/); assert.match(html, /<code>tb1pnode<\/code>/);
  assert.equal(gwText({ ok: true, syncing: true }), 'The gateway runs. It connects to Lightning by itself once Bitcoin Core has synced; your dashboard shows when.');
  const done = renderToStaticMarkup(driven(DoneStep, { st: { reach: { mode: 'direct', url: 'https://n.example', port: 9090 }, service: { boot: true }, seatPort: 9090, coreSync: { interim: true },
    launchers: { app: '/Applications/Bitcoin Arena.app', start: '/h/bin/Bitcoin Arena Start.command' } } }).render());
  assert.match(done, /id="done-core"[\s\S]*Still syncing/); assert.match(done, /id="finish">Open Node Dashboard</);
  assert.match(done, /Open <b>Bitcoin Arena<\/b> in your Applications/);
});

// kanban #813, the owner: "there should be some indication that the balance check is being performed"
test('bond: a running check shows, the automatic one too, and says when it last looked', async () => {
  let answer; const c = driven(BondStep, { st: { roles: ['verify'], wallet: { address: 'tb1pnode', needSats: 52000 } }, post: () => new Promise((ok) => { answer = ok; }) });
  const shown = () => renderToStaticMarkup(c.render());
  assert.doesNotMatch(shown(), /Checking/);
  const run = c.check({ quiet: true });
  assert.match(shown(), /Checking your node(&#x27;|')s wallet for the deposit/);
  assert.match(shown(), /Checking…<\/button>/);
  answer({ ok: true });
  await run;
  assert.doesNotMatch(shown(), /Checking/);
  assert.match(shown(), /Last checked .*Setup checks again by itself/);
  const second = c.check();
  answer({ ok: true, found: true, enough: true, totalSats: 60000, coins: [{ height: 158300 }] });
  await second;
  assert.doesNotMatch(shown(), /Checking|Last checked/);
});
