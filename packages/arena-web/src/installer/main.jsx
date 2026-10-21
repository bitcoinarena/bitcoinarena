// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S REACT STEPS, MOUNTED (kanban #564): window.ArenaWizard.mount(step, element, { st, post, reload, onCustody }) draws a
// ported step into the wizard page and answers true; for a step not ported yet it answers false and the page draws its own. One root per
// element, drawn again on every load() with the new state. The page loads this file before its own script (a plain script, not a
// module), so the first load() already finds it; without the file the page is the one it always was.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RolesStep, SeedStep, OwnerStep, PromiseStep } from './WizardSteps.jsx';
import css from './wizard.css';

const STEPS = { roles: RolesStep, seed: SeedStep, owner: OwnerStep, promise: PromiseStep };

export function mount(step, element, props) {
  const Step = STEPS[step];
  if (!Step || !element) return false;
  if (!element._awRoot) { element.textContent = ''; element._awRoot = createRoot(element); }
  element._awRoot.render(<Step {...props} />);
  return true;
}

if (typeof document !== 'undefined') {
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  window.ArenaWizard = { mount, steps: Object.keys(STEPS) };
}
