// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S SETUP STEPS, IN REACT (kanban #564, installer slice 2): the Bitcoin connection (your Core, an Electrum server, or Core
// installed here in a folder you choose, syncing in the background - kanban #635), how others reach the node (the direct test, a
// Cloudflare login, the tunnel kinds), the install as a user service (and the Nostr login after it), and the federation explained. Each
// gets the wizard's `st`, `post`, `get` and `reload`; a step's timers stop when the wizard leaves it (the page unmounts it).
// THE WORDS (kanban #635, 2026-10-25: "Texte ... sollen klarer werden und weniger AI Like"): short, plain, one idea a sentence.
import React from 'react';
import { Msg } from './WizardSteps.jsx';

const said = (r, okText) => ({ ok: !!r.ok, text: r.ok ? okText : (r.why || 'failed') });
const gb = (b) => `${Math.round(b / 2 ** 30).toLocaleString('en')} GB`;
export const dur = (ms) => (ms === null || ms === undefined ? 'working out how long (give it a few minutes)' : ms < 3600000 ? `about ${Math.max(1, Math.round(ms / 60000))} min`
  : ms < 172800000 ? `about ${Math.round(ms / 3600000)} h` : `about ${Math.round(ms / 86400000)} days`);
/** The chain test's answer in the owner's words: this source, and the second one it was compared with. */
export const chainText = (r) => {
  const x = r.result || r; const s = x.source || {};
  return `${x.ok ? 'Passed' : 'Failed'}: ${x.why}\nthis source: ${s.ok ? `testnet4 (genesis checked), tip ${s.height}, ${s.latencyMs} ms${s.software ? `, ${s.software}` : ''}${s.pruned ? ', pruned' : ''}` : s.why}`
    + (x.second ? `\nsecond source ${x.second.endpoint}: ${x.second.ok ? `tip ${x.second.height}, ${x.second.latencyMs} ms` : x.second.why}` : '');
};

