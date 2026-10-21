// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S SETUP STEPS, IN REACT (kanban #564, installer slice 2): the Bitcoin connection (your Core, an Electrum server, or Core
// installed here and its sync watched), how others reach the node (the direct test, a Cloudflare login, the tunnel kinds), the install as
// a user service (and the Nostr login after it), and the federation explained. Each gets the wizard's `st`, `post`, `get` and `reload`;
// a step's timers stop when the wizard leaves it (the page unmounts it).
import React from 'react';
import { Msg } from './WizardSteps.jsx';

const said = (r, okText) => ({ ok: !!r.ok, text: r.ok ? okText : (r.why || 'failed') });
const gb = (b) => `${Math.round(b / 2 ** 30).toLocaleString('en')} GB`;
export const dur = (ms) => (ms === null || ms === undefined ? 'estimating… (a few minutes of syncing first)' : ms < 3600000 ? `about ${Math.max(1, Math.round(ms / 60000))} min`
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
    this.state = { kind: 'core', url: 'http://127.0.0.1:48332/', cookie: '', user: '', pass: '', pick: '0', host: e.host, port: String(e.port), tls: e.tls !== false,
      plan: null, prune: false, mainnet: false, installing: false, sync: null, busy: false, msg: null, ...(props.initial || {}) };
    this.test = this.test.bind(this); this.save = this.save.bind(this); this.install = this.install.bind(this); this.watch = this.watch.bind(this);
  }
  async componentDidMount() {
    if (this.props.initial || !this.props.post) return;
    const r = await this.props.post('/api/core/plan');   // a Core installed by an earlier visit: straight to its sync
    if (r && r.core) { this.setState({ kind: 'install', sync: { networks: {} } }); this.watch(); }
  }
  componentWillUnmount() { this.gone = true; clearTimeout(this.timer); }
  async kind(k) {
    this.setState({ kind: k, msg: null });
    if (k !== 'install' || this.state.plan) return;
    const r = await this.props.post('/api/core/plan');
    if (r.core) { this.setState({ sync: { networks: {} } }); return this.watch(); }
    this.setState({ plan: r, prune: !!(r.disk && !r.disk.networks.testnet4.full) });
  }
  pickServer(v) {
    const s = (this.props.st.electrum || [])[v];
    this.setState(s ? { pick: v, host: s.host, port: String(s.port), tls: s.tls !== false } : { pick: v });
  }
  body() {
    const s = this.state;
    return s.kind === 'core'
      ? { kind: 'core', url: s.url.trim(), ...(s.cookie.trim() ? { cookiePath: s.cookie.trim() } : { user: s.user, password: s.pass }) }
      : { kind: 'electrum', host: s.host.trim(), port: Number(s.port), tls: s.tls };
  }
  async test() {
    this.setState({ busy: true, msg: { ok: true, text: 'Testing...' } });
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
  async install() {
    this.setState({ installing: true, msg: { ok: true, text: 'Downloading and checking Bitcoin Core…' } });
    const r = await this.props.post('/api/core/install', { prune: this.state.prune, mainnet: this.state.mainnet });
    if (!r.ok) return this.setState({ installing: false, msg: said(r) });
    this.setState({ msg: { ok: true, text: 'Bitcoin Core runs and syncs.' }, sync: { networks: {} } });
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
    clearTimeout(this.timer); this.timer = setTimeout(this.watch, this.props.pollMs || 15000);
  }
  syncRows() {
    const nets = Object.entries((this.state.sync && this.state.sync.networks) || {}).filter(([k]) => k === 'testnet4' || k === 'mainnet');
    return nets.map(([n, x]) => (
      <div key={n} className="role"><div style={{ flex: 1 }}>{x.ok ? <>
        <b>{n}</b> - block {x.blocks.toLocaleString('en')} of {x.headers.toLocaleString('en')} · {(x.progress * 100).toFixed(2)} % · {x.synced ? <b>synced</b> : `${dur(x.etaMs)} left`}
        <div className="bar"><i style={{ width: `${(x.progress * 100).toFixed(2)}%` }} /></div></> : <><b>{n}</b> - {x.why}</>}</div></div>));
  }
  installForm() {
    const { plan, prune, mainnet, installing, sync } = this.state;
    if (sync) return (
      <div id="sync">
        <p className="sub">Bitcoin Core is installed on this machine and syncs.</p>
        <p className="warn"><b>Bookmark this page.</b> The first sync can take hours on testnet4 and days on mainnet. You can close this page and come back; setup continues here once testnet4 is synced. Keep the installer running (this terminal), or start it again later.</p>
        {this.syncRows()}
      </div>);
    if (!plan) return <p className="sub">Checking this machine…</p>;
    if (plan.installed) return <p className="sub">Bitcoin Core is installed here already (<code>{plan.installed}</code>): choose <b>My Bitcoin Core</b> and connect it.</p>;
    const d = plan.disk, n = plan.needs;
    return (
      <div>
        <p className="sub">Free on this disk: <b>{gb(d.freeBytes)}</b>. Needed: testnet4 {gb(n.testnet4.fullBytes)} (pruned {gb(n.testnet4.prunedBytes)}), mainnet {gb(n.mainnet.fullBytes)} (pruned {gb(n.mainnet.prunedBytes)}).</p>
        {d.warn ? <p className="warn">{d.warn}</p> : <p className="sub">Enough for both full nodes.</p>}
        <label className="choice"><input type="checkbox" checked={prune} onChange={(e) => this.setState({ prune: e.target.checked })} /><div><b>Pruned</b><p>Keeps the chain state and only the newest blocks: a few GB instead of the whole chain. Your node works the same.</p></div></label>
        <label className="choice"><input type="checkbox" checked={mainnet} onChange={(e) => this.setState({ mainnet: e.target.checked })} /><div><b>Also mainnet</b><p>A second Bitcoin Core for mainnet, for later. The Arena runs on testnet4 now.</p></div></label>
        <button type="button" disabled={installing} onClick={this.install}>Install and start syncing</button>
      </div>);
  }
  render() {
    const s = this.state; const servers = this.props.st.electrum || [];
    const kinds = [['core', 'My Bitcoin Core', '₿'], ['electrum', 'Electrum server', '🔌'], ['install', 'Install Bitcoin Core for me', '⬇️']];
    return (
      <div className="aw">
        <h2>1. Bitcoin connection</h2>
        <p className="sub">Your node reads the testnet4 chain. Use your own Bitcoin Core, or an Electrum server.</p>
        <div className="kinds">{kinds.map(([k, t, ic]) => (
          <button key={k} type="button" id={`k-${k}`} className={`kind${s.kind === k ? ' on' : ''}`} onClick={() => this.kind(k)}><span aria-hidden="true">{ic}</span> {t}</button>))}</div>
        {s.kind === 'core' ? <div>
          <label htmlFor="c-url">RPC URL</label><input id="c-url" value={s.url} onChange={(e) => this.setState({ url: e.target.value })} />
          <label htmlFor="c-cookie">Cookie file (or leave empty and give user and password)</label><input id="c-cookie" placeholder="~/.bitcoin/testnet4/.cookie" value={s.cookie} onChange={(e) => this.setState({ cookie: e.target.value })} />
          <div className="row"><div><label htmlFor="c-user">RPC user</label><input id="c-user" value={s.user} onChange={(e) => this.setState({ user: e.target.value })} /></div>
            <div><label htmlFor="c-pass">RPC password</label><input id="c-pass" type="password" value={s.pass} onChange={(e) => this.setState({ pass: e.target.value })} /></div></div>
        </div> : null}
        {s.kind === 'electrum' ? <div>
          <label htmlFor="e-pick">Server</label>
          <select id="e-pick" value={s.pick} onChange={(e) => this.pickServer(e.target.value)}>
            {servers.map((x, i) => <option key={i} value={String(i)}>{x.host}:{x.port}{x.tls ? ' (TLS)' : ''} - {x.note}</option>)}<option value="own">another server</option></select>
          <div className="row"><div><label htmlFor="e-host">Host</label><input id="e-host" value={s.host} onChange={(e) => this.setState({ host: e.target.value })} /></div>
            <div><label htmlFor="e-port">Port</label><input id="e-port" value={s.port} onChange={(e) => this.setState({ port: e.target.value })} /></div></div>
          <label className="choice"><input type="checkbox" checked={s.tls} onChange={(e) => this.setState({ tls: e.target.checked })} /><div><b>TLS</b></div></label>
          <p className="sub">In Electrum mode a small bridge on this machine reads headers from the server and verified blocks from Esplora.</p>
        </div> : null}
        {s.kind === 'install' ? this.installForm() : <div>
          <button type="button" className="ghost" disabled={s.busy} onClick={this.test}>Test</button>
          <button type="button" disabled={s.busy} onClick={this.save}>Save and go on</button></div>}
        <Msg r={s.msg} />
      </div>
    );
  }
}

