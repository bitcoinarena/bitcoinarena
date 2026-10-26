// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROUND POSTING, ON THE OWNER PAGE (kanban #702, 2026-10-26, the owner: "The round runners must be an integrated part of the node"): one line
// from the node's own GET /duty - whether this node posts the rounds when it is on duty (arena.conf duty_post), where it stands in today's and
// tomorrow's duty order, whether its wallet can pay, and the last thing that went wrong. A node that answers no GET /duty (a release before
// it) shows nothing.
import React from 'react';

const n = (x) => Number(x).toLocaleString('en-US');
const hm = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 16)} UTC` : '?'; };
// WHAT THIS NODE OWES TODAY (the owner's ruling, 2026-10-26 ~11:4xZ: a primary grid from rank 1, a backup grid from rank 2 from 02:00 UTC,
// rank 3 an hour later): its rank and the grid it posts
const owesWord = (d) => {
  const me = (d.order || []).find((o) => o.self);
  if (!me) return 'this node is not in the first 3: it posts nothing today.';
  if (me.rank === 1) return `this node is rank 1: it posts the primary grid from ${hm(me.dueFrom)}.`;
  const backup = me.backupDueFrom ? (me.rank === 2 ? `it posts today's backup grid from ${hm(me.backupDueFrom)}` : `it posts the backup grid from ${hm(me.backupDueFrom)} if rank 2 has not`) : null;
  const primary = `the primary from ${hm(me.dueFrom)} if nobody before it has posted`;
  return `this node is rank ${me.rank}: ${backup ? `${backup}, and ${primary}` : `it posts ${primary}`}.`;
};

/** The line's words from GET /duty: { head, tone, more: [lines] }. */
export function postingWords(duty) {
  if (!duty || !duty.ok) return null;
  const w = duty.wallet || {};
  const today = (duty.days || []).find((d) => d.period === 'next');   // the day this node may post today: the rounds of the next 24 h
  const more = [];
  if (today) more.push(`Today's duty (the rounds of ${today.covers}): ${owesWord(today)}`);
  const posted = (duty.mine && duty.mine.posted) || [];
  if (posted.length) more.push(`Posted by this node: ${posted.map((p) => `${p.app} ${p.role === 'backup' ? '(backup) ' : ''}${p.emergency ? '(emergency grid) ' : ''}${String(p.txid).slice(0, 10)}`).join(', ')}.`);
  const le = duty.lastError;
  if (le) more.push(`Last error${le.app || le.role ? ` (${[le.app, le.role].filter(Boolean).join(', ')})` : ''}: ${le.why}`);
  if (!duty.on) return { tone: 'muted', head: duty.setting === 'off' ? 'off (duty_post=off in arena.conf)' : `off: ${w.why || 'this node cannot pay'}`, more };
  if (!w.canPay) return { tone: 'warn', head: `on, but this node cannot pay: ${w.why || 'no wallet with confirmed coins'}. When it is on duty the next node posts instead.`, more };
  const fee = `at ${duty.feeRate} sat/vB, at most ${duty.maxFeeRate}`;
  return { tone: 'ok', head: `on - the wallet${w.wallet ? ` "${w.wallet}"` : ''} can pay${w.confirmedSats != null ? ` (${n(w.confirmedSats)} sat confirmed)` : ''}, ${fee}`, more };
}

export class RoundPosting extends React.Component {
  constructor(props) { super(props); this.state = { loaded: false, duty: null, ...(props.initial || {}) }; }
  async componentDidMount() {
    if (this.state.loaded || !this.props.api) return;
    let duty = null; try { duty = await this.props.api.get('/duty'); } catch { duty = null; }
    this.setState({ loaded: true, duty });
  }
  render() {
    const words = this.state.loaded ? postingWords(this.state.duty) : null;
    if (!words) return null;
    return (
      <div className="round-posting">
        <div className="row"><span>Round posting</span><b className={words.tone === 'ok' ? 'ok' : words.tone === 'warn' ? 'warn' : 'sub'}>{words.head}</b></div>
        {words.more.map((l, i) => <p key={i} className="sub">{l}</p>)}
      </div>
    );
  }
}
