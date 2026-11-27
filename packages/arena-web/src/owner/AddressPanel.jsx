// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S ADDRESS, IN REACT (kanban #564; the address card of kanban #563 / #562 2C, 2026-10-21 "1 default"): where
// the node is reached and how, a warning while it changes at every restart, and the switch to another way - the node runs the installer's
// own steps for it (POST /owner/reach, signed) and restarts; the progress is read again until done, with the Cloudflare login link while
// it waits for it. A stable address is the default.
import React from 'react';
import { Button } from '../design/components.jsx';
import { addressRefusal, ADDRESS_HOW_TO } from '../../../arena-node/src/address-rules.js';   // kanban #3887

/** Each way in: its name and icon. */
export const MODE = Object.freeze({ quick: ['Quick tunnel', '⚡'], permanent: ['Your own domain', '🏷️'], workers: ['workers.dev name', '☁️'], tailscale: ['Tailscale Funnel', '🔗'], direct: ['Direct (open port)', '🔌'], tor: ['Tor', '🧅'] });
const a0 = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
export const running = (p) => !!(p && (p.state === 'running' || p.state === 'login'));
/** What /owner/reach is asked for a mode: workers takes the Cloudflare token, permanent the hostname. */
export function argsOf(mode, { cfToken = '', cfSubdomain = '', hostname = '' } = {}) {
  return { mode, ...(mode === 'workers' ? { cfToken: cfToken.trim(), cfSubdomain: cfSubdomain.trim() || null } : {}), ...(mode === 'permanent' ? { hostname: hostname.trim() } : {}) };
}

