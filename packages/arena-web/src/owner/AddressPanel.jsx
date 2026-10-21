// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S ADDRESS, IN REACT (kanban #564; the address card of kanban #563 / #562 2C, the owner 2026-10-21 "1 default"): where
// the node is reached and how, a warning while it changes at every restart, and the switch to another way - the node runs the installer's
// own steps for it (POST /owner/reach, signed) and restarts; the progress is read again until done, with the Cloudflare login link while
// it waits for it. A stable address is the default.
import React from 'react';
import { Button } from '../design/components.jsx';

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
  render() {
    const { loaded, answer: r, mode, busy, message } = this.state;
    if (!loaded) return <p className="sub">reading how this node is reached…</p>;
    if (!r || !r.ok) return <p className="sub">{r && /not installed by the Arena installer/.test(r.why || '') ? 'This node was set up by hand: its address is set on its machine.' : (r && r.why) || 'not readable'}</p>;
    const field = (k, placeholder) => <input key={k} placeholder={placeholder} style={{ marginTop: 6 }} value={this.state[k]} onChange={(e) => this.setState({ [k]: e.target.value })} />;
    return (
      <div>
        <div className="row"><span>Reached at</span><b>{r.url || r.serving || '-'}</b></div>
        <div className="row"><span>How</span><b>{r.mode || '-'}{r.stable ? ' · stable' : ' · changes at every restart'}</b></div>
        {r.stable ? null : <p className="warnline">This address changes when the node restarts. The node tells the network its new one by itself, but a stable address is better: choose one below.</p>}
        {this.progress(r.progress)}
        {running(r.progress) ? null : (
          <div>
            <label>Switch to <select value={mode || ''} onChange={(e) => this.setState({ mode: e.target.value })}>
              {Object.entries(r.modes || {}).map(([k, v]) => <option key={k} value={k}>{k}: {v}</option>)}
            </select></label>
            {mode === 'workers' ? [field('cfToken', 'Cloudflare API token (Workers edit)'), field('cfSubdomain', 'workers.dev subdomain (optional)')] : null}
            {mode === 'permanent' ? field('hostname', 'node.example.com (a domain on your Cloudflare account)') : null}
            <Button primary disabled={busy} onClick={this.go}>Switch</Button>
            {message ? <p className="err">{message}</p> : null}
          </div>
        )}
      </div>
    );
  }
}
