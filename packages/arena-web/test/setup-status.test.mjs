// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SETUP CARD ON BOTH DASHBOARDS (kanban #635; 2026-10-25: "lnd status and everything else that may be in progress"): a row for
// each part under way, a problem marked and counted in the heading, "complete" when all are done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupStatus, SetupCard, SetupBanner, SETUP_OPEN_SECTIONS } from '../dist/test/setup-status.mjs';

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
  assert.deepEqual([dur(20000), dur(12 * min), dur(200 * min), dur(812 * min), dur(4 * 1440 * min)], ['under a minute', '12 min', '3 h 20 min', '14 h', '4 days']);
});
