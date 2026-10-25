// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GAME DEVELOPERS ON THIS NODE (kanban #582, 2026-10-22: "es soll unter donations für game devs erscheinen, wenn ein private key
// eines game devs auf dem Node installiert ist und neue Apps signieren kann. Nur dann. Dann gibt es eine Übersicht ähnlich des protocol devs
// mit allen donations und proposals"): shown only when the owner installed a game developer's key here (GET /owner/app-devs) - per app it
// signs: the split in force, Change split (the node signs the app's next version with that key, POST /owner/apps/split), every earlier
// version's split (the past proposals), and the donations this node's dev clients received for the app. Installing a key is folded below.
import React from 'react';

const COLORS = ['var(--st)', 'var(--gv)', 'var(--ok)', '#a77bf3', '#e57ab0', '#4fd1c5'];
const pct = (bps) => `${(Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} %`;
const whole = (msat) => `${(BigInt(msat || 0) / 1000n).toLocaleString('en-US')} sat`;
const num = (v) => { const x = Number(String(v || 0).replace(',', '.')); return Number.isFinite(x) ? x : 0; };
const field = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false };

/** A split as a bar and its legend. */
export const SplitBar = ({ split }) => (
  <>
    <div className="split-bar">{split.map((r, i) => <i key={r.key} title={`${r.label || r.key.slice(0, 12)}: ${pct(r.shareBps)}`} style={{ width: `${Number(r.shareBps) / 100}%`, background: COLORS[i % COLORS.length] }} />)}</div>
    <div className="app-split-who">{split.map((r, i) => <span key={r.key}><i style={{ background: COLORS[i % COLORS.length] }} />{r.label || r.key.slice(0, 12) + '…'} <b>{pct(r.shareBps)}</b></span>)}</div>
  </>);

