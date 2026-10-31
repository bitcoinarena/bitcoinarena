// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CREATE A MARKET (kanban #920, the owner 2026-10-31: "es wird immer die selbe ui verwendet ... Alles schaut sehr modern aus und ist einfach zu
// verstehen, keine wall of Text"): one step on screen, the card as players will see it beside it. A draft stays in this browser. Signing comes
// with the protocol field the market needs (docs/MARKET-CREATOR.md), so the last step says so and keeps the draft.
import React from 'react';
import { EVERY, KEPT, OUTCOMES_MAX, STEPS, TEMPLATES, fieldsOf, fromTemplate, outcomeOf, problemsOf, readAnswer, urlProblem } from './marketDraft.js';

const Err = ({ of }) => (of ? <span className="mc-err">{of}</span> : null);
const Field = ({ label, why, children }) => <label className="mc-f"><span>{label}</span>{children}<Err of={why} /></label>;
const Seg = ({ value, options, onPick }) => <div className="mc-seg" role="radiogroup">{options.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={v === value} className={v === value ? 'on' : undefined} onClick={() => onPick(v)}>{l}</button>)}</div>;
const scheduleLine = (s) => (s.mode === 'once' ? (s.resolveAt ? `Ends ${new Date(s.resolveAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : 'One round')
  : `Every ${(EVERY.find(([k]) => k === s.every) || [])[1]} · ${s.rounds} rounds`);

export class MarketCreator extends React.Component {
  constructor(props) {
    super(props);
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(KEPT) || 'null'); } catch { draft = null; }
    this.state = { step: draft ? 'question' : 'start', draft: draft || fromTemplate('blank'), sample: '', test: null, reading: false, shown: false, saved: false };
  }
  // WHAT THE ANSWER GIVES UNDER THE DRAFT AS IT STANDS (the owner 2026-10-31: "Auch die Optionen können live getestet werden"): every change of a field,
  // rule, level or outcome is read against the answer already held, with no new read; a new address drops that answer
  tryOn(draft, text) {
    if (!text) return null;
    const got = readAnswer(draft.source, text);
    return got.why ? { why: got.why } : { value: got.value, ...outcomeOf(draft, got.value) };
  }
  set(more, sample = this.state.sample) {
    const draft = { ...this.state.draft, ...more };
    this.setState({ draft, saved: false, sample, test: this.tryOn(draft, sample) });
    try { localStorage.setItem(KEPT, JSON.stringify(draft)); } catch { /* this draft lasts until the page goes */ }
  }
  source(more) { this.set({ source: { ...this.state.draft.source, ...more } }, 'url' in more ? '' : this.state.sample); }
  schedule(more) { this.set({ schedule: { ...this.state.draft.schedule, ...more } }); }
  go(step) { this.setState({ step, shown: false }); }
  next() {
    const { step, draft } = this.state; const at = STEPS.findIndex(([k]) => k === step);
    if (Object.keys(problemsOf(draft, step)).length) { this.setState({ shown: true }); return; }
    this.go(STEPS[at + 1][0]);
  }
  pick(id) { this.setState({ draft: fromTemplate(id), step: 'question', shown: false, test: null, sample: '' }); }
  run(text) { this.setState({ test: this.tryOn(this.state.draft, text) }); }
  // THE LIVE TEST, AT THE FIELD (the owner 2026-10-31: "Test Funktion um es live zu testen, ob es z.B. amount gibt"): the source read now, the field found
  // or not, and the fields the answer does hold to pick from. The browser reads it here; a site that forbids that needs the pasted answer
  async read() {
    const bad = urlProblem(this.state.draft.source.url);
    if (bad) { this.setState({ test: { why: bad } }); return; }
    this.setState({ reading: true, test: null });
    try {
      const r = await fetch(this.state.draft.source.url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
      const text = await r.text();
      if (!r.ok) throw new Error(`answered ${r.status}`);
      this.setState({ sample: text.slice(0, 1000000), reading: false }); this.run(text);
    } catch (e) { this.setState({ reading: false, test: { why: `This browser could not read it (${e.message}). Paste the answer in the Test step.` } }); }
  }
  tested() {
    const { test, sample, draft: d } = this.state;
    if (!test) return null;
    const fields = d.source.read === 'json' ? fieldsOf(sample) : [];
    return (<>
      {test.why ? <div className="mc-result bad">{test.why}</div>
        : <div className="mc-result ok"><span>Value <b>{test.value === '' ? 'nothing' : test.value}</b></span><span>Outcome <b>{test.outcome}</b></span>{test.note ? <small>{test.note}</small> : null}</div>}
      {fields.length ? <div className="mc-fields" aria-label="Fields in the answer">{fields.map(([path, value]) => <button key={path} type="button" className={path === d.source.path ? 'on' : undefined} title={value}
        onClick={() => this.source({ path })}><code>{path}</code><small>{value}</small></button>)}</div> : null}
    </>);
  }
  card() {
    const { draft: d, test } = this.state; const won = test && !test.why ? test.outcome : null;
    return (
      <div className="mc-card" aria-label="Preview">
        <small>{d.category || 'Category'}</small>
        <b>{d.title || 'Your question'}</b>
        {d.kind === 'number' ? <div className="mc-range"><span>{d.low || '–'}</span><i /><span>{d.high || '–'}</span>{won !== null ? <b>{won}</b> : null}</div>
          : <div className="mc-odds">{d.outcomes.map((o, i) => <span key={i} className={won !== null && o === won ? 'on' : undefined}>{o || '…'}</span>)}</div>}
        <small>{scheduleLine(d.schedule)}</small>
      </div>);
  }
  stepView() {
    const { step, draft: d, shown, test, sample, reading } = this.state;
    const bad = shown ? problemsOf(d, step) : {};
    if (step === 'start') return (
      <div className="mc-tiles">{TEMPLATES.map((t) => <button key={t.id} type="button" className="mc-tile" onClick={() => this.pick(t.id)}><i aria-hidden="true">{t.icon}</i><b>{t.name}</b><small>{t.hint}</small></button>)}</div>);
    if (step === 'question') return (<>
      <Field label="Question" why={bad.title}><input maxLength={120} value={d.title} onChange={(e) => this.set({ title: e.target.value })} /></Field>
      <Field label="Category" why={bad.category}><input maxLength={32} value={d.category} onChange={(e) => this.set({ category: e.target.value })} /></Field>
      <Seg value={d.kind} options={[['choice', 'Outcomes'], ['number', 'A number']]} onPick={(kind) => this.set({ kind, outcomes: kind === 'choice' && !d.outcomes.length ? ['Yes', 'No'] : d.outcomes })} />
      {d.kind === 'number' ? <div className="mc-two"><Field label="Low"><input inputMode="decimal" value={d.low} onChange={(e) => this.set({ low: e.target.value })} /></Field>
        <Field label="High" why={bad.bounds}><input inputMode="decimal" value={d.high} onChange={(e) => this.set({ high: e.target.value })} /></Field></div>
        : <div className="mc-list">{d.outcomes.map((o, i) => <div key={i} className="mc-row"><input aria-label={`Outcome ${i + 1}`} maxLength={40} value={o} onChange={(e) => this.set({ outcomes: d.outcomes.map((x, j) => (j === i ? e.target.value : x)) })} />
          {d.outcomes.length > 2 ? <button type="button" aria-label={`Remove outcome ${i + 1}`} onClick={() => this.set({ outcomes: d.outcomes.filter((x, j) => j !== i) })}>×</button> : null}</div>)}
          {d.outcomes.length < OUTCOMES_MAX ? <button type="button" className="mc-add" onClick={() => this.set({ outcomes: [...d.outcomes, ''] })}>Add outcome</button> : null}<Err of={bad.outcomes} /></div>}
    </>);
    if (step === 'result') {
      const s = d.source;
      return (<>
        <Seg value="url" options={[['url', 'A URL'], ['code', 'Code · soon']]} onPick={() => {}} />
        <Field label="Address the nodes read" why={bad.url}><input inputMode="url" placeholder="https://" value={s.url} onChange={(e) => this.source({ url: e.target.value })} /></Field>
        <Seg value={s.read} options={[['json', 'JSON field'], ['regex', 'Pattern'], ['text', 'Whole answer']]} onPick={(read) => this.source({ read })} />
        {s.read === 'text' ? null : <Field label={s.read === 'json' ? 'Field' : 'Pattern'} why={bad.path}><input className="mono" placeholder={s.read === 'json' ? 'data.amount' : 'Price: ([0-9.]+)'} value={s.path} onChange={(e) => this.source({ path: e.target.value })} /></Field>}
        <button type="button" className="mc-test" disabled={reading} onClick={() => this.read()}>{reading ? 'Reading…' : 'Test it live'}</button>
        {this.tested()}
        {d.kind === 'number' ? null : <>
          <Seg value={s.rule} options={[['above', 'At or above'], ['below', 'Below'], ['rises', 'Rises'], ['equals', 'Names outcome'], ['found', 'Is found']]} onPick={(rule) => this.source({ rule })} />
          {s.rule === 'above' || s.rule === 'below' ? <Field label="Level" why={bad.value}><input inputMode="decimal" value={s.value} onChange={(e) => this.source({ value: e.target.value })} /></Field> : null}</>}
      </>);
    }
    if (step === 'test') return (<>
      <button type="button" className="primary" disabled={reading} onClick={() => this.read()}>{reading ? 'Reading…' : 'Read it now'}</button>
      <Field label="Or paste an answer"><textarea className="mono" rows={5} spellCheck={false} value={sample} onChange={(e) => { this.setState({ sample: e.target.value }); this.run(e.target.value); }} /></Field>
      {this.tested()}
    </>);
    if (step === 'schedule') {
      const s = d.schedule;
      return (<>
        <Seg value={s.mode} options={[['once', 'One time'], ['repeat', 'Repeats']]} onPick={(mode) => this.schedule({ mode })} />
        {s.mode === 'once' ? <div className="mc-two"><Field label="Result at" why={bad.resolveAt}><input type="datetime-local" value={s.resolveAt} onChange={(e) => this.schedule({ resolveAt: e.target.value })} /></Field>
          <Field label="Entries close, minutes before" why={bad.closeBeforeMin}><input inputMode="numeric" value={s.closeBeforeMin} onChange={(e) => this.schedule({ closeBeforeMin: e.target.value })} /></Field></div>
          : <><Seg value={s.every} options={EVERY.map(([k, l]) => [k, l])} onPick={(every) => this.schedule({ every })} />
            <Field label="Rounds" why={bad.rounds}><input inputMode="numeric" value={s.rounds} onChange={(e) => this.schedule({ rounds: e.target.value })} /></Field></>}
        <Field label="Smallest stake, sat" why={bad.minStakeSat}><input inputMode="numeric" value={s.minStakeSat} onChange={(e) => this.schedule({ minStakeSat: e.target.value })} /></Field>
      </>);
    }
    const rows = [['Question', d.title], ['Category', d.category], ['Source', d.source.url], ['When', scheduleLine(d.schedule)]];
    return (<>
      <dl className="mc-sum">{rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
      <button type="button" className="primary" disabled>Sign and publish</button>
      <p className="mc-note">Signing arrives with the next node release. Your draft stays in this browser.</p>
    </>);
  }
  render() {
    const { step, draft } = this.state; const at = STEPS.findIndex(([k]) => k === step);
    return (
      <div className="mc">
        <ol className="mc-steps">{STEPS.map(([k, l], i) => <li key={k} className={i === at ? 'on' : i < at ? 'done' : undefined}>
          {i < at ? <button type="button" onClick={() => this.go(k)}>{l}</button> : <span aria-current={i === at ? 'step' : undefined}>{l}</span>}</li>)}</ol>
        <div className="mc-body">
          <div className="mc-pane">
            {this.stepView()}
            {step === 'start' ? null : <div className="mc-nav">
              <button type="button" onClick={() => this.go(STEPS[at - 1][0])}>Back</button>
              {step === 'sign' ? null : <button type="button" className="primary" onClick={() => this.next()}>Next</button>}</div>}
          </div>
          {step === 'start' ? null : this.card()}
        </div>
        {draft && step !== 'start' ? <button type="button" className="mc-link" onClick={() => { try { localStorage.removeItem(KEPT); } catch { /* nothing kept */ } this.setState({ draft: fromTemplate('blank'), step: 'start', test: null, sample: '' }); }}>Start over</button> : null}
      </div>);
  }
}
