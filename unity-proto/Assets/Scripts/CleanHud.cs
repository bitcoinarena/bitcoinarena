// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// CLEAN SCREEN FOR THE TRAILER (2026-09-27: "remove all HUDs with a secret key, player controls included -
/// they still work - so the trailer does not have an overloaded UI"). Shift+H toggles it. While it is on, every
/// gameplay OnGUI returns before drawing - DriveHud, ChartHud, the pads, the loadout, the spectate EXIT and the
/// other players' labels - and the page hides its own HTML overlays (wallet, backup warning, node line).
/// Only the drawing stops: the pads, the keyboard and the spectate camera read their input in Update, so the
/// truck still drives. The title screen is not covered - it is a menu, not a HUD.
/// </summary>
public static class CleanHud
{
    public static bool On { get; private set; }

    /// <summary>Called once a frame by DriveHud.Update.</summary>
    public static void Poll()
    {
#if ENABLE_INPUT_SYSTEM
        var k = UnityEngine.InputSystem.Keyboard.current;
        if (k == null || !k.hKey.wasPressedThisFrame || !k.shiftKey.isPressed) return;
#else
        if (!Input.GetKeyDown(KeyCode.H) || !(Input.GetKey(KeyCode.LeftShift) || Input.GetKey(KeyCode.RightShift))) return;
#endif
        On = !On;
        Arena.DailyLobby.HudClean(On);
    }
}
