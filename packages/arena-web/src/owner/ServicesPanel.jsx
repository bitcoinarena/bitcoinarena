// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S SERVICES, IN REACT (kanban #564; the list and controls of kanban #563): every service the node runs or reaches -
// on an installed node and on one set up by hand - each with what it answers, its Start / Stop / Restart where the node can do it, and
// whether it starts at boot. Read and changed through the owner's signed requests (POST /owner/services, POST /owner/service).
import React from 'react';
import { Switch, Button } from '../design/components.jsx';

const LABEL = Object.freeze({ start: 'Start', stop: 'Stop', restart: 'Restart' });
/** A row's light: green it answers, red it does not, grey unknown. */
export const lightOf = (s) => {
  const ok = s.running === null || s.running === undefined ? null : !s.running ? false : s.probe ? s.probe.ok : true;
  return ok === null ? '⚪' : ok ? '🟢' : '🔴';
};
export const needsAttention = (rows) => rows.filter((s) => s.running === false || (s.running && s.probe && !s.probe.ok)).length;

export class ServicesPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, answer: null, busy: null, message: null, ...(props.initial || {}) };
    this.reload = this.reload.bind(this);
  }
  componentDidMount() { if (!this.state.loaded && this.props.api) this.reload(); }
  componentWillUnmount() { clearTimeout(this.timer); }
  async reload() {
    let r; try { r = await this.props.api.post('/owner/services', await this.props.api.signed('services')); } catch (e) { r = { ok: false, why: e.message }; }
    this.setState({ loaded: true, answer: r, busy: null });
    // the page's own badge for the section (its sidebar dot), told how many need attention
    if (this.props.onAttention && r && r.ok) this.props.onAttention(needsAttention(r.services));
  }
  async act(id, action) {
    this.setState({ busy: `${id}:${action}`, message: null });
    let x; try { x = await this.props.api.post('/owner/service', await this.props.api.signed('service', { id, action })); } catch (e) { x = { ok: false, why: e.message }; }
    if (!x || !x.ok) return this.setState({ busy: null, message: `${id}: ${(x && x.why) || 'not done'}` });
    clearTimeout(this.timer);
    this.timer = setTimeout(this.reload, x.restarting ? 8000 : 800);
  }
  row(s) {
    const { busy } = this.state;
    const ctl = (s.controls || []).length || s.bootSettable;
    return (
      <div key={s.id} className="svc">
        <div className="row"><span>{lightOf(s)} {s.title}{s.inside ? <span className="sub"> (inside the node)</span> : null}</span>
          <b>{s.running === null || s.running === undefined ? 'unknown' : s.running ? 'running' : 'stopped'}</b></div>
        <p className="sub" style={{ margin: '-4px 0 6px 26px' }}>{s.probe && s.running !== null ? s.probe.says : s.detail}{s.pid ? ` · pid ${s.pid}` : ''}</p>
        {ctl ? (
          <div className="svc-ctl">
            {(s.controls || []).map((c) => <Button key={c} disabled={busy === `${s.id}:${c}`} onClick={() => this.act(s.id, c)}>{LABEL[c]}</Button>)}
            {s.bootSettable ? [<Switch key="b" id={`boot-${s.id}`} label={`${s.title}: start at boot`} checked={!!s.atBoot} onChange={(on) => this.act(s.id, on ? 'boot-on' : 'boot-off')} />,
              <span key="l" className="sub">at boot</span>] : null}
          </div>
        ) : s.why ? <p className="sub" style={{ margin: '-2px 0 8px 26px' }}>{s.why}</p> : null}
      </div>
    );
  }
  render() {
    const { loaded, answer: r, message } = this.state;
    if (!loaded) return <p className="sub">reading this node's services…</p>;
    if (!r || !r.ok) return <p className="sub">{(r && r.why) || 'not readable'}</p>;
    const bad = needsAttention(r.services);
    return (
      <div>
        {r.services.map((s) => this.row(s))}
        <p className={bad ? 'err' : 'ok'}>{bad ? `${bad} service(s) need attention.` : 'All services run.'}</p>
        {message ? <p className="warn">{message}</p> : null}
        <p className="sub">{r.command ? <>On the node's machine: <code>{r.command} status</code>, <code>{r.command} doctor</code>, <code>{r.command} restart &lt;service&gt;</code>.</> : 'Set up by hand: what runs outside the node is started and stopped on its machine.'}</p>
        <p><Button onClick={this.reload}>Check again</Button></p>
      </div>
    );
  }
}
