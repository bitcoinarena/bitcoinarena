// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SETUP CARD ON BOTH DASHBOARDS (kanban #635; 2026-10-25: "lnd status and everything else that may be in progress"): a row for
// each part under way, a problem marked and counted in the heading, "complete" when all are done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupStatus, SetupCard, SetupBanner, SETUP_OPEN_SECTIONS, PegInCard, FoundingWait, NoBondCard, noBond } from '../dist/test/setup-status.mjs';

const card = (status) => renderToStaticMarkup(React.createElement(SetupStatus, { status: { ok: true, ...status } }));

test('every part under way, in words; a problem counted in the heading', () => {
  const html = card({ tip: 157559,
    address: { ok: false, url: 'https://n.example', why: 'ENOTFOUND' },
    faucet: { txid: 'fa'.repeat(32), sats: 52000, seen: true, confirmations: 2 },
    bond: { txid: 'b0'.repeat(32), sats: '50000', seen: true, confirmations: 0, confirmBy: 157700 },
    lnd: { ok: true, synced: true, height: 157559, channels: 1, pending: 1 },
    gateway: { ok: false, syncing: true, why: 'syncing' },
    updates: [{ what: 'the newest games and protocols in the advertisement', txid: '9a'.repeat(32), seen: true, confirmations: 3, needed: 6, counts: false }],
    oldBonds: [{ sats: '50000', maturity: 157600, blocksLeft: 41, back: false }] });
  assert.match(html, /<h3>Setup<\/h3><span class="setup-pill bad">1 problem<\/span>/);
  assert.match(html, /class="setup-step s-bad" id="setup-address"><span class="setup-ic" aria-hidden="true">!<\/span>[\s\S]*https:\/\/n\.example does not answer as your node \(ENOTFOUND\)/);
  assert.match(html, /Test coins<\/b><span class="setup-text">52,000 sat arrived, 2 confirmations/);
  assert.match(html, /LND<\/b><span class="setup-text">synced at block 157,559, 1 open channel, 1 opening/);
  assert.match(html, /Gateway<\/b><span class="setup-text">waiting for LND to sync/);
  assert.match(html, /the newest games and protocols in the advertisement: 3 of 6 confirmations, in force at 6/);
  assert.match(html, /50,000 sat under your old key, locked for 41 more blocks \(until block 157,600\)/);
});

test('all done: complete; nothing to show: nothing', () => {
  const html = card({ address: { ok: true, url: 'https://n.example' }, lnd: { ok: true, synced: true, height: 1, channels: 2, pending: 0 }, gateway: { ok: true, federations: 1 } });
  assert.match(html, /<h3>Setup<\/h3><span class="setup-pill ok">Complete<\/span>/);
  assert.equal(card({}), '');
});

// "DON'T SHOW AGAIN" ON A COMPLETE SETUP (2026-10-26: "Setup needs a Don't show again link if it's complete so it's hidden on the device
// (stored in browser)"): per node in this browser; a setup not complete shows anyway
test('a complete setup: a Don\'t show again link, hidden per node once clicked; one not complete shows anyway', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  try {
    const done = { ok: true, node: 'ab'.repeat(32), address: { ok: true, url: 'https://n.example' }, lnd: { ok: true, synced: true, height: 1, channels: 2, pending: 0 }, gateway: { ok: true, federations: 1 } };
    assert.match(renderToStaticMarkup(React.createElement(SetupStatus, { status: done })), /<button type="button" class="setup-hide">Don&#x27;t show again<\/button>/);
    const c = new SetupStatus({ status: done }); c.setState = (u) => Object.assign(c.state, u);
    c.hide();
    assert.equal(store.get(`arena-setup-hidden:${'ab'.repeat(32)}`), '1');
    assert.match(renderToStaticMarkup(React.createElement(SetupStatus, { status: done })), /Show setup/, 'hidden for that node, and it can come back');
    assert.notEqual(renderToStaticMarkup(React.createElement(SetupStatus, { status: { ...done, node: 'cd'.repeat(32) } })), '', 'another node: shown');
    const open = { ...done, address: { ok: false, url: 'https://n.example', why: 'ENOTFOUND' } };
    assert.match(renderToStaticMarkup(React.createElement(SetupStatus, { status: open })), /1 problem/, 'not complete: shown though hidden');
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(SetupStatus, { status: open })), /Don&#x27;t show again/);
  } finally { delete globalThis.localStorage; }
});