export class ChainStep extends React.Component {
  constructor(props) {
    super(props);
    const e = (props.st.electrum || [])[0] || { host: '', port: '', tls: true };
    this.state = { kind: 'core', url: 'http://127.0.0.1:48332/', cookie: '', user: '', pass: '', pick: '0', host: e.host, port: String(e.port), tls: e.tls !== false, ws: !!e.ws, path: e.path || '',
      plan: null, dir: '', prune: false, mainnet: false, installing: false, sync: null, busy: false, msg: null, ...(props.initial || {}) };
    this.test = this.test.bind(this); this.save = this.save.bind(this); this.install = this.install.bind(this); this.watch = this.watch.bind(this); this.checkDir = this.checkDir.bind(this);
  }
  async componentDidMount() {
    if (this.props.initial || !this.props.post) return;
    const r = await this.props.post('/api/core/plan');   // a Core installed by an earlier visit: straight to its sync
    if (r && r.core) { this.setState({ kind: 'install', sync: { networks: {} } }); this.watch(); }
  }
  componentWillUnmount() { this.gone = true; clearTimeout(this.timer); clearInterval(this.progTimer); }
  async kind(k) {
    this.setState({ kind: k, msg: null });
    if (k !== 'install' || this.state.plan) return;
    const r = await this.props.post('/api/core/plan');
    if (r.core) { this.setState({ sync: { networks: {} } }); return this.watch(); }
    this.setState({ plan: r, dir: r.dir || '', prune: !!(r.disk && !r.disk.networks.testnet4.full) });
  }
  /** The free space of the folder typed in (kanban #635: the owner chooses where the blocks go). */
  async checkDir() {
    const r = await this.props.post('/api/core/plan', { dir: this.state.dir });
    if (!r.ok) return this.setState({ msg: said(r) });
    this.setState({ plan: r, dir: r.dir, msg: null, prune: !!(r.disk && !r.disk.networks.testnet4.full) });
  }
  pickServer(v) {
    const s = (this.props.st.electrum || [])[v];
    this.setState(s ? { pick: v, host: s.host, port: String(s.port), tls: s.tls !== false, ws: !!s.ws, path: s.path || '' } : { pick: v, ws: false, path: '' });
  }
  body() {
    const s = this.state;
    return s.kind === 'core'
      ? { kind: 'core', url: s.url.trim(), ...(s.cookie.trim() ? { cookiePath: s.cookie.trim() } : { user: s.user, password: s.pass }) }
      : { kind: 'electrum', host: s.host.trim(), port: Number(s.port), tls: s.tls, ...(s.ws ? { ws: true, path: s.path } : {}) };   // ours over a websocket (kanban #656)
  }
  async test() {
    this.setState({ busy: true, msg: { ok: true, text: 'Testing…' } });
    const r = await this.props.post('/api/chain/test', this.body());
    this.setState({ busy: false, msg: r.ok ? { ok: !!(r.result && r.result.ok), text: chainText(r) } : said(r) });
  }
  async save() {
    this.setState({ busy: true });
    const r = await this.props.post('/api/chain/save', this.body());
    this.setState({ busy: false });
    if (r.ok) return this.props.reload();
    this.setState({ msg: { ok: false, text: r.result ? chainText(r) : r.why } });
  }
  // BITCOIN CORE'S INSTALL WITH ITS BAR (the owner's playtest 2026-10-25, "Downloading Bitcoin Core and checking it…": "Füge auch hier
  // eine Progress Bar hinzu"): GET /api/core/progress every second while POST /api/core/install runs - the download by its megabytes
  async coreProgress() {
    if (!this.props.get || this.gone) return;
    const p = await this.props.get('/api/core/progress');
    if (!this.gone && p && p.ok) this.setState({ coreProg: p });
  }
  async install() {
    this.setState({ installing: true, msg: null, coreProg: null });
    clearInterval(this.progTimer); this.progTimer = setInterval(() => this.coreProgress(), 1000);
    const r = await this.props.post('/api/core/install', { prune: this.state.prune, mainnet: this.state.mainnet, dir: this.state.dir });
    clearInterval(this.progTimer); await this.coreProgress();
    if (!r.ok) return this.setState({ installing: false, msg: said(r) });
    // THE SYNC RUNS IN THE BACKGROUND (kanban #635): with an Electrum server standing in, setup goes on at once
    if (r.interim) return this.props.reload();
    this.setState({ msg: { ok: true, text: 'Bitcoin Core is running and syncing.' }, sync: { networks: {} } });
    this.watch();
  }
  async watch() {
    if (this.gone) return;
    const r = await this.props.get('/api/core/status');
    if (this.gone) return;
    if (r && r.ok) {
      this.setState({ sync: r });
      if (r.chainSaved) return this.props.reload();
    }
    // near the end, every 5 s (kanban #636: at 100 % the page must move on by itself, not a quarter of a minute later)
    const t4 = r && r.networks && r.networks.testnet4;
    clearTimeout(this.timer); this.timer = setTimeout(this.watch, this.props.pollMs || (t4 && t4.progress >= 0.99 ? 5000 : 15000));
  }
  syncRows() {
    const nets = Object.entries((this.state.sync && this.state.sync.networks) || {}).filter(([k]) => k === 'testnet4' || k === 'mainnet');
    return nets.map(([n, x]) => (
      <div key={n} className="role"><div style={{ flex: 1 }}>{x.ok ? <>
        <b>{n}</b> - block {x.blocks.toLocaleString('en')} of {x.headers.toLocaleString('en')} · {(x.progress * 100).toFixed(2)} % · {x.synced ? <b>synced</b> : x.progress >= 0.9995 ? 'finishing the last blocks' : `${dur(x.etaMs)} left`}
        <div className="bar"><i style={{ width: `${(x.progress * 100).toFixed(2)}%` }} /></div></> : <><b>{n}</b> - {x.why}</>}</div></div>));
  }
  installForm() {
    const { plan, dir, prune, mainnet, installing, sync } = this.state;
    // SYNCED SAYS SYNCED (kanban #814, the owner: "bitcoin core is synced and running. the message in the screenshot is confusing"): at 100 %
    // neither "syncing" nor the wait of hours is true any more
    const t4Synced = !!(sync && sync.networks && sync.networks.testnet4 && sync.networks.testnet4.synced);
    if (sync) return (
      <div id="sync">
        <p className="sub">{t4Synced ? 'Bitcoin Core is installed and synced.' : 'Bitcoin Core is installed and syncing.'}</p>
        {/* THE INTERIM CHAIN SAID AS IT IS (kanban #635, the owner's playtest 2026-10-25: the step, opened again, said no Electrum server had
            answered while one had) */}
        {t4Synced ? null : this.props.st.coreSync && this.props.st.coreSync.interim
          ? <p className="sub">Until the sync is done, your node reads the chain from a public Electrum server ({this.props.st.chain ? `${this.props.st.chain.host}:${this.props.st.chain.port}` : 'chosen by setup'}) and switches to this Bitcoin Core by itself. Setup does not wait for it.</p>
          : <p className="warn">No public Electrum server answered, so setup has to wait for the sync this time. That takes hours on testnet4. <b>Bookmark this page</b> and keep the installer running. Setup goes on here by itself once testnet4 is synced.</p>}
        {this.syncRows()}
        {/* SYNCED BUT NOT SAVED (kanban #636): why, and a way to try again - never a silent 100 % */}
        {sync.networks && sync.networks.testnet4 && sync.networks.testnet4.synced && sync.chainSaved === false
          ? <div className="msg bad" id="sync-why">Bitcoin Core is synced, but setup could not use it yet: {sync.chainWhy || 'no answer'}.
            <button type="button" className="ghost" id="sync-retry" onClick={() => { clearTimeout(this.timer); this.watch(); }}>Try again</button></div>
          : <p className="sub">{t4Synced ? 'Setup is connecting to it and goes on by itself.' : 'Setup checks again by itself every few seconds.'}</p>}
      </div>);
    if (!plan) return <p className="sub">Checking this computer…</p>;
    if (plan.installed) return <p className="sub">Bitcoin Core is already installed here (<code>{plan.installed}</code>). Choose <b>My Bitcoin Core</b> and connect it.</p>;
    const d = plan.disk, n = plan.needs;
    return (
      <div>
        <label htmlFor="core-dir">Folder for the blocks</label>
        <div className="row"><div style={{ flex: 3 }}><input id="core-dir" placeholder={plan.defaultDir} value={dir} onChange={(e) => this.setState({ dir: e.target.value })} /></div>
          <div><button type="button" className="ghost" onClick={this.checkDir}>Check this folder</button></div></div>
        <p className="sub">Free in this folder: <b>{gb(d.freeBytes)}</b>. testnet4 needs {gb(n.testnet4.fullBytes)}, or {gb(n.testnet4.prunedBytes)} pruned. Mainnet needs {gb(n.mainnet.fullBytes)}, or {gb(n.mainnet.prunedBytes)} pruned.</p>
        {d.warn ? <p className="warn">{d.warn}</p> : <p className="sub">Enough space for both.</p>}
        <label className="choice"><input type="checkbox" checked={prune} onChange={(e) => this.setState({ prune: e.target.checked })} /><div><b>Pruned</b><p>Keeps only the newest blocks. Uses a few GB instead of the whole chain. Your node works the same.</p></div></label>
        <label className="choice"><input type="checkbox" checked={mainnet} onChange={(e) => this.setState({ mainnet: e.target.checked })} /><div><b>Also mainnet</b><p>A second Bitcoin Core for mainnet, for later. Bitcoin Arena runs on testnet4 for now.</p></div></label>
        <p className="sub">Setup goes on while Bitcoin Core syncs. Until then your node reads the chain from a public server, and it switches to your own Bitcoin Core by itself when the sync is done. Your dashboard shows the progress.</p>
        <button type="button" disabled={installing} onClick={this.install}>{installing ? 'Installing Bitcoin Core…' : 'Install Bitcoin Core'}</button>
        {this.state.coreProg && this.state.coreProg.elapsedMs !== undefined ? <ServiceProgress id="core-progress" progress={this.state.coreProg} hints={CORE_HINT} budgets={CORE_BUDGET} weights={CORE_WEIGHT} slowAt={{}} /> : null}
      </div>);
  }
  render() {
    const s = this.state; const servers = this.props.st.electrum || [];
    const kinds = [['core', 'My Bitcoin Core', '₿'], ['electrum', 'Electrum server', '🔌'], ['install', 'Install Bitcoin Core for me', '⬇️']];
    return (
      <div className="aw">
        <h2>2. Bitcoin</h2>
        <p className="sub">Your node needs to read the testnet4 chain. Connect your own Bitcoin Core, use an Electrum server, or let setup install Bitcoin Core for you.</p>
        <div className="kinds">{kinds.map(([k, t, ic]) => (
          <button key={k} type="button" id={`k-${k}`} className={`kind${s.kind === k ? ' on' : ''}`} onClick={() => this.kind(k)}><span aria-hidden="true">{ic}</span> {t}</button>))}</div>
        {s.kind === 'core' ? <div>
          <label htmlFor="c-url">RPC address</label><input id="c-url" value={s.url} onChange={(e) => this.setState({ url: e.target.value })} />
          <label htmlFor="c-cookie">Cookie file (or leave it empty and give a user and password)</label><input id="c-cookie" placeholder="~/.bitcoin/testnet4/.cookie" value={s.cookie} onChange={(e) => this.setState({ cookie: e.target.value })} />
          <div className="row"><div><label htmlFor="c-user">RPC user</label><input id="c-user" value={s.user} onChange={(e) => this.setState({ user: e.target.value })} /></div>
            <div><label htmlFor="c-pass">RPC password</label><input id="c-pass" type="password" value={s.pass} onChange={(e) => this.setState({ pass: e.target.value })} /></div></div>
        </div> : null}
        {s.kind === 'electrum' ? <div>
          <label htmlFor="e-pick">Server</label>
          <select id="e-pick" value={s.pick} onChange={(e) => this.pickServer(e.target.value)}>
            {servers.map((x, i) => <option key={i} value={String(i)}>{x.ws ? `${x.note} (recommended)` : `${x.host}:${x.port}${x.tls ? ' (TLS)' : ''} - ${x.note}`}</option>)}<option value="own">another server</option></select>
          <div className="row"><div><label htmlFor="e-host">Host</label><input id="e-host" value={s.host} onChange={(e) => this.setState({ host: e.target.value })} /></div>
            <div><label htmlFor="e-port">Port</label><input id="e-port" value={s.port} onChange={(e) => this.setState({ port: e.target.value })} /></div></div>
          <label className="choice"><input type="checkbox" checked={s.tls} onChange={(e) => this.setState({ tls: e.target.checked })} /><div><b>TLS</b></div></label>
          <p className="sub">With an Electrum server, a small bridge on this computer reads block headers from the server and whole blocks from a block API; it checks every block itself.</p>
        </div> : null}
        {s.kind === 'install' ? this.installForm() : <div>
          <button type="button" className="ghost" disabled={s.busy} onClick={this.test}>Test</button>
          <button type="button" disabled={s.busy} onClick={this.save}>Save and continue</button></div>}
        <Msg r={s.msg} />
      </div>
    );
  }
}

