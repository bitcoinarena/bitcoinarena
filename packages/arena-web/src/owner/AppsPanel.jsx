// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S APPS ON THIS NODE, IN REACT (kanban #564): the games, markets and networks this node runs - each app once, at its
// newest version, the older ones it keeps for rounds that still name them folded away (kanban #553) - its developer's signed description,
// Remove for an installed one (POST /owner/plugins/remove, signed), and the update settings: update automatically, and the nodes updates
// come from (POST /owner/settings, signed). Read from GET /owner/plugins. (Found on the network / look at a node: the next slice.)
import React from 'react';
import { Button } from '../design/components.jsx';

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
  one(g) {
    return (
      <div className="row" key={`${g.id}`}><span>{g.title || g.name} <span className="sub">v{g.version}</span></span>
        <b>{g.installed ? <Button onClick={() => this.remove(g.id)}>Remove</Button> : 'built in'}</b></div>);
  }
  render() {
    const { loaded, mine, auto, sources, saved, error } = this.state;
    if (!loaded) return <p className="sub">reading this node's apps…</p>;
    const apps = newestApps(mine.hosted);
    return (
      <div>
        {apps.length ? apps.map((g) => (
          <React.Fragment key={g.id}>
            {this.one(g)}<InfoLine info={g.info} />
            {g.older.length ? <details><summary className="sub">{g.older.length} older version{g.older.length === 1 ? '' : 's'} kept for rounds that still use {g.older.length === 1 ? 'it' : 'them'}</summary>
              {[...g.older].sort((x, y) => y.version - x.version).map((o) => this.one(o))}</details> : null}
          </React.Fragment>)) : <p className="sub">none</p>}
        <label className="confirm"><input type="checkbox" style={{ width: 'auto' }} checked={auto} onChange={(e) => this.setState({ auto: e.target.checked, saved: false })} /> <span>Update apps automatically</span></label>
        <details><summary className="sub">Where updates come from</summary>
          <label>Nodes to take updates from (one address per line)</label>
          <textarea rows="2" autoComplete="off" autoCapitalize="none" value={sources} onChange={(e) => this.setState({ sources: e.target.value, saved: false })} /></details>
        <Button onClick={this.save}>{saved ? 'Saved ✓' : 'Save'}</Button>
        {error ? <p className="err">{error}</p> : null}
      </div>
    );
  }
}
