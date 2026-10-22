// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S APPS ON THIS NODE, IN REACT (kanban #564): the games, markets and networks this node runs - each app once, at its
// newest version, the older ones it keeps for rounds that still name them folded away (kanban #553) - its developer's signed description,
// Remove for an installed one (POST /owner/plugins/remove, signed), and the update settings: update automatically, and the nodes updates
// come from (POST /owner/settings, signed). Read from GET /owner/plugins. (Found on the network / look at a node: the next slice.)
import React from 'react';
import { Button, Switch } from '../design/components.jsx';

/** Each app once, its newest version, with the older ones under it. */
export function newestApps(list) {
  const by = new Map();
  for (const g of list || []) {
    const k = g.name || g.title || g.id, had = by.get(k);
    if (!had) { by.set(k, { ...g, older: [] }); continue; }
    if (Number(g.version || 0) > Number(had.version || 0)) by.set(k, { ...g, older: [...had.older, had] }); else had.older.push(g);
  }
  return [...by.values()];
}

/** The developer's signed description and website (https only). */
export class InfoLine extends React.Component {
  render() {
    const i = this.props.info;
    if (!i || (!i.description && !i.website)) return null;
    const site = i.website && /^https:\/\//.test(i.website) ? i.website : null;
    return <div className="sub info">{i.description || ''}{site ? <> <a href={site} target="_blank" rel="noopener noreferrer">{site.replace(/^https:\/\//, '')}</a></> : null} <span title="signed by its developer key">✓ signed</span></div>;
  }
}

export class AppsPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, mine: { hosted: [], installed: [], settings: { autoUpdate: false, sources: [] } }, auto: false, sources: '', saved: false, error: null, ...(props.initial || {}) };
    this.reload = this.reload.bind(this); this.save = this.save.bind(this);
  }
  componentDidMount() { if (!this.state.loaded && this.props.api) this.reload(); }
  async reload() {
    let got = null; try { got = await this.props.api.get('/owner/plugins'); } catch { got = null; }
    // an answer without its lists (a seat still starting) keeps the empty ones
    const mine = { hosted: [], installed: [], ...(got || {}), settings: { autoUpdate: false, sources: [], ...((got && got.settings) || {}) } };
    this.setState({ loaded: true, mine, auto: !!mine.settings.autoUpdate, sources: (mine.settings.sources || []).join('\n'), saved: false });
  }
  async remove(game) {
    try { await this.props.api.post('/owner/plugins/remove', await this.props.api.signed('remove', { game })); await this.reload(); } catch (e) { this.setState({ error: e.message }); }
  }
  async save() {
    try {
      await this.props.api.post('/owner/settings', await this.props.api.signed('settings', { autoUpdate: this.state.auto, sources: this.state.sources.split(/\s+/).filter(Boolean) }));
      this.setState({ saved: true, error: null });
    } catch (e) { this.setState({ error: e.message }); }
  }
  // AN APP'S SPLIT AND ITS CHANGE (kanban #578, ruling A): the developers' shares as a bar; where this node holds the app's developer key,
  // Change split edits it and signs the app's next version with it (POST /owner/apps/split) - other nodes take it as an update
  async sign(g) {
    const e = (this.state.edit || {})[g.id] || [];
    const recipients = e.map((r) => ({ key: r.key.trim().toLowerCase(), label: r.label.trim(), shareBps: Math.round(Number(String(r.share || 0).replace(',', '.')) * 100) }));
    this.setState({ splitSaid: { ...(this.state.splitSaid || {}), [g.id]: null } });
    try {
      const r = await this.props.api.post('/owner/apps/split', await this.props.api.signed('apps/split', { game: g.id, recipients }));
      this.setState({ edit: { ...(this.state.edit || {}), [g.id]: null }, splitSaid: { ...(this.state.splitSaid || {}), [g.id]: { ok: true, text: `Signed ✓ version ${r.version} runs here now; other nodes take it as an update` } } });
      await this.reload();
    } catch (err) { this.setState({ splitSaid: { ...(this.state.splitSaid || {}), [g.id]: { ok: false, text: err.message } } }); }
  }
  split(g, known) {
    const COLORS = ['var(--st)', 'var(--gv)', 'var(--ok)', '#a77bf3', '#e57ab0', '#4fd1c5'];
    const pct = (bps) => `${(Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} %`;
    const edit = (this.state.edit || {})[g.id], said = (this.state.splitSaid || {})[g.id];
    const setRows = (rows) => this.setState({ edit: { ...(this.state.edit || {}), [g.id]: rows } });
    const num = (v) => { const x = Number(String(v || 0).replace(',', '.')); return Number.isFinite(x) ? x : 0; };
    if (!g.split || !g.split.length) return null;
    if (!edit) return (
      <div className="app-split">
        <div className="split-bar">{g.split.map((r, i) => <i key={r.key} title={`${r.label || r.key.slice(0, 12)}: ${pct(r.shareBps)}`} style={{ width: `${Number(r.shareBps) / 100}%`, background: COLORS[i % COLORS.length] }} />)}</div>
        <div className="app-split-who">{g.split.map((r, i) => <span key={r.key}><i style={{ background: COLORS[i % COLORS.length] }} />{r.label || r.key.slice(0, 12) + '…'} <b>{pct(r.shareBps)}</b></span>)}</div>
        {g.canSplit && !g.supersededBy ? <button type="button" className="mini" onClick={() => setRows(g.split.map((r) => ({ key: r.key, label: r.label, share: String(Number(r.shareBps) / 100) })))}>Change split</button> : null}
        {said ? <p className={said.ok ? 'ok' : 'err'}>{said.text}</p> : null}
      </div>);
    const total = Math.round(edit.reduce((t, r) => t + num(r.share), 0) * 100) / 100;
    const edRow = (i, k, v) => { const rows = edit.slice(); rows[i] = { ...rows[i], [k]: v }; setRows(rows); };
    return (
      <div className="app-split editing">
        <div className="split-bar">{edit.map((r, i) => num(r.share) > 0 ? <i key={i} style={{ width: `${Math.min(100, num(r.share))}%`, background: COLORS[i % COLORS.length] }} /> : null)}</div>
        <div className={'split-total' + (total === 100 ? ' ok' : ' warn')}>{total === 100 ? 'Total 100 % ✓' : total < 100 ? `Total ${total} % · ${Math.round((100 - total) * 100) / 100} % left to give` : `Total ${total} % · ${Math.round((total - 100) * 100) / 100} % too much`}</div>
        {edit.map((r, i) => {
          const isKnown = !r.other && known.some((x) => x.key === r.key);
          return (
            <div className="split-row" key={i}>
              <i className="dot" style={{ background: COLORS[i % COLORS.length] }} />
              <div className="who">
                <select value={isKnown ? r.key : ''} onChange={(e) => { const k = known.find((x) => x.key === e.target.value); const rows = edit.slice(); rows[i] = k ? { ...rows[i], key: k.key, label: k.label, other: false } : { ...rows[i], other: true }; setRows(rows); }}>
                  {known.map((k) => <option key={k.key} value={k.key}>{k.label || k.key.slice(0, 12) + '…'}</option>)}
                  <option value="">Another key…</option>
                </select>
                {isKnown ? <small title={r.key}>{r.key.slice(0, 16)}…</small> : <>
                  <input className="pk" autoComplete="off" spellCheck={false} placeholder="02… or 03… (66 hex)" value={r.key} onChange={(e) => edRow(i, 'key', e.target.value)} />
                  <input className="pl" placeholder="label" value={r.label} onChange={(e) => edRow(i, 'label', e.target.value)} /></>}
              </div>
              <label className="pct"><input className="pp" inputMode="decimal" value={r.share} onChange={(e) => edRow(i, 'share', e.target.value)} /><span>%</span></label>
              <button type="button" className="x" title="Remove this developer" onClick={() => setRows(edit.filter((_, j) => j !== i))}>×</button>
            </div>);
        })}
        <button type="button" onClick={() => setRows([...edit, { key: '', label: '', share: '0', other: true }])}>+ Add a developer</button>
        <p className="sub">Signs version {Number(g.version) + 1} of {g.title || g.name} with this split. It runs here at once; nodes that update automatically take it. Rounds already published keep theirs.</p>
        <div className="split-go"><button type="button" className="primary" disabled={total !== 100} onClick={() => this.sign(g)}>Sign version {Number(g.version) + 1}</button>
          <button type="button" onClick={() => setRows(null)}>Cancel</button></div>
        {said ? <p className={said.ok ? 'ok' : 'err'}>{said.text}</p> : null}
      </div>);
  }
  /** One app as a card (kanban #565): its name, its version, its kind, its developer's signed description, Remove or "built in". */
  card(g, known = []) {
    return (
      <div key={g.id} className="app-card" id={`app-${String(g.id).slice(0, 12)}`}>
        <div className="app-head"><span className="app-ic" aria-hidden="true">{(g.title || g.name || '?').slice(0, 1).toUpperCase()}</span>
          <b className="app-name">{g.title || g.name}</b><span className="pill">v{g.version}</span></div>
        <InfoLine info={g.info} />
        {this.split(g, known)}
        <div className="app-foot">
          <span className="sub">{g.installed ? 'installed here' : 'built into this node'}</span>
          {g.installed ? <button type="button" className="mini" onClick={() => this.remove(g.id)}>Remove</button> : <span className="pill on">built in</span>}
        </div>
        {g.older && g.older.length ? <details><summary className="sub">{g.older.length} older version{g.older.length === 1 ? '' : 's'} kept for rounds that still use {g.older.length === 1 ? 'it' : 'them'}</summary>
          {[...g.older].sort((x, y) => y.version - x.version).map((o) => (
            <div className="row" key={o.id}><span>{o.title || o.name} <span className="sub">v{o.version}</span></span><b>{o.installed ? <button type="button" className="mini" onClick={() => this.remove(o.id)}>Remove</button> : 'built in'}</b></div>))}</details> : null}
      </div>);
  }
  render() {
    const { loaded, mine, auto, sources, saved, error } = this.state;
    if (!loaded) return <p className="sub">reading this node's apps…</p>;
    const apps = newestApps(mine.hosted);
    // every developer any app here names, for the split's select
    const known = [...new Map(mine.hosted.flatMap((g) => (g.split || []).map((r) => [r.key, r.label]))).entries()].map(([key, label]) => ({ key, label }));
    return (
      <div>
        {apps.length ? <div className="app-grid">{apps.map((g) => this.card(g, known))}</div> : <p className="sub">No app on this node yet.</p>}
        <h3 className="sh">Updates</h3>
        <div className="settings-card">
          <div className="set-row"><div><b>Update apps automatically</b><p className="sub">A newer version from the nodes below is checked in this node and taken.</p></div>
            <Switch id="auto-update" label="Update apps automatically" checked={auto} onChange={(on) => this.setState({ auto: on, saved: false })} /></div>
          <details><summary className="sub">Where updates come from</summary>
            <label htmlFor="sources">Nodes to take updates from (one address per line)</label>
            <textarea id="sources" rows="2" autoComplete="off" autoCapitalize="none" value={sources} onChange={(e) => this.setState({ sources: e.target.value, saved: false })} /></details>
          <Button primary={!saved} onClick={this.save}>{saved ? 'Saved ✓' : 'Save'}</Button>
          {error ? <p className="err">{error}</p> : null}
        </div>
      </div>
    );
  }
}