// THE WAYS IN, most permanent first; the direct test picks the default (direct when it reached this machine, Tailscale Funnel when it did not
// and the machine is on a tailnet - kanban #734 - else the permanent tunnel)
export const REACH_MODES = Object.freeze(['direct', 'permanent', 'tailscale', 'workers', 'quick']);
export const defaultMode = (direct) => (direct ? (direct.reached ? 'direct' : direct.tailnet ? 'tailscale' : 'permanent') : null);
export const directText = (d) => (d.reached ? `Reachable from the internet at ${d.address}:${d.port}. A direct connection is the default.`
  : `Not reachable directly from the internet: ${d.diagnosis ? d.diagnosis.advice : d.why}\n${d.tailnet
    ? `This machine is on your tailnet as ${d.tailnet}. Tailscale Funnel is the default: it needs no port opened on your router.`
    : 'The permanent tunnel is the default.'}`);

export class ReachStep extends React.Component {
  constructor(props) {
    super(props);
    const st = props.st;
    // a step opened again shows the way saved (kanban #666), not the default one
    const saved = st.reach || {};
    this.state = { port: String((st.direct && st.direct.port) || st.defaultPort || ''), direct: st.direct || null, mode: saved.mode || defaultMode(st.direct), host: saved.hostname || '', cfToken: '',
      login: st.login || null, testing: false, saving: false, directMsg: null, loginMsg: null, msg: null, ...(props.initial || {}) };
    this.test = this.test.bind(this); this.login = this.login.bind(this); this.save = this.save.bind(this); this.pollLogin = this.pollLogin.bind(this);
  }
  componentWillUnmount() { this.gone = true; clearTimeout(this.timer); }
  async test() {
    this.setState({ testing: true, directMsg: { ok: true, text: 'Asking other nodes to connect to this computer…' } });
    const r = await this.props.post('/api/reach/direct', { port: Number(this.state.port) });
    if (!r.ok) return this.setState({ testing: false, directMsg: said(r) });
    this.setState((s) => ({ testing: false, direct: r.result, mode: s.mode || defaultMode(r.result), directMsg: null }));
  }
  async login() {
    this.setState({ mode: 'permanent' });
    const r = await this.props.post('/api/reach/login');
    if (!r.ok) return this.setState({ loginMsg: said(r) });
    this.setState({ login: { url: r.url, result: r.result || null }, loginMsg: null });
    if (!r.result) { clearTimeout(this.timer); this.timer = setTimeout(this.pollLogin, this.props.pollMs || 3000); }
  }
  async pollLogin() {
    if (this.gone) return;
    const s = await this.props.get('/api/state');
    if (this.gone) return;
    if (s && s.login) this.setState({ login: s.login });
    if (!(s && s.login && s.login.result)) { clearTimeout(this.timer); this.timer = setTimeout(this.pollLogin, this.props.pollMs || 3000); }
  }
  async save() {
    const { mode, host, port, cfToken } = this.state;
    if (!mode) return this.setState({ msg: said({ ok: false, why: 'test the direct connection first, or choose a tunnel' }) });
    this.setState({ saving: true });
    const r = await this.props.post('/api/reach/save', { mode, hostname: host, port: Number(port), cfToken });
    this.setState({ saving: false });
    if (r.ok) return this.props.reload();
    this.setState({ msg: said(r) });
  }
  loginLine() {
    const l = this.state.login;
    if (this.state.loginMsg) return <Msg r={this.state.loginMsg} />;
    if (!l) return null;
    if (l.result && l.result.ok) return <div className="msg ok">Logged in to Cloudflare.</div>;
    if (l.result) return <div className="msg bad">{l.result.why}</div>;
    return l.url ? <div className="msg ok">Open <a href={l.url} target="_blank" rel="noopener noreferrer">this Cloudflare link</a>, sign up or log in, and pick the domain for your node. This page waits for you.</div> : null;
  }
  option(mode, title, text, extra = null, tag = null) {
    const on = this.state.mode === mode;
    return (
      <label key={mode} className={`choice${on ? ' on' : ''}`}>
        <input type="radio" name="rm" value={mode} checked={on} onChange={() => this.setState({ mode })} />
        <div><b>{title}</b>{tag ? <span className="tag">{tag}</span> : null}<p>{text}</p>{on ? extra : null}</div>
      </label>);
  }
  render() {
    const { port, direct, host, cfToken, testing, saving, directMsg, msg } = this.state;
    const rec = defaultMode(direct);
    return (
      <div className="aw">
        <h2>8. How others reach your node</h2>
        <p className="sub">Players and other nodes connect to your node. First, setup checks whether the internet can reach this computer directly.</p>
        <div className="row"><div><label htmlFor="r-port">Port for incoming connections</label><input id="r-port" value={port} onChange={(e) => this.setState({ port: e.target.value })} /></div></div>
        <button type="button" className="ghost" id="r-test" disabled={testing} onClick={this.test}>Test direct connection</button>
        {directMsg ? <Msg r={directMsg} /> : direct ? <div className={`msg ${direct.reached ? 'ok' : 'bad'}`}>{directText(direct)}</div> : null}
        <div className="choices">
          {this.option('direct', 'Direct connection', 'Your node listens on the port above. The port must be open in your firewall and, behind a router, forwarded to this computer.', null, rec === 'direct' ? 'recommended' : null)}
          {this.option('permanent', 'Permanent Cloudflare tunnel', 'A fixed https name such as node.example.com, through your own free Cloudflare account and a domain on it (Cloudflare sells one for a few dollars a year). No open ports. No domain? Use workers.dev or Tailscale Funnel below.', <>
            <button type="button" className="ghost" onClick={this.login}>Sign up or log in to Cloudflare</button>{this.loginLine()}
            <label htmlFor="r-host">Your node's name (under a domain on that account)</label>
            <input id="r-host" placeholder="node.example.com" value={host} onChange={(e) => this.setState({ host: e.target.value })} /></>, rec === 'permanent' ? 'recommended' : null)}
          {this.option('tailscale', 'Permanent Tailscale Funnel', 'A fixed https name such as my-pc.tail1234.ts.net from your free Tailscale account. No domain, no open ports. Install Tailscale and log in (tailscale up) first, and allow Funnel for this computer in your tailnet.')}
          {this.option('workers', 'Permanent Cloudflare name without a domain (workers.dev)', 'A fixed name such as bitcoinarena-1a2b3c.yourname.workers.dev on your own free Cloudflare account. No open ports. A small Worker there forwards to your node, and your node keeps it pointed at the right place. Free up to 100,000 requests a day (Workers Paid: $5 a month).', <>
            <p>1. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">Create an API token</a> from the template <b>Edit Cloudflare Workers</b>, for your account. 2. Paste it here:</p>
            <label htmlFor="r-cftoken">Cloudflare API token</label>
            <input id="r-cftoken" type="password" autoComplete="off" placeholder="the token Cloudflare shows once" value={cfToken} onChange={(e) => this.setState({ cfToken: e.target.value })} /></>)}
          {this.option('quick', 'Temporary tunnel', 'A random trycloudflare.com name, no account needed. The name changes when the tunnel restarts, and others cannot find your node until it is announced again.')}
        </div>
        <button type="button" disabled={saving} onClick={this.save}>Save and continue</button>
        <Msg r={msg} />
      </div>
    );
  }
}

