// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S ADDRESS, IN REACT (kanban #564; the address card of kanban #563 / #562 2C, 2026-10-21 "1 default"): where
// the node is reached and how, a warning while it changes at every restart, and the switch to another way - the node runs the installer's
// own steps for it (POST /owner/reach, signed) and restarts; the progress is read again until done, with the Cloudflare login link while
// it waits for it. A stable address is the default.
import React from 'react';
import { Button } from '../design/components.jsx';

/** Each way in: its name and icon. */
export const MODE = Object.freeze({ quick: ['Quick tunnel', '⚡'], permanent: ['Your own domain', '🏷️'], workers: ['workers.dev name', '☁️'], tailscale: ['Tailscale Funnel', '🔗'], direct: ['Direct (open port)', '🔌'], tor: ['Tor', '🧅'] });
export const running = (p) => !!(p && (p.state === 'running' || p.state === 'login'));
/** What /owner/reach is asked for a mode: workers takes the Cloudflare token, permanent the hostname. */
export function argsOf(mode, { cfToken = '', cfSubdomain = '', hostname = '' } = {}) {
  return { mode, ...(mode === 'workers' ? { cfToken: cfToken.trim(), cfSubdomain: cfSubdomain.trim() || null } : {}), ...(mode === 'permanent' ? { hostname: hostname.trim() } : {}) };
}

export class AddressPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, answer: null, mode: null, cfToken: '', cfSubdomain: '', hostname: '', busy: false, message: null, ...(props.initial || {}) };
    this.read = this.read.bind(this); this.go = this.go.bind(this);
  }
  componentDidMount() { if (!this.state.loaded && this.props.api) this.read(); }
  componentWillUnmount() { clearTimeout(this.timer); }
  async read() {
    let r; try { r = await this.props.api.post('/owner/reach', await this.props.api.signed('reach')); } catch (e) { r = { ok: false, why: e.message }; }
    this.setState((s) => ({ loaded: true, answer: r, mode: s.mode || (r && r.mode) || null, busy: false }));
    clearTimeout(this.timer);
    if (r && r.ok && running(r.progress)) this.timer = setTimeout(this.read, this.props.pollMs || 5000);
  }
  async go() {
    this.setState({ busy: true, message: null });
    let x; try { x = await this.props.api.post('/owner/reach', await this.props.api.signed('reach', argsOf(this.state.mode, this.state))); } catch (e) { x = { ok: false, why: e.message }; }
    if (!x || !x.ok) return this.setState({ busy: false, message: (x && x.why) || 'not started' });
    await this.read();
  }
  progress(p) {
    if (!p) return null;
    if (p.state === 'login') return <p className="sub">Log in to Cloudflare to go on: <a href={p.loginUrl} target="_blank" rel="noopener noreferrer">open the login</a></p>;
    if (p.state === 'running') return <p className="sub">Switching to {p.mode}…</p>;
    if (p.state === 'done') return <p className="ok">Switched to {p.mode}: {p.url}</p>;
    return <p className="err">The switch to {p.mode} failed: {p.why}</p>;
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
        {this.progress(r.progress)}
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
                    {on && k === 'permanent' ? <span className="choice-fields">{field('hostname', 'node.example.com (a domain on your Cloudflare account)')}</span> : null}
                  </span>
                </label>);
            })}</div>
            <Button primary disabled={busy || !mode || mode === r.mode} onClick={this.go}>{busy ? 'Switching…' : mode && mode !== r.mode ? `Switch to ${(MODE[mode] || [mode])[0]}` : 'Choose another way'}</Button>
            {message ? <p className="err">{message}</p> : null}
          </div>
        )}
      </div>
    );
  }
}
