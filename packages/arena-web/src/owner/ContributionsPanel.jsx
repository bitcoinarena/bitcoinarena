// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CONTRIBUTION AGREEMENTS ON THE OWNER PAGE (spec §27A.4.2, kanban #1346): every agreement the donation set in force carries, as this node's
// book of counted rounds reads it at the tip (GET /contribution-shares?height=) - the share he is paid now, each tranche's milestone with its
// live numbers and the height it vested, the attribution over the floor's window, the identities and gross per site key, and his leave or a
// termination. Read only: an agreement is made and changed by the developers' ballot, a leave by his own key, a termination by the cold key.
import React from 'react';

const pct = (bps) => (Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' %';
const sats = (msat) => (Number(BigInt(msat || 0) / 1000n)).toLocaleString('en-US') + ' sat';
const Row = ({ k, v }) => <div className="row"><span>{k}</span><b>{v}</b></div>;
const MILESTONE = {
  'first-paid': (p) => `${p.t1.have} of ${p.t1.need} new identities whose first paid entry came through his links`,
  retention: (p) => `${p.t2.have} of ${p.t2.need} of them back at least ${p.t2.afterBlocks} blocks after their first`,
  'gross-share': (p) => `${pct(p.scale.t3GrossBps)} of the gross in one ${p.scale.t3WindowBlocks || 'season'}-block window (mainnet)`,
  'new-share': (p) => `${pct(p.scale.t4NewBps)} of new identities in ${p.scale.t4Windows} windows of ${p.scale.t4WindowBlocks} blocks in a row`,
};
const stateWord = (s) => ({ active: 'active', tail: 'left - the vested part pays through the tail', ended: 'ended after the tail', terminated: 'terminated by the cold admin key' }[s] || s || '-');

/** One agreement as a card. `a` is one entry of GET /contribution-shares' `shares`. */
export function ContributionCard({ a, height }) {
  const p = a.progress;
  return (
    <div className="card" key={a.recipient}><h3>{a.label || 'Contributor'} <span className="sub">{a.recipient.slice(0, 12)}…</span></h3>
      <Row k="Paid now" v={<>{pct(a.shareBps)} of the developers' set <span className="sub">at block {height}</span></>} />
      <Row k="Vested" v={pct(a.vestedBps || 0)} />
      <Row k="State" v={stateWord(a.state)} />
      {a.ends && a.ends.leftAt !== null ? <Row k="Left at block" v={String(a.ends.leftAt)} /> : null}
      {a.ends && a.ends.terminatedAt !== null ? <Row k="Terminated at block" v={String(a.ends.terminatedAt)} /> : null}
      {a.agreement ? <Row k="Base" v={`${pct(a.agreement.base.targetBps)} over ${a.agreement.base.days} days, cliff ${a.agreement.base.cliffBlocks} blocks from block ${a.agreement.startHeight}`} /> : null}
      {(a.tranches || []).map((t) => (
        <Row key={t.milestone} k={`${pct(t.bps)} · ${t.milestone}`}
          v={<>{t.vestedAt !== null ? <span className="ok">vested at block {t.vestedAt}</span> : t.metAt !== null ? <span>met at block {t.metAt}, held by the attribution floor</span> : 'not met yet'}
            {p && MILESTONE[t.milestone] ? <div className="sub">{MILESTONE[t.milestone](p)}</div> : null}</>} />))}
      {p ? <Row k="Attribution" v={<>{pct(p.attribution.bps)} of new identities <span className="sub">(floor {pct(p.attribution.floorBps)} over {p.attribution.windowBlocks} blocks)</span></>} /> : null}
      {p ? p.sites.map((s) => <Row key={s.siteKey} k={<>Site key <span className="sub">{s.siteKey.slice(0, 12)}…</span></>} v={`${s.identities} identities · ${sats(s.grossMsat)} gross`} />) : null}
      {a.agreement ? <Row k="Tail after a leave" v={`${a.agreement.tailBlocks} blocks`} /> : null}
    </div>);
}

export class ContributionsPanel extends React.Component {
  constructor(props) { super(props); this.state = { got: null, why: '' }; }
  componentDidMount() { this.read(); this.timer = setInterval(() => this.read(), this.props.everyMs || 60000); }
  componentWillUnmount() { clearInterval(this.timer); }
  async read() {
    try {
      const got = await this.props.api.get('/contribution-shares?height=tip');
      this.setState({ got, why: '' });
    } catch (e) { this.setState({ why: e.message }); }
  }
  render() {
    const { got, why } = this.state;
    if (why) return <div className="card"><p className="sub">No contribution agreements read: {why}</p></div>;
    if (!got) return <div className="card"><p className="sub">Reading…</p></div>;
    if (!got.shares.length) return <div className="card"><p className="sub">The developers' set in force carries no contribution agreement.</p></div>;
    return <>{got.shares.map((a) => <ContributionCard key={a.recipient} a={a} height={got.height} />)}
      <p className="sub">Read from {got.book ? `${got.book.n} counted round(s) this node holds, the newest at census block ${got.book.top}` : 'no book'}. A share at a block reads the counted rounds a few blocks before it, so every node answers the same.</p></>;
  }
}