// THE STEPS OF "INSTALL AND START", AS THEY RUN (kanban #651, 2026-10-25: "this hangs alot and user doesn't know what it is doing.
// Provide more details and context and a progress bar"): GET /api/service/progress read every second while POST /api/service runs
const STAGE_HINT = {
  settings: 'Your choices from the steps before go into the node\'s settings file.',
  services: 'The node, its chain connection and its tunnel become services of this computer, so they run without this page.',
  start: 'Your node loads, connects to the chain and to the other nodes. This usually takes 10 to 60 seconds.',
  tunnel: 'Cloudflare gives your node its address. This usually takes a few seconds.',
  restart: 'Your node restarts once, so it announces its new address to the other nodes. This takes 10 to 60 seconds.',
  address: 'Setup asks your node through its public address, the way other nodes will reach it. A new tunnel can take up to a minute before it answers.',
  login: 'Setup logs in once with your owner key, to check that the node knows you as its owner.',
};
const secs = (ms) => `${Math.round((ms || 0) / 1000)} s`;
export const CORE_HINT = {
  download: 'The official release, straight from bitcoincore.org.',
  check: 'Setup compares the file with the checksum bitcoincore.org publishes, so it runs only the real Bitcoin Core.',
  unpack: 'The program goes into your node\'s folder.',
  services: 'Bitcoin Core becomes a service of this computer and starts syncing in the background.',
  chain: 'Until Bitcoin Core has synced, your node reads the chain from a public server. Setup finds one that answers.',
};
const CORE_BUDGET = { download: 120000, check: 3000, unpack: 10000, services: 10000, chain: 20000 };
const CORE_WEIGHT = { download: 70, check: 3, unpack: 7, services: 12, chain: 8 };
/** The share of the work done: finished stages, plus a part of the running one (by its usual time: the node's start up to 90 s). */
export function progressShare(p, budgets = { start: 90000, restart: 60000 }, weights = null) {
  const st = (p && p.stages) || [];
  const counted = st.filter((x) => x.state !== 'skipped');
  if (!counted.length) return 0;
  // each stage by its weight where one is given (Bitcoin Core's download is most of its install), else all alike
  const wt = (x) => (weights && weights[x.id]) || 1;
  const all = counted.reduce((a, x) => a + wt(x), 0);
  const done = counted.filter((x) => x.state === 'done').reduce((a, x) => a + wt(x), 0);
  const now = counted.find((x) => x.state === 'now');
  // a stage that counts its own share (a download by its bytes) says it; any other one by its usual time
  const part = !now ? 0 : typeof now.part === 'number' ? Math.min(0.99, Math.max(0, now.part)) : Math.min(0.95, (now.ms || 0) / (budgets[now.id] || 20000));
  return Math.min(1, (done + part * (now ? wt(now) : 0)) / all);
}
export class ServiceProgress extends React.Component {
  render() {
    const p = this.props.progress;
    if (!p || !p.stages) return null;
    const { hints = STAGE_HINT, budgets, weights, slowAt = { start: 45000 }, slowText = 'Your node takes longer than usual. Setup waits up to 90 seconds, then says what stopped it.',
      logOf = 'The node\'s last messages:', id = 'svc-progress' } = this.props;
    const share = progressShare(p, budgets, weights);
    const mark = { done: '✓', now: '…', failed: '✗', skipped: '–', todo: '○' };
    const slow = p.stages.find((x) => x.state === 'now' && slowAt[x.id] && x.ms > slowAt[x.id]);
    return (
      <div className="svc-progress" id={id}>
        <div className="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(share * 100)}><i style={{ width: `${(share * 100).toFixed(1)}%` }} /></div>
        <p className="sub">{Math.round(share * 100)} % · {secs(p.elapsedMs)} so far</p>
        <ol className="stages">
          {p.stages.filter((x) => x.state !== 'skipped').map((x) => (
            <li key={x.id} className={`stage ${x.state}`}>
              <span className="mark">{mark[x.state] || '○'}</span> <b>{x.label}</b>{x.state === 'now' && x.text ? ` · ${x.text}` : ''}{x.state === 'now' || x.state === 'done' || x.state === 'failed' ? ` · ${secs(x.ms)}` : ''}
              {(x.state === 'now' || x.state === 'failed') && hints[x.id] ? <p className="sub">{hints[x.id]}</p> : null}
            </li>))}
        </ol>
        {slow ? <p className="sub">{slowText}</p> : null}
        {p.log && p.log.length ? <div className="log"><p className="sub">{logOf}</p><pre>{p.log.join('\n')}</pre></div> : null}
      </div>);
  }
}

