// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVELOPERS' OWN BALLOT IN REACT (kanban #564): what owner.html's ballotsPanel() drew by hand (§27A.4.1, 2026-10-16: "a proposal ui so
// one of the devs can propose something and another dev sees it in his ui and can click accept or deny. As soon as the threshold is hit it
// becomes active"): the protocol developers' set in force, every proposal with its votes and state, Accept / Deny for this node's dev
// clients that are recipients and have not voted, a form to propose a new split (from the set in force; a new row adds a developer by key,
// with an optional vesting), and the fee proposals that change a donation (2026-10-17: "any change to donation percentages requires
// majority approval by protocol devs"), each with Approve / Deny for this node's dev clients that have not answered. The page reads the
// doors and hands over `vote`, `feeAnswer`, `propose` (each a signed owner request) and `reread`.
import React from 'react';

const pct = (bps) => (Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' %';
const feeName = (k) => k.replace(/Bps$|Pct$/, '').replace(/([A-Z])/g, ' $1').toLowerCase();
const feeVal = (k, x) => (/Bps$/.test(k) ? (Number(x) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(x)) + ' %';
const Row = ({ k, v }) => <div className="row"><span>{k}</span><b>{v}</b></div>;
const field = { autoComplete: 'off', spellCheck: false };

export class BallotsPanel extends React.Component {
  constructor(props) {
    super(props);
    const set = this.set();
    this.state = { rows: set ? set.recipients.map((r) => ({ key: r.key, label: r.label || '', share: String(Number(r.shareBps) / 100), vest: '', days: '' })) : [],
      by: (this.proposers()[0] || {}).slug || '', said: {}, proposeWhy: '' };
  }
  set() { const d = this.props.donations; return d && (d.sets || []).find((x) => x.kind === 'protocol'); }
  mine() { const v = this.props.dev; return ((v && v.clients) || []).map((c) => ({ slug: c.slug, key: c.recipientPk, label: c.label || c.slug })); }
  proposers() { const set = this.set(); return this.mine().filter((m) => set && set.recipients.some((r) => r.key === m.key)); }
  nameOf(key) { const set = this.set(); const r = set && set.recipients.find((x) => x.key === key); const m = this.mine().find((x) => x.key === key); return (r && r.label) || (m && m.label) || key.slice(0, 12) + '…'; }
  async act(id, f) {
    this.setState({ said: { ...this.state.said, [id]: '' } });
    try { await f(); this.props.reread(); } catch (e) { this.setState({ said: { ...this.state.said, [id]: e.message } }); }
  }
  async propose() {
    this.setState({ proposeWhy: '' });
    const rows = this.state.rows.map((r) => ({ key: r.key.trim().toLowerCase(), label: r.label.trim(), shareBps: Math.round(Number(String(r.share || 0).replace(',', '.')) * 100),
      ...(r.days.trim() ? { vestBps: Math.round(Number(String(r.vest).replace(',', '.')) * 100), vestDays: Number(r.days.trim()) } : {}) })).filter((r) => r.key);
    const sum = rows.reduce((t, r) => t + r.shareBps, 0);
    if (sum !== 10000) return this.setState({ proposeWhy: `the shares add up to ${sum / 100} %, not 100 %` });
    if (rows.some((r) => !/^0[23][0-9a-f]{64}$/.test(r.key))) return this.setState({ proposeWhy: 'every key is 66 hex characters starting 02 or 03' });
    try { await this.props.propose(this.state.by, rows); this.props.reread(); } catch (e) { this.setState({ proposeWhy: e.message }); }
  }
  editRow(i, k, v) { const rows = this.state.rows.slice(); rows[i] = { ...rows[i], [k]: v }; this.setState({ rows }); }
  render() {
    const { ballots: b, fees: fz, why, vote, feeAnswer } = this.props;
    if (why) return <div className="card"><p className="err">{why}</p></div>;
    const set = this.set(), mine = this.mine(), proposers = this.proposers(), s = this.state;
    const stateOf = (p) => (p.state === 'approved' ? <span className="ok">approved · in force from block {String(p.validFrom)}</span>
      : p.state === 'refused' ? <span className="err">refused{p.why ? ' · ' + p.why : ''}</span> : `open · ${pct(p.acceptBps)} accepted, more than 50 % needed`);
    return (
      <>
        {set ? <div className="card"><h3>In force: serial {String(set.serial)}</h3>
          {set.recipients.map((r) => <Row key={r.key} k={<>{r.label || r.key.slice(0, 12)} <span className="sub">{r.key.slice(0, 12)}…</span></>} v={pct(r.shareBps)} />)}
          <p className="sub">Any developer here can propose a new split. It is in force for new rounds once developers holding more than half of this set accept it; rounds already published keep theirs.</p></div>
          : <div className="card"><p>No protocol developers' set is in force on this node.</p></div>}
        {(b.ballots || []).slice().sort((x, y) => Number(y.serial) - Number(x.serial)).map((p) => {
          const voters = mine.filter((m) => set && set.recipients.some((r) => r.key === m.key) && !p.votes.some((x) => x.key === m.key));
          return (
            <div className="card" key={p.id}><h3>Proposal · serial {String(p.serial)} <span className="sub">{p.id.slice(0, 12)}</span></h3>
              <Row k="State" v={stateOf(p)} />
              <Row k="Proposed by" v={this.nameOf(p.proposer)} />
              {p.recipients.map((r) => <Row key={r.key} k={<>{r.label || r.key.slice(0, 12)} <span className="sub">{r.key.slice(0, 12)}…</span></>}
                v={pct(r.shareBps) + (r.vesting ? ` → ${pct(r.vesting.targetBps)} over ${r.vesting.days} days from block ${r.vesting.startHeight}` : '')} />)}
              {p.votes.map((x) => <Row key={x.key} k={`${this.nameOf(x.key)} (${pct(x.bps)})`} v={<>{x.accept ? <span className="ok">accepted</span> : <span className="err">denied</span>} · block {String(x.atHeight)}</>} />)}
              {p.state === 'open' ? voters.map((m) => <React.Fragment key={m.slug}>
                <button type="button" className="primary" onClick={() => this.act(p.id, () => vote(m.slug, p.id, true))}>Accept as {m.label}</button>
                <button type="button" onClick={() => this.act(p.id, () => vote(m.slug, p.id, false))}>Deny as {m.label}</button></React.Fragment>) : null}
              <div className="err">{s.said[p.id] || ''}</div></div>);
        })}
        {proposers.length && set ? <div className="card"><h3>Propose a new split</h3>
          <p className="sub">One row per developer: their recipient key (33 bytes, hex), a label and a share in percent now; the shares add up to 100 %.
            To let a share grow day by day (vesting), give the share it grows to and over how many days - a newcomer starts at 0 %. Until it is reached, the part not yet vested stays with the others in their proportions.</p>
          <div id="prow">{s.rows.map((r, i) => <div className="name-row" key={i}>
            <input {...field} className="pk" placeholder="02… or 03… (66 hex)" value={r.key} onChange={(e) => this.editRow(i, 'key', e.target.value)} />
            <input className="pl" placeholder="label" value={r.label} onChange={(e) => this.editRow(i, 'label', e.target.value)} />
            <input className="pp" inputMode="decimal" placeholder="%" value={r.share} onChange={(e) => this.editRow(i, 'share', e.target.value)} />
            <input className="pv" inputMode="decimal" placeholder="vests to %" value={r.vest} onChange={(e) => this.editRow(i, 'vest', e.target.value)} />
            <input className="pd" inputMode="numeric" placeholder="days" value={r.days} onChange={(e) => this.editRow(i, 'days', e.target.value)} /></div>)}</div>
          <button type="button" id="padd" onClick={() => this.setState({ rows: [...s.rows, { key: '', label: '', share: '0', vest: '', days: '' }] })}>Add a developer</button>
          <label>Propose as</label><select id="pby" value={s.by} onChange={(e) => this.setState({ by: e.target.value })}>{proposers.map((m) => <option key={m.slug} value={m.slug}>{m.label}</option>)}</select>
          <button type="button" className="primary" id="pgo" onClick={() => this.propose()}>Propose</button><div className="err" id="perr2">{s.proposeWhy}</div></div> : null}
        {(fz.proposals || []).filter((p) => p.needsDevs).map((p) => {
          const answered = new Set((p.devs || []).map((x) => x.dev));
          const voters = mine.filter((m) => m.key && !answered.has(String(m.key).slice(2)));
          return (
            <div className="card" key={p.id}><h3>Fee proposal <span className="sub">{p.id.slice(0, 12)}</span></h3>
              {p.changes.map((c) => <Row key={c.fee} k={<>{feeName(c.fee)}{c.donation ? <> <span className="sub">donation</span></> : null}</>} v={`${feeVal(c.fee, c.from)} → ${feeVal(c.fee, c.to)}`} />)}
              <Row k="In force from" v={`block ${p.activationHeight}`} />
              <Row k="State" v={p.decision ? (p.decision.accepted ? <span className="ok">accepted</span> : <span className="err">refused · {p.decision.why || ''}</span>) : (p.vote ? 'vote ' + p.vote.state : 'signal ' + ((p.signal || {}).state || '…'))} />
              {(p.devs || []).map((x) => <Row key={x.dev} k={x.dev.slice(0, 12) + '…'} v={x.approve ? <span className="ok">approved</span> : <span className="err">denied</span>} />)}
              {!p.decision ? voters.map((m) => <React.Fragment key={m.slug}>
                <button type="button" className="primary" onClick={() => this.act('fee' + p.id, () => feeAnswer(m.slug, p.id, true))}>Approve as {m.label}</button>
                <button type="button" onClick={() => this.act('fee' + p.id, () => feeAnswer(m.slug, p.id, false))}>Deny as {m.label}</button></React.Fragment>) : null}
              <div className="err">{s.said['fee' + p.id] || ''}</div></div>);
        })}
      </>);
  }
}
