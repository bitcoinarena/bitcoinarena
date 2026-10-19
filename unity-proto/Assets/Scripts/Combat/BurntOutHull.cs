// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// Marks a wreck: something that was destroyed and is now scenery.
///
/// Wrecks and live tanks are both solid and both sit on the unit layer, so a
/// collision cannot tell them apart by physics alone. Ramming a tank writes the
/// truck off; shunting a burnt-out hull only costs paint.
/// </summary>
public class BurntOutHull : MonoBehaviour { }