export class ServiceStep extends React.Component {
  constructor(props) {
    super(props);
    this.state = { boot: true, busy: false, template: null, msg: null, progress: null, ...(props.initial || {}) };
    this.start = this.start.bind(this); this.nostrLogin = this.nostrLogin.bind(this); this.poll = this.poll.bind(this);
  }
  componentWillUnmount() { clearInterval(this.timer); }
  async poll() {
    const p = await this.props.get('/api/service/progress');
    if (p && p.ok) this.setState({ progress: p });
  }
  async start() {
    this.setState({ busy: true, msg: null, progress: null });
    this.timer = setInterval(this.poll, 1000);
    const r = await this.props.post('/api/service', { boot: this.state.boot });
    clearInterval(this.timer);
    await this.poll();
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ msg: said(r) });
    if (r.template) return this.setState({ template: r.template, msg: { ok: true, text: `Your node is running (started in ${r.ms} ms). Now log in once with your Nostr key.` } });
    this.props.reload();
  }
  async nostrLogin() {
    // the nsec typed once more (kanban #653: a Nostr owner needs no browser extension) - signed by setup, never kept
    if (this.state.nsec) {
      const r = await this.props.post('/api/owner/login', { nsec: this.state.nsec });
      this.setState({ nsec: '' });
      if (r.ok) return this.props.reload();
      return this.setState({ msg: said(r) });
    }
    const nostr = this.props.nostr || (typeof window !== 'undefined' ? window.nostr : null);
    if (!nostr) return this.setState({ msg: said({ ok: false, why: 'type your nsec above, or use a browser extension that holds your Nostr key' }) });
    const ev = await nostr.signEvent({ ...this.state.template, created_at: Math.floor(Date.now() / 1000) });
    const r = await this.props.post('/api/owner/login', { nostr: ev });
    if (r.ok) return this.props.reload();
    this.setState({ msg: said(r) });
  }
  render() {
    const { boot, busy, template, msg, progress } = this.state;
    return (
      <div className="aw">
        <h2>9. Install and start</h2>
        <p>Setup installs your node as a service, starts it, checks that it answers at its public address, and logs you in once as its owner.</p>
        <label className={`choice${boot ? ' on' : ''}`}><input type="checkbox" id="boot" checked={boot} onChange={(e) => this.setState({ boot: e.target.checked })} />
          <div><b>Start again after a reboot</b><p>Recommended. It also keeps your node running when you log out.</p></div></label>
        {template ? <>
          <label htmlFor="svc-nsec">Your nsec, to log in once as the owner</label>
          <input id="svc-nsec" type="password" autoComplete="off" spellCheck="false" placeholder="nsec1… (or leave empty to use a browser extension)" value={this.state.nsec || ''} onChange={(e) => this.setState({ nsec: e.target.value })} />
          <button type="button" id="svc-nostr" onClick={this.nostrLogin}>Log in with Nostr</button></>
          : <button type="button" id="svc" disabled={busy} onClick={this.start}>{busy ? 'Installing…' : 'Install and start'}</button>}
        <ServiceProgress progress={progress} />
        <Msg r={msg} />
      </div>
    );
  }
}