// THE WAYS IN, most permanent first; the direct test picks the default (direct when it reached this machine, the permanent tunnel when not)
export const REACH_MODES = Object.freeze(['direct', 'permanent', 'tailscale', 'workers', 'quick']);
export const defaultMode = (direct) => (direct ? (direct.reached ? 'direct' : 'permanent') : null);
export const directText = (d) => (d.reached ? `Reachable from outside at ${d.address}:${d.port} - direct connection is the default.`
  : `Not reachable from outside: ${d.diagnosis ? d.diagnosis.advice : d.why}\nThe permanent tunnel is the default.`);

export class ReachStep extends React.Component {
  constructor(props) {
    super(props);
    const st = props.st;
    this.state = { port: String((st.direct && st.direct.port) || st.defaultPort || ''), direct: st.direct || null, mode: defaultMode(st.direct), host: '', cfToken: '',
      login: st.login || null, testing: false, saving: false, directMsg: null, loginMsg: null, msg: null, ...(props.initial || {}) };
    this.test = this.test.bind(this); this.login = this.login.bind(this); this.save = this.save.bind(this); this.pollLogin = this.pollLogin.bind(this);
  }
  componentWillUnmount() { this.gone = true; clearTimeout(this.timer); }
  async test() {
    this.setState({ testing: true, directMsg: { ok: true, text: 'Asking Arena nodes to connect back to this machine...' } });
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
    return l.url ? <div className="msg ok">Open <a href={l.url} target="_blank" rel="noopener noreferrer">this Cloudflare link</a>, sign up or log in, and choose the domain for your node. This page waits for you.</div> : null;
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
        <h2>6. How others reach your node</h2>
        <p className="sub">Players and other nodes connect to your node. First the installer checks whether the internet can reach this machine directly.</p>
        <div className="row"><div><label htmlFor="r-port">Port for connections from outside</label><input id="r-port" value={port} onChange={(e) => this.setState({ port: e.target.value })} /></div></div>
        <button type="button" className="ghost" id="r-test" disabled={testing} onClick={this.test}>Test direct connection</button>
        {directMsg ? <Msg r={directMsg} /> : direct ? <div className={`msg ${direct.reached ? 'ok' : 'bad'}`}>{directText(direct)}</div> : null}
        <div className="choices">
          {this.option('direct', 'Direct connection', 'Your node listens on the port above. Needs the port open in the firewall and, behind a router, forwarded to this machine.', null, rec === 'direct' ? 'recommended' : null)}
          {this.option('permanent', 'Permanent Cloudflare tunnel', 'A fixed https name such as node.example.com, through your own free Cloudflare account and a domain on it (Cloudflare sells one for a few dollars a year). No open ports. No domain? Choose workers.dev or Tailscale Funnel below.', <>
            <button type="button" className="ghost" onClick={this.login}>Sign up / log in to Cloudflare</button>{this.loginLine()}
            <label htmlFor="r-host">Your node's name (under a domain on that account)</label>
            <input id="r-host" placeholder="node.example.com" value={host} onChange={(e) => this.setState({ host: e.target.value })} /></>, rec === 'permanent' ? 'recommended' : null)}
          {this.option('tailscale', 'Permanent Tailscale Funnel', 'A fixed https name such as my-pc.tail1234.ts.net from your free Tailscale account - no domain needed, no open ports. Install Tailscale and log in (tailscale up) first; Funnel must be allowed for this machine in your tailnet.')}
          {this.option('workers', 'Permanent Cloudflare name, no domain (workers.dev)', 'A fixed name such as arena-node-1a2b3c.yourname.workers.dev on your own free Cloudflare account, no open ports: a small Worker there forwards to your node\'s tunnel and your node keeps it pointed at it. Free up to 100,000 requests a day (Workers Paid: $5 a month).', <>
            <p>1. <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">Create an API token</a> from the template <b>Edit Cloudflare Workers</b>, with your account. 2. Paste it here:</p>
            <label htmlFor="r-cftoken">Cloudflare API token</label>
            <input id="r-cftoken" type="password" autoComplete="off" placeholder="the token Cloudflare shows once" value={cfToken} onChange={(e) => this.setState({ cfToken: e.target.value })} /></>)}
          {this.option('quick', 'Temporary anonymous tunnel', 'A random trycloudflare.com name, no account. It changes whenever the tunnel restarts, so others lose your node until it is announced again.')}
        </div>
        <button type="button" disabled={saving} onClick={this.save}>Save and go on</button>
        <Msg r={msg} />
      </div>
    );
  }
}

