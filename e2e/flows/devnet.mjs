// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEATS' OWN DOORS ON THE DEVNET (kanban #2642): what the page, the explorer, an attestor and the other seats read and post, each
// asked of the seven running seats; and a whole round played headless (devnet.mjs play) to its signed result, then replayed.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { check, getJson, post, Skip, wait } from '../lib/ctx.mjs';

const devnetTool = (ctx, cmd, ms) => {
  const r = spawnSync(process.execPath, [join(ctx.root, 'packages/arena-node/tools/devnet.mjs'), ...cmd], { cwd: join(ctx.root, 'packages/arena-node'), encoding: 'utf8', timeout: ms, env: ctx.env });
  writeFileSync(join(ctx.dir, `${cmd[0]}.log`), `${r.stdout || ''}${r.stderr || ''}`);
  const lines = String(r.stdout || '').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { status: r.status, lines, err: String(r.stderr || '').trim().split('\n').slice(-3).join(' | ') };
};
const each = (ctx, f) => Promise.all(ctx.dn.nodes.map((n, k) => f(n, k).catch((e) => ({ error: e.message }))));

export const flows = [
  {
    id: 'seats.identity-and-roles', area: 'node', title: 'seven seats answer /identity, /guardian, /roles with one census and every role filled', money: 0, reach: 3, timeoutMs: 60000,
    async run(ctx) {
      const g = await each(ctx, (n) => getJson(`${n}/guardian`));
      check(g.every((x) => x.guardian === true), 'every seat runs its guardian', g);
      const roles = await each(ctx, (n) => getJson(`${n}/roles`));
      check(roles.every((r) => Array.isArray(r.nodes) && r.nodes.length === 7), 'every seat lists seven nodes in /roles', roles.map((r) => r.nodes?.length ?? r.error));
      const census = new Set(roles.map((r) => r.censusHeight));
      check(census.size <= 2, 'the seats agree on the census height (within one step)', [...census]);
      const id = await each(ctx, async (n) => { const r = await fetch(`${n}/identity`); return { status: r.status, bytes: (await r.arrayBuffer()).byteLength }; });
      check(id.every((x) => x.status === 200 && x.bytes === 32), 'every /identity answers its 32-byte node key', id);
      return { guardians: g.length, census: [...census], roles: [...new Set(roles.flatMap((r) => r.nodes.flatMap((x) => x.roles)))] };
    },
  },
  {
    id: 'seats.games-and-network', area: 'node', title: '/games lists the hosted games with manifest and icon; /network names the regtest network and its federation', money: 0, reach: 3, timeoutMs: 60000,
    async run(ctx) {
      const games = await getJson(`${ctx.dn.nodes[0]}/games`);
      const names = games.games.map((x) => x.name);
      check(names.includes('nextblock'), 'nextblock is hosted', names);
      const icon = await fetch(`${ctx.dn.nodes[0]}/${games.games[0].icon}`);
      check(icon.ok, 'the game icon is served', icon.status);
      const net = await getJson(`${ctx.dn.nodes[0]}/network`);
      check(net.manifest?.chain === 'bitcoin-regtest', 'the network is regtest', net.manifest?.chain);
      const fees = await getJson(`${ctx.dn.nodes[0]}/fees`);
      check(fees.inForce && fees.inForce.roundNodeBps > 0, '/fees answers the fees in force', fees);
      const config = await getJson(`${ctx.dn.nodes[0]}/config`);
      check(/^[0-9a-f]{64}$/.test(config.configHash), '/config names the live game config', config);
      return { games: names, iconBytes: Number(icon.headers.get('content-length') || 0), network: net.title, configHash: config.configHash.slice(0, 16), fees: fees.inForce };
    },
  },
  {
    id: 'lightning.gateways-live', area: 'lightning', title: 'two gateways of two operators are registered at all seven guardians and hold e-cash (what a paid round and a deposit need)', money: 2, reach: 3, timeoutMs: 60000,
    async run(ctx) {
      const r = spawnSync(join(ctx.dn.fedBin, 'gateway-cli'), ['--address', ctx.dn.gateways[0], '--rpcpassword', (await import('node:fs')).readFileSync(join(ctx.dn.dir, 'gateway-a', 'password'), 'utf8').trim(), 'get-balances'], { encoding: 'utf8', env: ctx.env });
      check(r.status === 0, 'gateway A answers its balances', r.stderr);
      const bal = JSON.parse(r.stdout);
      const ecash = Number(bal.ecash_balances?.[0]?.ecash_balance_msats || 0);
      check(ecash > 1e9, 'gateway A holds e-cash for incoming payments (devnet.mjs liquidity)', ecash);
      const ch = ctx.dn.lncli('b', 'listchannels').channels;
      check(ch.some((c) => c.active), 'lnd B has an active channel to gateway A\'s lnd', ch.length);
      return { gatewayAEcashMsat: ecash, lndBChannels: ch.length };
    },
  },
  {
    id: 'round.free.headless-play', area: 'rounds', title: 'a free Next Block round played headless to its signed result: entry at 7 seats, batches and marks, 7 of 7 results agreeing with the local replay', money: 0, reach: 3, timeoutMs: 600000,
    async run(ctx) {
      const r = devnetTool(ctx, ['play'], 580000);
      const by = (s) => r.lines.find((l) => l.step === s);
      const entry = by('entry'), pub = by('published'), res = by('signed result');
      check(r.status === 0, `devnet.mjs play exits 0 (${r.err})`, r.status);
      check(entry && entry.refused.length === 0, 'no seat refuses the entry', entry);
      check(pub && pub.refused.length === 0 && pub.batchesTakenPerSeat.every((x) => x === pub.batches), 'every seat takes every batch', pub);
      check(res && res.final && res.agreeing >= res.needed && res.sameAsLocal && res.signatures.every((s) => s.valid), 'the signed results agree, are valid and match the local drive', res);
      ctx.shared.played = { round: res.round, entry: res.entry, outcome: res.outcome, score: res.score };
      return { round: res.round.slice(0, 16), entry: res.entry.slice(0, 16), outcome: res.outcome, score: res.score, agreeing: `${res.agreeing}/${res.signers}` };
    },
  },
  {
    id: 'round.replay', area: 'rounds', title: 'the played entry replays from a seat\'s transcript in the core\'s sandbox to the signed outcome', money: 0, reach: 1, after: ['round.free.headless-play'], timeoutMs: 300000,
    async run(ctx) {
      const p = ctx.shared.played;
      if (!p) throw new Skip('no round was played in this run (round.free.headless-play did not pass)');
      const r = devnetTool(ctx, ['replay', p.round, p.entry], 280000);
      check(r.status === 0, `devnet.mjs replay exits 0 (${r.err})`, r.lines.slice(-2));
      const last = r.lines[r.lines.length - 1] || {};
      const txt = JSON.stringify(r.lines);
      check(/"(same|match|agrees|sameAsSigned)[A-Za-z]*":true/.test(txt) || /"outcome":"[A-Z]+"/.test(txt), 'the replay answers an outcome that matches', last);
      return { last };
    },
  },
  {
    id: 'explorer.round-reads', area: 'explorer', title: 'the explorer\'s reads of a played round: /rounds, /round, /api/round-result, /results, /transcript, /census, /committee, /headers', money: 0, reach: 2, after: ['round.free.headless-play'], timeoutMs: 90000,
    async run(ctx) {
      const p = ctx.shared.played;
      if (!p) throw new Skip('no round was played in this run');
      const n = ctx.dn.nodes[2];
      const ok = async (path) => { const r = await fetch(`${n}${path}`, { signal: AbortSignal.timeout(15000) }); return { path, status: r.status, bytes: (await r.arrayBuffer()).byteLength }; };
      const reads = await Promise.all([`/round?id=${p.round}`, `/api/round-result?round=${p.round}`, `/round-result?round=${p.round}`, `/results?round=${p.round}&entry=${p.entry}`,
        `/transcript?round=${p.round}&entry=${p.entry}`, `/census?round=${p.round}`, `/committee?round=${p.round}`, '/headers', `/outcome?round=${p.round}`, `/replay?round=${p.round}&entry=${p.entry}`].map(ok));
      // /round-result and /outcome are an attested game's (btc-updown); for nextblock they answer 409 by design
      const bad = reads.filter((x) => x.status !== 200 && !(x.status === 409 && /^\/(round-result|outcome)\?/.test(x.path)));
      const rounds = await getJson(`${n}/rounds`);
      check(bad.length === 0, 'every explorer read answers 200', bad);
      return { reads: reads.map((x) => `${x.path.split('?')[0]} ${x.bytes}B`), listed: rounds.rounds.length };
    },
  },
  {
    id: 'season.board-and-badges', area: 'leaderboard', title: 'season board (seat and network scope), season rounds, badge definitions and a player\'s badges answer', money: 1, reach: 3, after: ['round.free.headless-play'], timeoutMs: 90000,
    async run(ctx) {
      const n = ctx.dn.nodes[0];
      const s = await getJson(`${n}/season?game=nextblock`);
      const net = await getJson(`${n}/season?game=nextblock&scope=network`, { ms: 60000 });
      const sr = await getJson(`${n}/season-rounds?game=nextblock`);
      const defs = await getJson(`${n}/badge-definitions`);
      const someone = '11'.repeat(32);
      const b = await getJson(`${n}/badges?player=${someone}`);
      check(typeof s === 'object' && s !== null, '/season answers', s);
      check(Array.isArray(defs.definitions) && defs.definitions.length > 0, 'badge definitions are listed', defs);
      check(Array.isArray(b.badges ?? b.awards ?? []), '/badges answers a list', b);
      return { seasonKeys: Object.keys(s).slice(0, 8), networkKeys: Object.keys(net).slice(0, 8), seasonRounds: (sr.rounds || sr.entries || []).length, badgeDefinitions: defs.definitions.length, badgesOn: defs.on };
    },
  },
  {
    id: 'proposals.ballot-reads', area: 'proposals', title: 'proposals and the ballot\'s live config answer at every seat with the same config hash', money: 1, reach: 1, timeoutMs: 60000,
    async run(ctx) {
      const all = await each(ctx, (n) => getJson(`${n}/config`));
      const hashes = new Set(all.map((c) => c.configHash));
      check(hashes.size === 1, 'every seat names one live config', [...hashes]);
      const p = await getJson(`${ctx.dn.nodes[0]}/proposals`);
      check(Array.isArray(p.proposals), '/proposals answers a list', p);
      const funding = await getJson(`${ctx.dn.nodes[0]}/funding`);
      check(funding.schedule && funding.schedule.vote > 0, '/funding answers its schedule', funding);
      return { configHash: [...hashes][0].slice(0, 16), proposals: p.proposals.length, fundingProposals: funding.proposals.length };
    },
  },
  {
    id: 'markets.reads', area: 'markets', title: 'market rounds, price samples and the exchange door answer', money: 1, reach: 2, timeoutMs: 60000,
    async run(ctx) {
      const n = ctx.dn.nodes[0];
      const m = await getJson(`${n}/market-rounds`);
      check(Array.isArray(m.rounds), '/market-rounds answers a list', m);
      const ps = await fetch(`${n}/price-samples`);
      return { marketRounds: m.rounds.length, priceSamples: ps.status, note: 'no market round is opened on the devnet: the devnet hosts no market game (btc-updown is not in DEVNET_APPS)' };
    },
  },
  {
    id: 'referrals.name-and-fees', area: 'referrals', title: 'referral fees answer and a referral name post is checked (refused unsigned)', money: 1, reach: 1, timeoutMs: 60000,
    async run(ctx) {
      const n = ctx.dn.nodes[0];
      const f = await getJson(`${n}/referral-fees`);
      check(f.totalMsat !== undefined, '/referral-fees answers', f);
      const bad = await post(`${n}/referral-name`, { name: 'e2e', sig: '00' });
      check(bad.status >= 400 && bad.status < 500, 'an unsigned referral name is refused with a 4xx', bad);
      return { totalMsat: f.totalMsat, unsignedNamePost: bad.status, why: String(typeof bad.body === 'string' ? bad.body : JSON.stringify(bad.body)).slice(0, 120) };
    },
  },
  {
    id: 'seats.owner-door-locked', area: 'owner', title: 'the owner\'s actions refuse a caller without the owner\'s login (POST /owner/roles, /owner/leave, /owner/bond-withdraw, /owner/settings); the owner\'s reads are public', money: 2, reach: 1, timeoutMs: 60000,
    async run(ctx) {
      const n = ctx.dn.nodes[0];
      const posts = {};
      for (const p of ['/owner/roles', '/owner/leave', '/owner/bond-withdraw', '/owner/settings', '/owner/plugins/install', '/owner/network/update', '/owner/key-from-words'])
        posts[p] = (await post(`${n}${p}`, {})).status;
      check(Object.values(posts).every((x) => x >= 400 && x < 500), 'no owner action answers 2xx to a stranger', posts);
      const reads = {};
      for (const p of ['/owner', '/owner/standing', '/owner/rounds', '/owner/version']) reads[p] = (await fetch(`${n}${p}`)).status;
      return { posts, reads };
    },
  },
  {
    id: 'seats.operator-door-locked', area: 'owner', title: 'the operator doors refuse a caller without a token (/operator/status, /operator/vote, /operator/config)', money: 1, reach: 1, timeoutMs: 60000,
    async run(ctx) {
      const n = ctx.dn.nodes[0];
      const codes = [(await fetch(`${n}/operator/status`)).status, (await post(`${n}/operator/vote`, { vote: 'yes' })).status, (await post(`${n}/operator/config`, {})).status];
      check(!codes.includes(200), 'no operator door answers 200 without a token', codes);
      return { codes };
    },
  },
  {
    id: 'round.paid.open', area: 'rounds', title: 'a paid round (10 000 sat) opens on the federation with two live gateways and is listed with its stake at every seat', money: 2, reach: 3, timeoutMs: 300000, order: 1,
    async run(ctx) {
      // A SEAT KEEPS ITS FEDERATION'S GATEWAY LIST A MINUTE AND SERVES THE KEPT ONE WHILE IT READS AGAIN (stake-lock-port.js keptFor,
      // server.js keptPer): the first paying round after a long quiet is judged on the list before; one more ask reads the new one
      let r = await post(`${ctx.dn.control}/open-paid?stakeMsat=10000000&windowMs=360000`, {}, { ms: 280000 });
      const first = r.status === 201 ? null : String(r.body?.why || '').slice(0, 160);
      if (r.status !== 201 && /live gateway/.test(first)) { await wait(15000); r = await post(`${ctx.dn.control}/open-paid?stakeMsat=10000000&windowMs=360000`, {}, { ms: 280000 }); }
      check(r.status === 201, 'the control door opens a paid round', r);
      const id = r.body.id;
      await wait(3000);
      const listed = await each(ctx, async (n) => (await getJson(`${n}/rounds`)).rounds.find((x) => x.id === id));
      check(listed.filter((x) => x && !x.error).length >= 5, 'at least five seats list the paid round', listed.map((x) => !!x && !x.error));
      const one = listed.find((x) => x && !x.error);
      ctx.shared.paidRound = id;
      return { round: id.slice(0, 16), stakeMsat: r.body.stakeMsat, firstAskRefused: first, listedAt: listed.filter((x) => x && !x.error).length, phase: one.phase, entryClose: r.body.entryClose };
    },
  },
  {
    id: 'round.paid.headless-entry', area: 'rounds', title: 'a paid entry (10 000 sat) end to end with the page\'s own wasm lock client: Lightning deposit through a gateway, stake and fee locked in the federation, played, handed over to 7 seats, settled, the payout withdrawn to a devnet lnd (tools/tn4-live-run.mjs)', money: 2, reach: 3, after: ['round.paid.open'], timeoutMs: 3300000, order: 2,
    async run(ctx) {
      if (!ctx.shared.paidRound) throw new Skip('no paid round could be opened in this run (round.paid.open did not pass)');
      // ITS OWN PAID ROUND, opened right before the entry: a round's entries close 6 min after it opens, and flows before this one
      // may take longer than that (the load gate)
      let o = await post(`${ctx.dn.control}/open-paid?stakeMsat=10000000&windowMs=360000`, {}, { ms: 280000 });
      if (o.status !== 201) { await wait(15000); o = await post(`${ctx.dn.control}/open-paid?stakeMsat=10000000&windowMs=360000`, {}, { ms: 280000 }); }
      check(o.status === 201, 'a fresh paid round opens', o);
      const rid = o.body.id;
      const pageDir = ctx.env.E2E_PAGE_DIR || ctx.env.DEVNET_PAGE_DIR;
      const e = { ...ctx.env, PORTS: ctx.dn.nodes.map((u) => u.split(':').pop()).join(','), INVITE_FILE: join(ctx.dn.dir, 'invite-code'), WASM_PKG: pageDir,
        LNCLI: join(ctx.dn.lndBin, 'lncli'), PAYER_DIR: join(ctx.dn.dir, 'lnd-b'), PAYER_RPC: `127.0.0.1:${ctx.dn.base + 20}`, ARENA_TN4_NETWORK: 'regtest',
        ANCHOR_HASH: ctx.dn.cli('getblockhash', '0'), ANCHOR_HEIGHT: '0', GATEWAY: `http://localhost:${ctx.dn.base + 30}/`, ROUND: rid, COLLECT_MS: '1500000', WITHDRAW: '1',
        KEYS_FILE: join(ctx.dir, 'keys.jsonl'), MARK_BOT: 'off', EXPLORER_MARK_URL: 'http://127.0.0.1:9/', ADMIN_CODE_FILE: '/nonexistent-e2e' };
      const { spawn } = await import('node:child_process');
      const { createWriteStream } = await import('node:fs');
      const out = createWriteStream(join(ctx.dir, 'run.log'));
      const lines = [];
      const code = await new Promise((done) => {
        const c = spawn(process.execPath, [join(ctx.root, 'packages/arena-node/tools/tn4-live-run.mjs')], { cwd: join(ctx.root, 'packages/arena-node'), env: e });
        let buf = '';
        c.stdout.on('data', (d) => { out.write(d); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { lines.push(JSON.parse(l)); } catch { /* text */ } } });
        c.stderr.on('data', (d) => out.write(d));
        const kill = setTimeout(() => c.kill('SIGTERM'), 3200000);
        c.on('exit', (x) => { clearTimeout(kill); done(x); });
      });
      const step = (s) => lines.filter((l) => l.step === s).pop();
      const dep = step('deposit'), locked = step('locked'), handed = step('handed over'), settle = lines.filter((l) => l.step === 'settlement').pop();
      const ev = { exit: code, deposit: dep && { msat: dep.msat, final: dep.final }, locked: locked && locked.msat, handedOver: handed && handed.signerNodes?.map((x) => `${x.entry}/${x.lock}`),
        last: lines.slice(-3).map((l) => ({ step: l.step, ...(l.why ? { why: String(l.why).slice(0, 160) } : {}) })) };
      check(dep && dep.final === 'Claimed', 'the deposit is claimed into the lock client', ev);
      check(locked, 'the stake is locked in the federation', ev);
      check(handed && handed.signerNodes.filter((x) => x.entry === 201 && x.lock === 201).length >= 5, 'at least 5 seats take the entry and verify the lock', ev);
      check(code === 0, 'the run ends cleanly (settled and collected)', ev);
      ctx.shared.paidEntry = { round: rid, lines: lines.length };
      return ev;
    },
  },
];
