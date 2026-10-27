// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S SERVICES, IN REACT (kanban #564; the list and controls of kanban #563): every service the node runs or reaches -
// on an installed node and on one set up by hand - each with what it answers, its Start / Stop / Restart where the node can do it, and
// whether it starts at boot. Read and changed through the owner's signed requests (POST /owner/services, POST /owner/service).
import React from 'react';
import { Switch } from '../design/components.jsx';

const LABEL = Object.freeze({ start: 'Start', stop: 'Stop', restart: 'Restart' });
/** A row's light: green it answers, red it does not, grey unknown. */
export const lightOf = (s) => {
  if (s.later) return '⚪';
  const ok = s.running === null || s.running === undefined ? null : !s.running ? false : s.probe ? s.probe.ok : true;
  return ok === null ? '⚪' : ok ? '🟢' : '🔴';
};
/** A service's state: up (answers), down (stopped or not answering), unknown. */
// LEFT FOR LATER (the owner 2026-10-27: "1 service not running" for a gateway set up later on purpose): its own word, and no attention
export const stateOf = (s) => (s.later ? 'later' : s.running === null || s.running === undefined ? 'unknown' : !s.running ? 'down' : s.probe && !s.probe.ok ? 'down' : 'up');
export const STATE_WORD = Object.freeze({ up: 'Running', down: 'Needs attention', unknown: 'Unknown', later: 'Left for later' });
export const needsAttention = (rows) => rows.filter((s) => !s.later && (s.running === false || (s.running && s.probe && !s.probe.ok))).length;

export class ServicesPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, answer: null, busy: null, message: null, ...(props.initial || {}) };
    this.reload = this.reload.bind(this);
  }
  componentDidMount() { if (!this.state.loaded && this.props.api) this.reload(); }
  componentWillUnmount() { clearTimeout(this.timer); clearTimeout(this.fixTimer); }
  async reload() {
    let r; try { r = await this.props.api.post('/owner/services', await this.props.api.signed('services')); } catch (e) { r = { ok: false, why: e.message }; }
    this.setState({ loaded: true, answer: r, busy: null });
    // a fix running (kanban #711: the gateway being set up): asked again every 10 s until it is done
    clearTimeout(this.fixTimer);
    if (r && r.ok && r.services.some((x) => x.fix && x.fix.busy)) this.fixTimer = setTimeout(this.reload, 10000);
    // the page's own badge for the section (its sidebar dot), told how many need attention
    if (this.props.onAttention && r && r.ok) this.props.onAttention(needsAttention(r.services));
    // and the rows themselves, so the Overview's Custody says what this card says (the 2026.1.9.11 install test: "Custody: Guardian" in
    // green while the guardian had not started)
    if (this.props.onServices && r && r.ok) this.props.onServices(r.services);
  }
  async act(id, action) {
    this.setState({ busy: `${id}:${action}`, message: null });
    let x; try { x = await this.props.api.post('/owner/service', await this.props.api.signed('service', { id, action })); } catch (e) { x = { ok: false, why: e.message }; }
    if (!x || !x.ok) return this.setState({ busy: null, message: `${id}: ${(x && x.why) || 'not done'}` });
    clearTimeout(this.timer);
    this.timer = setTimeout(this.reload, x.restarting ? 8000 : 800);
  }
  // A FIX ON THE CARD (kanban #711): what is missing set up by the node itself (POST /owner/<action>), never a command to type
  async fix(s) {
    this.setState({ busy: `${s.id}:fix`, message: null });
    let x; try { x = await this.props.api.post(`/owner/${s.fix.action}`, await this.props.api.signed(s.fix.action)); } catch (e) { x = { ok: false, why: e.message }; }
    if (!x || !x.ok) return this.setState({ busy: null, message: `${s.title}: ${(x && x.why) || 'not done'}` });
    clearTimeout(this.timer);
    this.timer = setTimeout(this.reload, 1500);
  }
  /** One service as a card: its light, its name, running or not, what it answers, its actions and whether it starts at boot. */
  card(s) {
    const { busy } = this.state;
    const tone = stateOf(s);
    return (
      <div key={s.id} className={`svc-card ${tone}`} id={`svc-${s.id}`}>
        <div className="svc-head"><span className={`led ${tone}`} aria-hidden="true" /><b className="svc-name">{s.title}</b>
          <span className={`pill${tone === 'up' ? ' on' : tone === 'down' ? ' bad' : ''}`}>{STATE_WORD[tone]}</span></div>
        <p className="svc-says">{s.probe && s.running !== null ? s.probe.says : s.detail}{s.pid ? <span className="svc-pid"> · pid {s.pid}</span> : null}</p>
        {(s.controls || []).length || s.bootSettable ? (
          <div className="svc-foot">
            <span className="svc-btns">{(s.controls || []).map((c) => <button key={c} type="button" className="mini" disabled={busy === `${s.id}:${c}`} onClick={() => this.act(s.id, c)}>{LABEL[c]}</button>)}</span>
            {s.bootSettable ? <label className="boot"><span>At boot</span><Switch id={`boot-${s.id}`} label={`${s.title}: start at boot`} checked={!!s.atBoot} onChange={(on) => this.act(s.id, on ? 'boot-on' : 'boot-off')} /></label> : null}
          </div>) : s.why ? <p className="svc-why">{s.why}</p> : null}
        {s.fix ? <div className="svc-foot"><span className="svc-btns"><button type="button" className="mini" disabled={s.fix.busy || busy === `${s.id}:fix`} onClick={() => this.fix(s)}>{s.fix.label}</button></span></div> : null}
      </div>
    );
  }
  render() {
    const { loaded, answer: r, message } = this.state;
    if (!loaded) return <p className="sub">reading this node's services…</p>;
    if (!r || !r.ok) return <p className="sub">{(r && r.why) || 'not readable'}</p>;
    const bad = needsAttention(r.services);
    const up = r.services.filter((s) => stateOf(s) === 'up').length;
    const groups = [['On this machine', r.services.filter((s) => !s.inside)], ['Inside the node', r.services.filter((s) => s.inside)]].filter(([, xs]) => xs.length);
    return (
      <div>
        <div className={`summary ${bad ? 'bad' : 'good'}`}>
          <div><b>{bad ? `${bad} need${bad === 1 ? 's' : ''} attention` : 'Everything runs'}</b><span className="sub">{up} of {r.services.length} services answer</span></div>
          <button type="button" className="mini" onClick={this.reload}>Check again</button>
        </div>
        {message ? <p className="warn">{message}</p> : null}
        {groups.map(([title, xs]) => (
          <React.Fragment key={title}><h3 className="sh">{title}</h3><div className="svc-grid">{xs.map((s) => this.card(s))}</div></React.Fragment>))}
        {/* no commands to type (owner-page rule, 2026-10-20; kanban #563): an installed node's every service is started, stopped and
            set to start at boot on its card above; only a node set up by hand has services outside it the node cannot start */}
        {r.command ? null : <p className="sub">Set up by hand. Start and stop these on their own machine.</p>}
      </div>
    );
  }
}
