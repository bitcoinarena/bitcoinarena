// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// "MY NODE IS OFFLINE" IN REACT, MOUNTED (kanban #564): window.ArenaEmergency.mount(element, { client, get, post, dashboardHref }) - the
// page hands in the node's own /owner/client.js and its fetches; it keeps its own steps when this file is not there.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { EmergencyPage } from './EmergencyPage.jsx';

export function mount(element, props) { createRoot(element).render(<EmergencyPage {...props} />); }
if (typeof window !== 'undefined') window.ArenaEmergency = { mount };
