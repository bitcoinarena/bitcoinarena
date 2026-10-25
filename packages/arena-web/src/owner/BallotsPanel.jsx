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

/**
 * THE SHARES TO SIGN FROM THE SPLIT AS PICTURED (2026-10-22: 50 / 30 / 10 growing to 20 "should be a valid proposal"): the
 * owner enters each developer's share at full vesting - a vesting row its start and its target - and those add up to 100 %. The
 * protocol wants the shares at the start to add up to 100 % and scales the rows that do not vest into what the vesting rows leave
 * (donation.js vestedShares), so the rows that do not vest are signed scaled into what the vesting rows hold at the start, in the
 * same ratio: at full vesting they pay exactly what was entered. Rows of { shareBps, vestBps?, vestDays? } in basis points.
 */
export function startShares(rows) {
  const vests = (r) => r.vestDays !== undefined;
  const start = rows.filter(vests).reduce((t, r) => t + r.shareBps, 0);
  const others = rows.filter((r) => !vests(r)).reduce((t, r) => t + r.shareBps, 0);
  if (!rows.some(vests) || others === 0) return rows;
  const out = rows.map((r) => (vests(r) ? r : { ...r, shareBps: Math.floor((r.shareBps * (10000 - start)) / others) }));
  const short = 10000 - out.reduce((t, r) => t + r.shareBps, 0);
  const first = out.findIndex((r) => !vests(r));
  out[first] = { ...out[first], shareBps: out[first].shareBps + short };
  return out;
}

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
      ...(r.days.trim() && String(r.vest).trim() ? { vestBps: Math.round(Number(String(r.vest).replace(',', '.')) * 100), vestDays: Number(r.days.trim()) } : {}) })).filter((r) => r.key);
    // the split at full vesting adds up to 100 % (a vesting row counts with its target); a vesting row grows from its start
    const sum = rows.reduce((t, r) => t + (r.vestDays !== undefined ? r.vestBps : r.shareBps), 0);
    if (sum !== 10000) return this.setState({ proposeWhy: `the shares${rows.some((r) => r.vestDays !== undefined) ? ' at full vesting' : ''} add up to ${sum / 100} %, not 100 %` });
    if (rows.some((r) => r.vestDays !== undefined && !(r.vestDays >= 1))) return this.setState({ proposeWhy: 'a vesting share reaches its target over at least one day' });
    if (rows.some((r) => r.vestDays !== undefined) && rows.every((r) => r.vestDays !== undefined) && sum !== rows.reduce((t, r) => t + r.shareBps, 0)) return this.setState({ proposeWhy: 'when every developer vests, someone must hold the part not yet vested: leave one without vesting' });
    if (rows.some((r) => !/^0[23][0-9a-f]{64}$/.test(r.key))) return this.setState({ proposeWhy: 'every key is 66 hex characters starting 02 or 03' });
    try { await this.props.propose(this.state.by, startShares(rows)); this.props.reread(); } catch (e) { this.setState({ proposeWhy: e.message }); }
  }
  editRow(i, k, v) { const rows = this.state.rows.slice(); rows[i] = { ...rows[i], [k]: v }; this.setState({ rows }); }
  render() {
    const { ballots: b, fees: fz, why, vote, feeAnswer, part } = this.props;
    if (why) return <div className="card"><p className="err">{why}</p></div>;
    const set = this.set(), mine = this.mine(), proposers = this.proposers(), s = this.state;
    const stateOf = (p) => (p.state === 'approved' ? <span className="ok">approved · in force from block {String(p.validFrom)}</span>
      : p.state === 'refused' ? <span className="err">refused{p.why ? ' · ' + p.why : ''}</span> : `open · ${pct(p.acceptBps)} accepted, more than 50 % needed`);
    const ballotCard = (p) => {
      const voters = mine.filter((m) => set && set.recipients.some((r) => r.key === m.key) && !p.votes.some((x) => x.key === m.key));
      return (
        <div className={'card' + (p.state === 'open' ? ' open-prop' : '')} key={p.id}><h3>Proposal · serial {String(p.serial)} <span className="sub">{p.id.slice(0, 12)}</span></h3>
          <Row k="State" v={stateOf(p)} />
          <Row k="Proposed by" v={this.nameOf(p.proposer)} />
          {p.recipients.map((r) => <Row key={r.key} k={<>{r.label || r.key.slice(0, 12)} <span className="sub">{r.key.slice(0, 12)}…</span></>}
            v={pct(r.shareBps) + (r.vesting ? ` → ${pct(r.vesting.targetBps)} over ${r.vesting.days} days from block ${r.vesting.startHeight}` : '')} />)}
          {p.votes.map((x) => <Row key={x.key} k={`${this.nameOf(x.key)} (${pct(x.bps)})`} v={<>{x.accept ? <span className="ok">accepted</span> : <span className="err">denied</span>} · block {String(x.atHeight)}</>} />)}
          {p.state === 'open' ? voters.map((m) => <React.Fragment key={m.slug}>
            <button type="button" className="primary" onClick={() => this.act(p.id, () => vote(m.slug, p.id, true))}>Accept as {m.label}</button>
            <button type="button" onClick={() => this.act(p.id, () => vote(m.slug, p.id, false))}>Deny as {m.label}</button></React.Fragment>) : null}
          <div className="err">{s.said[p.id] || ''}</div></div>);
    };
    const feeCard = (p) => {
      const answered = new Set((p.devs || []).map((x) => x.dev));
      const voters = mine.filter((m) => m.key && !answered.has(String(m.key).slice(2)));
      return (
        <div className={'card' + (!p.decision ? ' open-prop' : '')} key={p.id}><h3>Fee proposal <span className="sub">{p.id.slice(0, 12)}</span></h3>
          {p.changes.map((c) => <Row key={c.fee} k={<>{feeName(c.fee)}{c.donation ? <> <span className="sub">donation</span></> : null}</>} v={`${feeVal(c.fee, c.from)} → ${feeVal(c.fee, c.to)}`} />)}
          <Row k="In force from" v={`block ${p.activationHeight}`} />
          <Row k="State" v={p.decision ? (p.decision.accepted ? <span className="ok">accepted</span> : <span className="err">refused · {p.decision.why || ''}</span>) : (p.vote ? 'vote ' + p.vote.state : 'signal ' + ((p.signal || {}).state || '…'))} />
          {(p.devs || []).map((x) => <Row key={x.dev} k={x.dev.slice(0, 12) + '…'} v={x.approve ? <span className="ok">approved</span> : <span className="err">denied</span>} />)}
          {!p.decision ? voters.map((m) => <React.Fragment key={m.slug}>
            <button type="button" className="primary" onClick={() => this.act('fee' + p.id, () => feeAnswer(m.slug, p.id, true))}>Approve as {m.label}</button>
            <button type="button" onClick={() => this.act('fee' + p.id, () => feeAnswer(m.slug, p.id, false))}>Deny as {m.label}</button></React.Fragment>) : null}
          <div className="err">{s.said['fee' + p.id] || ''}</div></div>);
    };
    const byNewest = (b.ballots || []).slice().sort((x, y) => Number(y.serial) - Number(x.serial));
    const openBallots = byNewest.filter((p) => p.state === 'open'), pastBallots = byNewest.filter((p) => p.state !== 'open');
    const devFees = (fz.proposals || []).filter((p) => p.needsDevs), openFees = devFees.filter((p) => !p.decision), pastFees = devFees.filter((p) => !!p.decision);
    return (
      <>
        {part === 'open' ? ((b.ballots || []).some((p) => p.state === 'open') || (fz.proposals || []).some((p) => p.needsDevs && !p.decision)
      ? <h3 className="sh open-head">Open proposals · your vote counts</h3> : null) : null}
        {part === 'open' ? null : set ? <div className="card"><h3>In force: serial {String(set.serial)}</h3>
      <div className="split-bar">{set.recipients.map((r, i) => <i key={r.key} title={`${r.label || r.key.slice(0, 12)}: ${pct(r.shareBps)}`} style={{ width: `${Number(r.shareBps) / 100}%`, background: ['var(--st)', 'var(--gv)', 'var(--ok)', '#a77bf3', '#e57ab0', '#4fd1c5'][i % 6] }} />)}</div>
      {set.recipients.map((r) => <Row key={r.key} k={<>{r.label || r.key.slice(0, 12)} <span className="sub">{r.key.slice(0, 12)}…</span></>} v={pct(r.shareBps)} />)}
      <p className="sub">Any developer can propose a new split. It applies to new rounds once developers holding more than half accept it.</p></div>
      : part === 'open' ? null : <div className="card"><p>No protocol developers' set is in force on this node.</p></div>}
        {part === 'rest' ? null : openBallots.map(ballotCard)}
        {part !== 'open' && proposers.length && set ? (() => {
      // PROPOSE A NEW SPLIT, PRETTY (2026-10-22: "Make the UI more pretty including selects for existing devs"): a row per developer -
      // pick a known developer (the set in force and this node's dev clients) or another key, the share in %, an optional vesting - and
      // the total live as a bar, one colour per developer, saying what is left until 100 %
      const known = [...new Map([...set.recipients.map((r) => [r.key, r.label || r.key.slice(0, 12) + '…']), ...mine.map((m) => [m.key, m.label])]).entries()].map(([key, label]) => ({ key, label }));
      const COLORS = ['var(--st)', 'var(--gv)', 'var(--ok)', '#a77bf3', '#e57ab0', '#4fd1c5'];
      const num = (v) => { const x = Number(String(v || 0).replace(',', '.')); return Number.isFinite(x) ? x : 0; };
      const vests = (r) => String(r.days || '').trim() !== '' && String(r.vest || '').trim() !== '';
      const final = (r) => (vests(r) ? num(r.vest) : num(r.share));
      const total = Math.round(s.rows.reduce((t, r) => t + final(r), 0) * 100) / 100;
      // what each developer holds on the first day, when someone vests: the vesting rows their start, the others scaled into the rest
      const vRows = s.rows.filter(vests), vStart = vRows.reduce((t, r) => t + num(r.share), 0), oFinal = s.rows.filter((r) => !vests(r)).reduce((t, r) => t + num(r.share), 0);
      const firstDay = vRows.length && oFinal > 0 ? s.rows.map((r) => (vests(r) ? num(r.share) : (num(r.share) * (100 - vStart)) / oFinal)) : null;
      const p2 = (x) => Math.round(x * 100) / 100;
      const pick = (i, v) => { if (v === '') return this.editRow(i, 'other', true);
        const k = known.find((x) => x.key === v); const rows = s.rows.slice(); rows[i] = { ...rows[i], key: v, label: k ? k.label : rows[i].label, other: false }; this.setState({ rows }); };
      return (
        <div className="card split"><h3>Propose a new split</h3>
          <p className="sub">Pick the developers and their shares (100 % in total). A share can grow day by day up to a target.</p>
          {/* the bar shows the split at full vesting; a vesting row's part still to grow is drawn faint */}
          <div className="split-bar">{s.rows.map((r, i) => final(r) > 0 ? <React.Fragment key={i}>
            <i title={`${r.label || 'developer'}: ${vests(r) ? `${num(r.share)} % now` : `${final(r)} %`}`} style={{ width: `${Math.min(100, vests(r) ? num(r.share) : final(r))}%`, background: COLORS[i % COLORS.length] }} />
            {vests(r) && final(r) > num(r.share) ? <i className="grow" title={`${r.label || 'developer'}: grows to ${final(r)} %`} style={{ width: `${Math.min(100, final(r) - num(r.share))}%`, background: COLORS[i % COLORS.length] }} /> : null}</React.Fragment> : null)}</div>
          <div className={'split-total' + (total === 100 ? ' ok' : ' warn')}>{total === 100 ? (vRows.length ? 'Total 100 % at full vesting ✓' : 'Total 100 % ✓') : total < 100 ? `Total ${total} % · ${p2(100 - total)} % left to give` : `Total ${total} % · ${p2(total - 100)} % too much`}
            {firstDay && total === 100 ? <small>On the first day: {s.rows.map((r, i) => `${r.label || 'developer'} ${p2(firstDay[i])} %`).join(' · ')}</small> : null}</div>
          <div id="prow">{s.rows.map((r, i) => {
            const isKnown = !r.other && known.some((x) => x.key === r.key);
            return (
              <div className="split-row" key={i}>
                <i className="dot" style={{ background: COLORS[i % COLORS.length] }} />
                <div className="who">
                  <select value={isKnown ? r.key : ''} onChange={(e) => pick(i, e.target.value)}>
                    {known.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                    <option value="">Another key…</option>
                  </select>
                  {isKnown ? <small title={r.key}>{r.key.slice(0, 16)}…</small> : <>
                    <input {...field} className="pk" placeholder="02… or 03… (66 hex)" value={r.key} onChange={(e) => this.editRow(i, 'key', e.target.value)} />
                    <input className="pl" placeholder="label" value={r.label} onChange={(e) => this.editRow(i, 'label', e.target.value)} /></>}
                </div>
                <label className="pct"><input className="pp" inputMode="decimal" value={r.share} onChange={(e) => this.editRow(i, 'share', e.target.value)} /><span>%</span></label>
                <div className="vest"><span>grows to</span><input className="pv" inputMode="decimal" placeholder="–" value={r.vest} onChange={(e) => this.editRow(i, 'vest', e.target.value)} /><span>% over</span>
                  <input className="pd" inputMode="numeric" placeholder="–" value={r.days} onChange={(e) => this.editRow(i, 'days', e.target.value)} /><span>days</span></div>
                <button type="button" className="x" title="Remove this developer" onClick={() => this.setState({ rows: s.rows.filter((_, j) => j !== i) })}>×</button>
              </div>);
          })}</div>
          <button type="button" id="padd" onClick={() => this.setState({ rows: [...s.rows, { key: '', label: '', share: '0', vest: '', days: '', other: true }] })}>+ Add a developer</button>
          <div className="split-go"><label>Propose as</label><select id="pby" value={s.by} onChange={(e) => this.setState({ by: e.target.value })}>{proposers.map((m) => <option key={m.slug} value={m.slug}>{m.label}</option>)}</select>
            <button type="button" className="primary" id="pgo" disabled={total !== 100} onClick={() => this.propose()}>Propose</button></div>
          <div className="err" id="perr2">{s.proposeWhy}</div>
        </div>);
        })() : null}
        {part === 'rest' ? null : openFees.map(feeCard)}
        {/* PAST PROPOSALS FOLDED (2026-10-22: "past proposals should be hidden by default") */}
        {part !== 'open' && pastBallots.length + pastFees.length ? <details className="past-props"><summary>Past proposals · {pastBallots.length + pastFees.length}</summary>
      {pastBallots.map(ballotCard)}{pastFees.map(feeCard)}</details> : null}
      </>);
  }
}