// THE PEG-IN, PROMINENT (2026-10-26: "It needs to show the status of the peg in prominently if we have a peg in") and HOW MANY NODES ARE
// READY FOR THE FOUNDING ("display here how many other nodes are waiting in the format e.g 3/10 ... in big letters")
// NO BOND (kanban #728, 2026-10-27: "Wenn kein Bond da ist, muss das deutlich sichtbar sein im Dashboard und Owner-Dashboard, und auch keine
// Federation-Info"): the installer's "I'll post it later" - a red card with the way to set it up, and no founding anywhere
test('no bond: a red card with "Set up the bond", no founding count, the gateway not waiting on a federation', () => {
  const none = { ok: true, bond: null, gateway: { ok: true, federations: 0 }, founding: { waiting: true, ready: 3, needed: 10 } };
  assert.deepEqual([noBond(none), noBond({ ok: true, bond: { txid: 'b0'.repeat(32) } }), noBond({ ok: false }), noBond(null)], [true, false, false, false]);
  const red = renderToStaticMarkup(React.createElement(NoBondCard, { status: none, href: '#bond' }));
  assert.match(red, /<h3>No bond<\/h3><span class="setup-pill bad">Not drawn for rounds<\/span>/);
  assert.match(red, /<a class="btn primary" id="no-bond-go" href="#bond">Set up the bond<\/a>/);
  assert.equal(renderToStaticMarkup(React.createElement(NoBondCard, { status: { ...none, bond: { txid: 'b0'.repeat(32), sats: '50000' } }, href: '#bond' })), '', 'a bond: no card');
  assert.equal(renderToStaticMarkup(React.createElement(FoundingWait, { status: none })), '', 'no bond: no founding, no 3/10');
  const html = card(none);
  assert.doesNotMatch(html, /federation is founded|3\/10|founding/i);
  assert.match(html, /id="setup-gateway"[\s\S]*?joins a federation once your node has a bond/);
  assert.match(html, /setup-pill ok">Complete/, 'a missing bond does not hold the setup screen');
  // the owner's Overview: the card first, linking to the Bond section; no Federation card
  const ov = renderToStaticMarkup(new SetupCard({ initial: none }).render());
  assert.match(ov, /^<div class="card no-bond" id="no-bond"[\s\S]*href="#bond">Set up the bond/);
  assert.doesNotMatch(ov, /founding-wait|nodes ready for the next federation/);
});

test('the peg-in as N/100 confirmations, credited at the end; the founding as 3/10 ready nodes', () => {
  const peg = (p) => renderToStaticMarkup(React.createElement(PegInCard, { status: { ok: true, blockMs: 600000, pegIn: p } }));
  assert.equal(peg(null), '');
  const going = peg({ txid: 'e6'.repeat(32), sats: 100000, height: 157600, confirmations: 37, seen: true, needed: 100, credited: false });
  assert.match(going, /<span class="setup-pill wait">Confirming<\/span>[\s\S]*<span class="founding-n">37\/100<\/span><span class="founding-l">confirmations · 100,000 sat into the federation for your gateway<\/span>/);
  assert.match(going, /About 11 h to go/);
  assert.match(peg({ txid: 'e6'.repeat(32), confirmations: 0, seen: false, needed: 100 }), /Waiting to be mined/);
  assert.match(peg({ txid: 'e6'.repeat(32), confirmations: 120, seen: true, needed: 100, credited: true }), /setup-pill ok">Credited[\s\S]*founding-n ok">100\/100/);
  const wait = (f) => renderToStaticMarkup(React.createElement(FoundingWait, { status: { ok: true, bond: { txid: 'b0'.repeat(32), sats: 50000 }, founding: { waiting: true, sinceMs: Date.UTC(2026, 9, 25, 15, 31), ...f } } }));
  assert.match(wait({ ready: 3, needed: 10 }), /<span class="founding-n">3\/10<\/span><span class="founding-l">nodes ready for the next federation<\/span>/);
  assert.doesNotMatch(wait({}), /founding-n/, 'no count read: none shown');
});

test('LND: reached directly, over Tor, or not at all (a problem)', () => {
  const lnd = (via) => card({ lnd: { ok: true, synced: true, height: 5, channels: 1, pending: 0, via } });
  assert.match(lnd({ how: 'direct', at: '203.0.113.5:9735' }), /reached directly at 203\.0\.113\.5:9735/);
  assert.match(lnd({ how: 'tor', at: 'abc.onion:9735' }), /reached over Tor \(no open port needed\)/);
  assert.match(lnd({ how: 'none', why: 'no Tor: the release has none' }), /<span class="setup-pill bad">1 problem[\s\S]*other nodes cannot reach it \(no Tor: the release has none\)/);
});

test('the owner\'s Overview reads the setup\'s progress itself and again later (playtest 2026-10-25: "auch in der owners area")', async () => {
  const asked = [];
  const c = new SetupCard({ api: { get: async (p) => { asked.push(p); return { ok: true, core: null, address: { ok: true, url: 'https://n.example' } }; } }, everyMs: 60000 });
  c.setState = (u) => Object.assign(c.state, u);
  await c.componentDidMount();
  assert.deepEqual(asked, ['/setup-status']);
  assert.ok(c.timer, 'read again later');
  assert.match(renderToStaticMarkup(c.render()), /id="setup-status"/);
  c.componentWillUnmount();
});

test('the owner area waits behind the setup screen while a part runs; it opens once all is done (playtest 2026-10-25)', () => {
  const gate = (status) => renderToStaticMarkup(React.createElement(SetupBanner, { status: status && { ok: true, ...status } }));
  const h = gate({ core: { interim: true, sync: { blocks: 50070, headers: 157581, progress: 0.059, etaMs: 1920000 } }, address: { ok: true, url: 'https://n.example' } });
  assert.match(h, /id="setup-gate" role="dialog"[\s\S]*Your node is still being set up[\s\S]*Check back when everything below is synced\.<\/p>[\s\S]*id="setup-status"[\s\S]*Bitcoin Core/);
  assert.equal(gate({ core: { interim: false }, address: { ok: true, url: 'https://n.example' } }), '', 'all done: the owner area opens');
  assert.equal(gate(null), '', 'no answer: the owner area as before');
  // an update on its way locks nothing (2026-10-26: "When it is just doing an update because a transaction was sent, no need to lock the
  // entire screen")
  assert.equal(gate({ core: { interim: false }, address: { ok: true, url: 'https://n.example' },
    updates: [{ what: 'the roles change', txid: 'a1'.repeat(32), seen: true, confirmations: 0, needed: 6, counts: false }] }), '', 'only an update: the owner area stays open');
  assert.doesNotMatch(h, /setup-gate-enter/, 'nothing to fix: no way in');
  // a part the owner fixes here: a way in, to the sections that help only ("those things are fine if we need the owners page")
  const status = { ok: true, core: { interim: true, sync: { blocks: 1, headers: 2, progress: 0.5 } }, address: { ok: false, url: 'https://n.example', why: 'no answer' } };
  const g = new SetupBanner({ status });
  g.setState = (u) => Object.assign(g.state, u);
  assert.match(renderToStaticMarkup(g.render()), /Public address has a problem you can fix in the owner area\.[\s\S]*id="setup-gate-enter"/);
  g.setState({ entered: true });
  assert.match(renderToStaticMarkup(g.render()), /id="setup-banner"[\s\S]*Setup is still running\.[\s\S]*you can only use Overview, Services, Updates, Emergency code and Your login/);
  assert.deepEqual([...SETUP_OPEN_SECTIONS], ['overview', 'services', 'release', 'emergency', 'login']);
});

test('the coins the bond was made from count once the bond is on the chain; the card says how far the setup is (playtest 2026-10-25)', () => {
  const html = card({ faucet: { seen: false, sats: 363000, txid: 'c6aeaba4bb3c' + '0'.repeat(52) }, bond: { seen: true, sats: 50000, confirmations: 19, counts: true, blocksToMaturity: 266, confirmBy: 157700 },
    core: { interim: false }, address: { ok: true, url: 'https://n.example' } });
  assert.match(html, /id="setup-faucet"[\s\S]*363,000 sat arrived; your bond was made from them/);
  assert.match(html, /<span class="setup-pill ok">Complete<\/span>/, 'all four parts done');
  const part = card({ core: { interim: true, sync: { blocks: 1, headers: 2, progress: 0.5 } }, address: { ok: true, url: 'https://n.example' } });
  assert.match(part, /<span class="setup-pill wait">1 of 2 done<\/span><\/div><div class="setup-total" role="progressbar" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1"><i style="width:50%"><\/i>/);
});

// HOW LONG IT STILL TAKES (the owner's playtest 2026-10-25: "We need one big number on top until the node is ready, and for each item
// individual etas"): the big number is the slowest part's; each part still under way says its own time; a done part none
test('one big number until the node is ready, and each part\'s own time', async () => {
  const { dur } = await import('../dist/test/setup-status.mjs');
  const min = 60000;
  const html = card({ tip: 157605, blockMs: 8 * min, blockMsMeasured: true,
    core: { interim: true, sync: { blocks: 148944, headers: 157605, progress: 0.945, etaMs: 10 * min } },
    address: { ok: true, url: 'https://n.example' },
    lnd: { ok: true, synced: false, height: 149091 }, gateway: { ok: false, syncing: true },
    etas: { core: 10 * min, lnd: 12 * min, gateway: 12 * min + 800 * min, address: 0, updates: [], ready: 812 * min, partial: false } });
  assert.match(html, /<div class="setup-ready" id="setup-ready"><span class="setup-ready-n">14 h<\/span><span class="setup-ready-l">until your node is ready<\/span><\/div>/);
  assert.match(html, /id="setup-core">[\s\S]*?<span class="setup-eta">10 min<\/span><\/div>/);
  assert.match(html, /id="setup-lnd">[\s\S]*?<span class="setup-eta">12 min<\/span><\/div>/);
  assert.match(html, /id="setup-gateway">[\s\S]*?<span class="setup-eta">14 h<\/span><\/div>/);
  assert.doesNotMatch(html.split('id="setup-address"')[1].split('id="setup-')[0], /setup-eta/, 'a part that is done shows no time');
  assert.doesNotMatch(html, /min left/, 'Core\'s time is in its corner, not in its line as well');
  assert.match(html, /Chain tip · block 157,605 · lately a block every 8 min/);
  assert.match(card({ lnd: { ok: false, why: 'x' }, etas: { lnd: null, ready: 30 * min, partial: true } }), /<span class="setup-ready-n">at least 30 min<\/span>/);
  assert.doesNotMatch(card({ address: { ok: true, url: 'u' }, etas: { address: 0, ready: 0 } }), /setup-ready/, 'all done: no number');
  // the bond counts at 6 confirmations: said, with a bar, and its time is the blocks still needed
  const bond = card({ bond: { txid: 'b0'.repeat(32), sats: '50000', seen: true, confirmations: 2, needed: 6, confirmBy: 157726 }, etas: { bond: 32 * min, ready: 32 * min } });
  assert.match(bond, /Bond<\/b><span class="setup-text">50,000 sat, 2 of 6 confirmations\. It counts at 6\.<\/span><div class="bar"><i style="width:33%"><\/i><\/div><\/div><span class="setup-eta">32 min<\/span>/);
  assert.match(card({ bond: { txid: 'b0'.repeat(32), sats: '50000', seen: true, confirmations: 0, needed: 6, confirmBy: 157726 } }), /0 of 6 confirmations\. It counts at 6 and must first confirm by block 157,726\./);
  // the release on the setup screen too (kanban #674)
  const gate = renderToStaticMarkup(React.createElement(SetupBanner, { status: { ok: true, release: { version: '2026.1.9.3' }, core: { interim: true, sync: null } } }));
  assert.match(gate, /Your node is still being set up<span class="ver" id="setup-gate-ver">2026\.1\.9\.3<\/span><\/h2>/);
  assert.deepEqual([dur(20000), dur(12 * min), dur(200 * min), dur(812 * min), dur(4 * 1440 * min)], ['under a minute', '12 min', '3 h 20 min', '14 h', '4 days']);
});

// LIGHTNING LEFT FOR LATER (kanban #711, the 2026.1.9.11 install test: "Complete" on a custody node with no LND and no gateway): each a tile
// "left for later" with the way to set it up, the heading says so, and the owner area is not closed for it
test('Lightning left for later: not complete, its tiles say how to set it up, and the owner area stays open', () => {
  const later = { lnd: true, gateway: true, fix: true, why: 'Not set up: Lightning was left for later in setup, so the gateway was never started.' };
  const html = card({ address: { ok: true, url: 'https://n.example' }, later });
  assert.match(html, /<span class="setup-pill wait">Lightning left for later<\/span>/);
  assert.doesNotMatch(html, /Complete/);
  assert.match(html, /class="setup-step s-later" id="setup-lnd"><span class="setup-ic" aria-hidden="true">–<\/span><div class="setup-body"><b>LND<\/b><span class="setup-text">Left for later\. Set it up in the owner area: Services, Lightning gateway, Set up the gateway\./);
  assert.match(html, /id="setup-gateway"[\s\S]*Left for later: custody needs it to serve deposits\./);
  assert.equal(renderToStaticMarkup(React.createElement(SetupBanner, { status: { ok: true, address: { ok: true, url: 'https://n.example' }, later } })), '', 'no setup screen over the owner area for it');
  const electrum = card({ address: { ok: true, url: 'https://n.example' }, later: { lnd: true, gateway: true, fix: false, why: 'Not set up: the gateway needs Lightning, and Lightning needs your own Bitcoin Core (this node reads an Electrum server).' } });
  assert.match(electrum, /Left for later\. Not set up: the gateway needs Lightning, and Lightning needs your own Bitcoin Core/);
  assert.match(card({ address: { ok: true, url: 'https://n.example' }, lnd: { ok: true, synced: true, height: 1, channels: 1, pending: 0 }, later: { lnd: false, gateway: true, fix: true, why: 'x' } }),
    /id="setup-lnd"[\s\S]*synced at block 1[\s\S]*id="setup-gateway"[\s\S]*Left for later/);
});

// A BOND ON ITS WAY NEVER CLOSES THE OWNER AREA (kanban #728, the 2026.1.9.11 install test: posted from the Bond section, it shut the
// whole area - the Bond section among it - behind "still being set up" until its 6 confirmations)
test('a bond posted and confirming does not put the setup screen over the owner area', () => {
  const bond = { txid: 'b0'.repeat(32), sats: '50000', seen: true, confirmations: 1, confirmBy: 157790 };
  assert.equal(renderToStaticMarkup(React.createElement(SetupBanner, { status: { ok: true, address: { ok: true, url: 'https://n.example' }, bond } })), '');
});