/** Ten guardians in a ring around the vault: seven lit (the signatures it takes), three not. */
export class FedRing extends React.Component {
  render() {
    return (
      <svg viewBox="0 0 200 180" className="fed-ring" aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => {
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          return <circle key={i} cx={(100 + 70 * Math.cos(a)).toFixed(1)} cy={(90 + 70 * Math.sin(a)).toFixed(1)} r="11" fill={i < 7 ? '#f7931a' : '#57606a'} />;
        })}
        <rect x="80" y="70" width="40" height="38" rx="6" fill="#1f6feb" /><circle cx="100" cy="86" r="6" fill="#fff" /><rect x="98" y="88" width="4" height="10" fill="#fff" />
      </svg>);
  }
}

export class FederationStep extends React.Component {
  constructor(props) { super(props); this.state = { busy: false, msg: null }; this.go = this.go.bind(this); }
  async go() {
    this.setState({ busy: true });
    const r = await this.props.post('/api/federation');
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ msg: said(r) });
    this.props.reload();
  }
  render() {
    return (
      <div className="aw">
        <h2>11. Your federation</h2>
        <div className="fed-explain">
          <FedRing />
          <div>
            <p className="big">A <b>federation</b> is <b>10 nodes</b> that hold the players' bitcoin <b>together</b>.</p>
            <p>🔒 Moving any of it takes <b>7 of the 10</b>. No single node can take it, yours included.</p>
            <p>⚡ Two of its nodes run the Lightning gateways. Every guardian earns a share of each round.</p>
          </div>
        </div>
        <p className="big">Your node gets a seat <b>by itself</b>, in one of two ways:</p>
        <div className="choices">
          <div className="choice"><div><b>✨ A new federation</b><p>Your node and <b>9 other new nodes</b> are drawn to start one together.</p></div></div>
          <div className="choice"><div><b>🔄 A seat in a successor</b><p>When a guardian leaves a federation, a new federation takes over its players' bitcoin. Its remaining guardians stay, and the empty seats are <b>drawn</b> from nodes like yours.</p></div></div>
        </div>
        <p className="sub">Nobody invites and nobody picks. The chain decides the draw, so no one can choose who guards the money. A full federation takes no new guardians.</p>
        <button type="button" disabled={this.state.busy} onClick={this.go}>Continue</button>
        <Msg r={this.state.msg} />
      </div>
    );
  }
}