export class ServiceStep extends React.Component {
  constructor(props) {
    super(props);
    this.state = { boot: true, busy: false, template: null, msg: null, ...(props.initial || {}) };
    this.start = this.start.bind(this); this.nostrLogin = this.nostrLogin.bind(this);
  }
  async start() {
    this.setState({ busy: true, msg: { ok: true, text: 'Installing and starting the node (this can take a minute)...' } });
    const r = await this.props.post('/api/service', { boot: this.state.boot });
    this.setState({ busy: false });
    if (!r.ok) return this.setState({ msg: said(r) });
    if (r.template) return this.setState({ template: r.template, msg: { ok: true, text: `The node runs (started in ${r.ms} ms). Now log in once with your Nostr key.` } });
    this.props.reload();
  }
  async nostrLogin() {
    const nostr = this.props.nostr || (typeof window !== 'undefined' ? window.nostr : null);
    if (!nostr) return this.setState({ msg: said({ ok: false, why: 'no Nostr extension in this browser: use one that has your key' }) });
    const ev = await nostr.signEvent({ ...this.state.template, created_at: Math.floor(Date.now() / 1000) });
    const r = await this.props.post('/api/owner/login', { nostr: ev });
    if (r.ok) return this.props.reload();
    this.setState({ msg: said(r) });
  }
  render() {
    const { boot, busy, template, msg } = this.state;
    return (
      <div className="aw">
        <h2>7. Install and start</h2>
        <p>The node is installed as a user service, started, checked at its public address, and then you are logged in once as its owner.</p>
        <label className={`choice${boot ? ' on' : ''}`}><input type="checkbox" id="boot" checked={boot} onChange={(e) => this.setState({ boot: e.target.checked })} />
          <div><b>Start the node again after a reboot</b><p>Recommended. It also keeps the node running when you log out.</p></div></label>
        {template ? <button type="button" onClick={this.nostrLogin}>Log in with Nostr</button>
          : <button type="button" id="svc" disabled={busy} onClick={this.start}>{busy ? 'Installing…' : 'Install and start'}</button>}
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
        <h2>9. Your federation</h2>
        <div className="fed-explain">
          <FedRing />
          <div>
            <p className="big">A <b>federation</b> is a group of <b>10 nodes</b> that hold the players' bitcoin <b>together</b>.</p>
            <p>🔒 Moving any of it takes <b>7 of the 10</b>. No single node - not yours either - can take it.</p>
            <p>⚡ Its two gateways connect it to Lightning; every guardian earns a share of each round.</p>
          </div>
        </div>
        <p className="big">How your node gets its seat - <b>automatically</b>, whichever comes first:</p>
        <div className="choices">
          <div className="choice"><div><b>✨ A new federation</b><p>Your node and <b>9 other new nodes</b> are drawn to start one together.</p></div></div>
          <div className="choice"><div><b>🔄 A seat in a successor</b><p>When a federation shrinks (a guardian leaves), a new one takes over its players' bitcoin: its remaining guardians first, the missing seats <b>drawn</b> from nodes like yours.</p></div></div>
        </div>
        <p className="sub">Nobody is invited and nobody picks: the draw is fixed by the chain, so no one can choose who guards the money. A full federation takes no new guardian.</p>
        <button type="button" disabled={this.state.busy} onClick={this.go}>Continue</button>
        <Msg r={this.state.msg} />
      </div>
    );
  }
}