export class GameDevsPanel extends React.Component {
  constructor(props) { super(props); this.state = { edit: {}, said: {}, key: '', keySaid: null }; }
  async install() {
    this.setState({ keySaid: null });
    try { const r = await this.props.addKey(this.state.key.trim()); this.setState({ key: '', keySaid: { ok: true, text: `Installed ✓ developer ${r.pubkey.slice(0, 16)}… · ${r.apps.length ? `signs ${r.apps.join(', ')}` : 'no app on this node names it'}` } }); this.props.reread(); }
    catch (e) { this.setState({ keySaid: { ok: false, text: e.message } }); }
  }
  async sign(a) {
    const rows = this.state.edit[a.id] || [];
    const recipients = rows.map((r) => ({ key: r.key.trim().toLowerCase(), label: r.label.trim(), shareBps: Math.round(num(r.share) * 100) }));
    this.setState({ said: { ...this.state.said, [a.id]: null } });
    try {
      const r = await this.props.changeSplit(a.id, recipients);
      this.setState({ edit: { ...this.state.edit, [a.id]: null }, said: { ...this.state.said, [a.id]: { ok: true, text: `Signed ✓ version ${r.version} runs here now; other nodes take it as an update` } } });
      this.props.reread();
    } catch (e) { this.setState({ said: { ...this.state.said, [a.id]: { ok: false, text: e.message } } }); }
  }
  editor(a, known) {
    const edit = this.state.edit[a.id];
    const setRows = (rows) => this.setState({ edit: { ...this.state.edit, [a.id]: rows } });
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
                  <input {...field} className="pk" placeholder="02… or 03… (66 hex)" value={r.key} onChange={(e) => edRow(i, 'key', e.target.value)} />
                  <input className="pl" placeholder="label" value={r.label} onChange={(e) => edRow(i, 'label', e.target.value)} /></>}
              </div>
              <label className="pct"><input className="pp" inputMode="decimal" value={r.share} onChange={(e) => edRow(i, 'share', e.target.value)} /><span>%</span></label>
              <button type="button" className="x" title="Remove this developer" onClick={() => setRows(edit.filter((_, j) => j !== i))}>×</button>
            </div>);
        })}
        <button type="button" onClick={() => setRows([...edit, { key: '', label: '', share: '0', other: true }])}>+ Add a developer</button>
        <p className="sub">Signs version {Number(a.version) + 1} of {a.title} with this split, with its developer's key on this node. It runs here at once; nodes that update automatically take it. Rounds already published keep theirs.</p>
        <div className="split-go"><button type="button" className="primary" disabled={total !== 100} onClick={() => this.sign(a)}>Sign version {Number(a.version) + 1}</button>
          <button type="button" onClick={() => setRows(null)}>Cancel</button></div>
      </div>);
  }
  app(a, known) {
    const said = this.state.said[a.id], d = a.donations || { count: 0, appMsat: '0', byClient: [] };
    return (
      <div className="card gamedev" key={a.id}>
        <div className="gd-head"><b>{a.title}</b><span className="pill">v{a.version}</span></div>
        <div className="dh-chips">
          <div><span>Donations</span><b>{Number(d.count).toLocaleString('en-US')}</b></div>
          <div><span>The app's part</span><b>{whole(d.appMsat)}</b></div>
          <div><span>Versions</span><b>{a.versions.length}</b></div>
        </div>
        {d.byClient.length ? <div className="sub gd-by">{d.byClient.map((c) => <span key={c.slug}>{c.label} <b>{whole(c.appMsat)}</b> · {c.count}</span>)}</div> : null}
        <h4>In force: version {a.version}</h4>
        {this.state.edit[a.id] ? this.editor(a, known) : <><SplitBar split={a.split} />
          <button type="button" className="mini" onClick={() => this.setState({ edit: { ...this.state.edit, [a.id]: a.split.map((r) => ({ key: r.key, label: r.label, share: String(Number(r.shareBps) / 100) })) } })}>Change split</button></>}
        {said ? <p className={said.ok ? 'ok' : 'err'}>{said.text}</p> : null}
        {a.versions.length > 1 ? <details className="past-props"><summary>Past splits · {a.versions.length - 1}</summary>
          {a.versions.slice(1).map((v) => <div className="row" key={v.id}><span>version {v.version} <span className="sub">{v.id.slice(0, 12)}</span></span>
            <b>{v.split.map((r) => `${r.label || r.key.slice(0, 8)} ${pct(r.shareBps)}`).join(' · ')}</b></div>)}</details> : null}
      </div>);
  }
  addForm() {
    const s = this.state;
    return (<details><summary className="sub">Add a game developer key</summary><div className="card">
          <p>A game developer's key on this node lets it sign that developer's apps' new versions - a new split of their donations. Paste the key file
            (game-dev.pkcs8) or its seed. It is kept beside this node's store, readable by the node only.</p>
          <textarea {...field} id="gdkey" rows="3" placeholder="-----BEGIN PRIVATE KEY----- … or 64 hex" value={s.key} onChange={(e) => this.setState({ key: e.target.value })} />
          <p className="sub">The key travels in your signed request: only do this over https or on the node's own machine.</p>
          <button type="button" className="primary" disabled={!s.key.trim()} onClick={() => this.install()}>Install</button>
          <div className="err">{s.keySaid ? (s.keySaid.ok ? <span className="ok">{s.keySaid.text}</span> : s.keySaid.text) : ''}</div></div></details>);
  }
  render() {
    const { devs, why } = this.props, s = this.state;
    if (why) return <div className="card"><p className="err">{why}</p></div>;
    const list = devs || [];
    if (this.props.part === 'add') return this.addForm();
    const known = [...new Map(list.flatMap((d) => d.apps.flatMap((a) => a.versions.flatMap((v) => v.split.map((r) => [r.key, r.label]))))).entries()].map(([key, label]) => ({ key, label }));
    return (
      <>
        {list.length ? <>
          <h3 className="sh">Game developers</h3>
          {list.map((d) => <React.Fragment key={d.devKey}>
            <p className="sub gd-key">Developer key <span title={d.devKey}>{d.devKey.slice(0, 16)}…</span> · signs {d.apps.map((a) => a.title).join(', ') || 'no app on this node'}
              {' '}<button type="button" className="mini" onClick={() => { if (confirm('Remove this developer key from this node?')) this.props.removeKey(d.devKey).then(() => this.props.reread(), () => {}); }}>Remove key</button></p>
            {d.apps.map((a) => this.app(a, known))}
          </React.Fragment>)}</> : null}
        {this.props.part === 'main' ? null : this.addForm()}
      </>);
  }
}
