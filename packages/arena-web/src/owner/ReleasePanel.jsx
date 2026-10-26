// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S UPDATES, IN REACT (kanban #564): the version and commit this node runs, the protocol versions it speaks (as
// ranges), the newest release - or a new one with its release page (invite only) - and how to update, from GET /owner/version. A seat run
// from a source checkout has no release to compare (kanban #553). The page's badge is told of a new release.
import React from 'react';

/** "1-16, 19" for [1..16, 19]. */
export function protoRange(list) {
  const n = [...list].map(Number).sort((a, b) => a - b); const out = [];
  for (let i = 0; i < n.length; i++) { let j = i; while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++; out.push(i === j ? String(n[i]) : `${n[i]}-${n[j]}`); i = j; }
  return out.join(', ');
}
export const newRelease = (v) => !!(v && v.version && v.latest && v.latest.newer && v.latest.latest);

export class ReleasePanel extends React.Component {
  constructor(props) { super(props); this.state = { loaded: false, version: null, ...(props.initial || {}) }; }
  async componentDidMount() {
    if (this.state.loaded || !this.props.api) return;
    let v = null; try { v = await this.props.api.get('/owner/version'); } catch { v = null; }
    this.setState({ loaded: true, version: v });
    if (this.props.onNewer) this.props.onNewer(newRelease(v) ? v.latest.latest.version : null);
  }
  latest(v) {
    const l = v.latest || {};
    if (l.newer && l.latest) return (
      <div className="rel-state new" id="release-state"><b>Update available: {l.latest.version}</b>
        <span>This node runs {v.version}. It updates by itself within 30 minutes{l.latest.release ? <>; <a href={l.latest.release} target="_blank" rel="noopener noreferrer">what is new</a></> : null}.</span></div>);
    // UP TO DATE IN GREEN, AN UPDATE CLEARLY MARKED (kanban #714, 2026-10-26: "when it's up2date mark it in a more seeable color with green
    // colors that no update is available. If there is an update it should also mark it clearly")
    if (l.latest) return <div className="rel-state ok" id="release-state"><b>✓ Up to date</b><span>{l.latest.version} is the newest release.</span></div>;
    return l.why ? <p className="sub">Newest release: {l.why}.</p> : null;
  }
  render() {
    const { loaded, version: v } = this.state;
    if (!loaded) return <p className="sub">reading…</p>;
    if (!v) return <p className="sub">This node does not say which version it runs.</p>;
    return (
      <div>
        <div className="row"><span>Version</span><b>{v.version || 'run from a source checkout'}</b></div>
        {v.commit ? <div className="row"><span>Commit</span><b><code>{v.commit.slice(0, 12)}</code></b></div> : null}
        <div className="row"><span>Protocol versions it speaks</span><b>{protoRange(v.protocols || [])}</b></div>
        {this.latest(v)}
        {v.update && newRelease(v) ? <p className="sub">To update now by hand: {v.update}.</p> : null}
      </div>
    );
  }
}