export class AddressPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, answer: null, mode: null, cfToken: '', cfSubdomain: '', hostname: '', busy: false, message: null, ...(props.initial || {}) };
    this.read = this.read.bind(this); this.go = this.go.bind(this); this.adopt = this.adopt.bind(this);
  }
  // TAKE PUBLIC_URL AS THE ADDRESS (kanban #3885): arena.conf names another address than the advertisement - the node posts the update
  async adopt(url) {
    this.setState({ busy: true, message: null });
    let x; try { x = await this.props.api.post('/owner/reach', await this.props.api.signed('reach', { adopt: url })); } catch (e) { x = { ok: false, why: e.message }; }
    if (!x || !x.ok) return this.setState({ busy: false, message: (x && x.why) || 'not started' });
    await this.read();
  }
  mismatch(r) {
    const m = r.follow && r.follow.mismatch;
    if (!m || !m.confDiffers) return null;   // the census alone behind: the lines below say it, with the update's progress
    const a = r.follow.adopt && String(a0(r.follow.adopt.url)) === String(a0(m.conf)) ? r.follow.adopt : null;
    return (
      <div className="addr-mismatch" data-check="mismatch">
        <p className="err"><b>Your node's address and its advertisement differ.</b> {m.confDiffers ? <>public_url in arena.conf is <code>{m.conf}</code>, but the network sends players and other nodes to <code>{(m.advertised && m.advertised.length ? m.advertised : [m.installer]).join(', ')}</code>.</> : <>This node runs on <code>{m.conf}</code>, but the network still names <code>{(m.advertised || []).join(', ')}</code>.</>} Changing public_url and restarting is not enough: the network reads the address from the advertisement on chain.</p>
        {m.adoptable ? <p><Button primary disabled={this.state.busy} onClick={() => this.adopt(m.conf)}>{this.state.busy ? 'Posting…' : `Post the advertisement update for ${m.conf}`}</Button></p>
          : m.quick ? <p className="sub">A quick tunnel's address changes at every restart and is never put on chain: choose a stable address below.</p>
          : m.refusal ? <p className="err" data-check="refusal">This address cannot be used: {m.refusal.why}. <span className="sub">{m.refusal.howTo}</span></p>
          : !m.bonded ? <p className="sub">This node has no bond yet: its bond's advertisement will name the address it runs on.</p> : null}
        {a && !a.ok ? <p className="err">Not posted: {a.why}</p> : null}
      </div>);
  }
  componentDidMount() { if (!this.state.loaded && this.props.api) this.read(); }
  componentWillUnmount() { clearTimeout(this.timer); }
  async read() {
    let r; try { r = await this.props.api.post('/owner/reach', await this.props.api.signed('reach')); } catch (e) { r = { ok: false, why: e.message }; }
    // A FAILED READ IS ASKED AGAIN, NOT SHOWN FOR GOOD (kanban #956: "after first log in, the public address block is always marked as error
    // and only a page reload shows the correct info"): the first login opens every panel at once, each with a signed request, and one that
    // fails left its error until a reload. While tries are left the panel keeps saying it is reading; a node set up by hand is said at once.
    const byHand = !!(r && !r.ok && /not installed by the Arena installer/.test(r.why || ''));
    const tries = (this.tries || 0) + 1;
    if (r && !r.ok && !byHand && tries < (this.props.retries || 6) && !this.state.answer?.ok) {
      this.tries = tries;
      clearTimeout(this.timer);
      this.timer = setTimeout(this.read, (this.props.retryMs || 2000) * tries);
      return;
    }
    this.tries = 0;
    this.setState((s) => ({ loaded: true, answer: r, mode: s.mode || (r && r.mode) || null, busy: false }));
    clearTimeout(this.timer);
    if (r && r.ok && running(r.progress)) this.timer = setTimeout(this.read, this.props.pollMs || 5000);
  }
  async go() {
    this.setState({ busy: true, message: null });
    let x; try { x = await this.props.api.post('/owner/reach', await this.props.api.signed('reach', argsOf(this.state.mode, this.state))); } catch (e) { x = { ok: false, why: e.message }; }
    if (!x || !x.ok) return this.setState({ busy: false, message: [(x && x.why) || 'not started', x && x.howTo].filter(Boolean).join('. ') });
    await this.read();
  }
  // THE NAME TYPED, CHECKED AS IT IS TYPED (kanban #3887): https on 443, a name with a certificate - why not, before anything is started
  hostnameRefusal() {
    const h = String(this.state.hostname || '').trim().replace(/^https?:\/\//i, '');
    return h ? addressRefusal(`https://${h}`) : null;
  }
  progress(p) {
    if (!p) return null;
    if (p.state === 'login') return <p className="sub">Log in to Cloudflare to go on: <a href={p.loginUrl} target="_blank" rel="noopener noreferrer">open the login</a></p>;
    if (p.state === 'running') return <p className="sub">Switching to {p.mode}…</p>;
    if (p.state === 'done') return <p className="ok">Switched to {p.mode}: {p.url}</p>;
    return <p className="err">The switch to {p.mode} failed: {p.why}</p>;
  }
  // HOW THE NETWORK LEARNS THE ADDRESS (kanban #3565): the seats at once (the node's signed announcement), the census only through an
  // advertisement update about 12 blocks deep - until then the census, and what reads it, name the old address, which stays on meanwhile
  follow(r) {
    const f = r.follow, a = r.announced, lines = [];
    const hours = (m) => (m >= 90 ? `about ${Math.round(m / 60)} hours` : `about ${m} minutes`);
    if (a && a.roots) lines.push(<p key="a" className="sub">{a.took} of {a.roots} seats know this address (the node's signed announcement).</p>);
    if (f && f.censusRead && r.stable && !(f.mismatch && f.mismatch.confDiffers)) {   // public_url edited: "this address" is not the one served
      if (f.censusNamesNew) lines.push(<p key="c" className="ok">The census names this address.</p>);
      else if (f.bonded) {
        lines.push(<p key="c" className="warnline">The census still names {(f.advertised || []).join(', ') || 'another address'}: pages and seats that read it go there until it names this one.</p>);
        if (f.update && f.update.txid) lines.push(<p key="u" className="sub" data-check="update-progress">An advertisement update naming this address is on its way ({String(f.update.txid).slice(0, 12)}…){f.progress && Number.isInteger(f.progress.depth) ? <>, {Math.min(f.progress.depth, f.progress.need)} of {f.progress.need} confirmations</> : null}: the census takes it about {f.takesBlocks} blocks after it is sent ({f.progress && Number.isInteger(f.progress.depth) ? hours(Math.max(10, f.progress.minutesLeft)) : hours(f.takesMinutes)}{f.progress && Number.isInteger(f.progress.depth) ? ' from now' : ''}).</p>);   // kanban #3889
        else if (f.update && f.update.fee && f.update.fee.enough === false) lines.push(<div key="u" className="err" data-check="fee">   {/* kanban #3888 */}
          <p>Your node's wallet cannot pay the advertisement update yet: it holds {f.update.fee.haveSats} sat and the update needs {f.update.fee.needSats} sat.</p>
          <p>Send at least <b>{f.update.fee.sendSats} sat</b> to <code>{f.update.fee.deposit}</code>. The node posts the update by itself within 10 minutes of the deposit.</p></div>);
        else if (f.update && f.update.why) lines.push(<p key="u" className="err">The advertisement update naming this address could not be posted yet: {f.update.why}. The node tries again every 10 minutes.</p>);
      }
    }
    if (f && f.previous) lines.push(<p key="p" className="sub">The old address {f.previous.url} stays on until the census names the new one, then it is turned off.</p>);
    return lines.length ? <div className="addr-follow">{lines}</div> : null;
  }
  copy(url) { try { navigator.clipboard.writeText(url); this.setState({ copied: true }); } catch { /* no clipboard */ } }
  render() {
    const { loaded, answer: r, mode, busy, message, copied } = this.state;
    if (!loaded) return <p className="sub">reading how this node is reached…</p>;
    if (!r || !r.ok) return <p className="sub">{r && /not installed by the Arena installer/.test(r.why || '') ? 'This node was set up by hand: its address is set on its machine.' : (r && r.why) || 'not readable'}</p>;
    const field = (k, placeholder) => <input key={k} placeholder={placeholder} value={this.state[k]} onChange={(e) => this.setState({ [k]: e.target.value })} />;
    const url = r.url || r.serving || '';
    const modes = Object.entries(r.modes || {});
    return (
      <div className="addr">
        <div className="addr-now">
          <div className="addr-main"><span className="addr-ic" aria-hidden="true">🌐</span>
            <div><code className="addr-url">{url || '-'}</code><div className="sub">{(MODE[r.mode] || [r.mode])[0]}</div></div></div>
          <div className="addr-side"><span className={`pill${r.stable ? ' on' : ' wait'}`}>{r.stable ? 'Stable' : 'Changes at every restart'}</span>
            {url ? <button type="button" className="mini" onClick={() => this.copy(url)}>{copied ? 'Copied ✓' : 'Copy'}</button> : null}</div>
        </div>
        {r.stable ? null : <p className="warnline">This address changes when the node restarts. The node tells the network its new one by itself, but a stable address is better: choose one below.</p>}
        {this.mismatch(r)}
        {this.progress(r.progress)}
        {this.follow(r)}
        {running(r.progress) ? null : (
          <div>
            <h3 className="sh">How others reach this node</h3>
            <div className="choices">{modes.map(([k, v]) => {
              const [title, ic] = MODE[k] || [k, '•'];
              const on = mode === k;
              return (
                <label key={k} className={`choice${on ? ' on' : ''}${r.mode === k ? ' now' : ''}`}>
                  <input type="radio" name="reach-mode" value={k} checked={on} onChange={() => this.setState({ mode: k })} />
                  <span className="choice-ic" aria-hidden="true">{ic}</span>
                  <span className="choice-body"><b>{title}{r.mode === k ? <span className="pill on">now</span> : null}</b><span className="sub">{String(v).replace(/^[^:]+:\s*/, '')}</span>
                    {on && k === 'workers' ? <span className="choice-fields">{field('cfToken', 'Cloudflare API token (Workers edit)')}{field('cfSubdomain', 'workers.dev subdomain (optional)')}</span> : null}
                    {on && k === 'permanent' ? <span className="choice-fields">{field('hostname', 'node.example.com (a domain on your Cloudflare account)')}{this.hostnameRefusal() ? <span className="err" data-check="hostname-refusal">{this.hostnameRefusal().why}</span> : null}</span> : null}
                    {on && k === 'direct' ? <span className="warnline" data-check="direct-warning">Browsers on the https Arena page block an http://IP:port address: put an https name in front of the port. {ADDRESS_HOW_TO}</span> : null}
                  </span>
                </label>);
            })}</div>
            <Button primary disabled={busy || !mode || mode === r.mode || (mode === 'permanent' && !!this.hostnameRefusal())} onClick={this.go}>{busy ? 'Switching…' : mode && mode !== r.mode ? `Switch to ${(MODE[mode] || [mode])[0]}` : 'Choose another way'}</Button>
            {mode && mode !== r.mode && mode !== 'quick' ? <p className="sub">The node tells the seats its new address at once. On chain it posts an advertisement update from its wallet (a small fee): the census names the new address about 12 blocks (about 2 hours) after the switch{['quick', 'permanent', 'workers'].includes(r.mode) && ['tailscale', 'direct'].includes(mode) ? ', and the old address keeps working until then' : ''}.</p> : null}
            {message ? <p className="err">{message}</p> : null}
          </div>
        )}
      </div>
    );
  }
}
