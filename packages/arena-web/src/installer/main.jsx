// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S REACT STEPS, MOUNTED (kanban #564): window.ArenaWizard.show(step, sectionOf, { st, post, get, reload }) draws the
// current step into its section and answers true - every other step is taken down, so its timers stop - and answers false for the roles,
// which mount(step, element, props) draws into their list (with onCustody). One root per element, drawn again on every load() with the
// new state. The page loads this file before its own script (a plain script, not a module), so the first load() already finds it; the
// page draws no step of its own (2026-10-21: "no fall backs").
import React from 'react';
import { createRoot } from 'react-dom/client';
import { StartStep, RolesStep, AppsStep, SeedStep, EmergencyStep, OwnerStep, PromiseStep, StepBar, SetupRefused } from './WizardSteps.jsx';
import { ChainStep, ReachStep, ServiceStep, FederationStep } from './SetupSteps.jsx';
import { LightningStep, BondStep, DoneStep } from './FinishSteps.jsx';
import css from './wizard.css';

const STEPS = { start: StartStep, roles: RolesStep, chain: ChainStep, apps: AppsStep, seed: SeedStep, emergency: EmergencyStep, owner: OwnerStep, reach: ReachStep, service: ServiceStep,
  lightning: LightningStep, federation: FederationStep, promise: PromiseStep, bond: BondStep, done: DoneStep };
// the steps that draw their whole section (the roles draw only their list: the pictures around it stay the page's)
const SECTIONS = Object.keys(STEPS).filter((k) => k !== 'roles');

export function mount(step, element, props) {
  const Step = STEPS[step];
  if (!Step || !element) return false;
  if (!element._awRoot) { element.textContent = ''; element._awRoot = createRoot(element); }
  element._awRoot.render(<Step {...props} />);
  return true;
}

/** The wizard's current step drawn into its section, and every other ported step taken down (its timers stop). Answers whether the
 *  current step is a ported one. */
export function show(step, sectionOf, props) {
  for (const k of SECTIONS) {
    const el = sectionOf(k);
    if (!el) continue;
    if (k === step) mount(k, el, props);
    else if (el._awRoot) { el._awRoot.unmount(); el._awRoot = null; }
  }
  return SECTIONS.includes(step);
}

if (typeof document !== 'undefined') {
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  // the bar of steps along the top, and the page's one line when the installer cannot set up here
  const draw = (element, node) => { if (!element._awRoot) { element.textContent = ''; element._awRoot = createRoot(element); } element._awRoot.render(node); };
  window.ArenaWizard = { mount, show, steps: Object.keys(STEPS), bar: (element, props) => draw(element, <StepBar {...props} />),
    refused: (element, props) => draw(element, <SetupRefused {...props} />) };
}
