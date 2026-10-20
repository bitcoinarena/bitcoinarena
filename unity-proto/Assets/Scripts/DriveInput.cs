// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

/// <summary>
/// Throttle, steering and handbrake, read from whichever input backend the
/// project is set to. The URP template ships with Active Input Handling set to
/// the Input System package only, where the legacy UnityEngine.Input class
/// throws on first use - so this reads Keyboard.current directly and needs no
/// action asset, no bindings and no scene wiring.
/// </summary>
public static class DriveInput
{
    /// <summary>
    /// Written every frame by TouchControls. Merged with the keyboard rather
    /// than replacing it, so a phone and a laptop behave the same and a tester
    /// can use either.
    /// </summary>
    public static float TouchThrottle;
    public static float TouchSteer;
    public static bool TouchHandbrake;
    /// <summary>Set for a single frame by TouchControls when the view pad is tapped.</summary>
    public static bool TouchCameraTapped;

    static float Merge(float key, float touch) => Mathf.Abs(touch) > Mathf.Abs(key) ? touch : key;

    /// <summary>
    /// NO DRIVING AFTER THE RUN (2026-09-27 13:25: after WASTED and after a delivery "WASD still steers and the
    /// drive sound plays ... No partial control after the round ends. No throttle, no steer, no drive sound"). Once the
    /// core has named the run - DELIVERED, WRECKED, MISSED latch in `S_STATE` - or the session says it ended, throttle,
    /// steer and handbrake read nothing, for every reader: the core's inputs, the wheels, the engine note. A roll-out
    /// that restarts the core (off a live round) makes the state live again, and the inputs with it.
    /// </summary>
    public static bool RunIsOver(bool coreAvailable, int runState, bool sessionEnded)
        => (coreAvailable && runState != 0) || sessionEnded;

    static bool Over => RunIsOver(Arena.ArenaCore.Available, Arena.ArenaCore.Available ? Arena.ArenaCore.RunState : 0, Arena.ArenaNet.Ended);

    /// <summary>Whether the run is over now, as the inputs read it.</summary>
    public static bool RunOver => Over;
    /// <summary>What the keys and pads hold, before the end of the run is applied - for the after-the-end log.</summary>
    public static float HeldThrottle => RawThrottle;
    public static float HeldSteer => RawSteer;

    /// <summary>-1 reverse / brake, +1 throttle; nothing once the run is over.</summary>
    public static float Throttle => Over ? 0f : RawThrottle;

    /// <summary>-1 left, +1 right; nothing once the run is over.</summary>
    public static float Steer => Over ? 0f : RawSteer;

    static float RawThrottle
    {
        get
        {
#if ENABLE_INPUT_SYSTEM
            var k = Keyboard.current;
            if (k == null) return TouchThrottle;
            float v = 0f;
            if (k.wKey.isPressed || k.upArrowKey.isPressed) v += 1f;
            if (k.sKey.isPressed || k.downArrowKey.isPressed) v -= 1f;
            return Merge(v, TouchThrottle);
#else
            return Input.GetAxisRaw("Vertical");
#endif
        }
    }

    static float RawSteer
    {
        get
        {
#if ENABLE_INPUT_SYSTEM
            var k = Keyboard.current;
            if (k == null) return TouchSteer;
            float v = 0f;
            if (k.dKey.isPressed || k.rightArrowKey.isPressed) v += 1f;
            if (k.aKey.isPressed || k.leftArrowKey.isPressed) v -= 1f;
            return Merge(v, TouchSteer);
#else
            return Input.GetAxisRaw("Horizontal");
#endif
        }
    }

    /// <summary>
    /// Switch between the chase cam and the overview. Edge-triggered. `G` only: `Tab` is the chart's range
    /// (WAR_TACTICS.md §0.3), and one key doing both flipped the camera every time the player changed range.
    /// </summary>
    public static bool CameraToggle
    {
        get
        {
            if (TouchCameraTapped) return true;
#if ENABLE_INPUT_SYSTEM
            var k = Keyboard.current;
            return k != null && k.gKey.wasPressedThisFrame;
#else
            return Input.GetKeyDown(KeyCode.G);
#endif
        }
    }

    /// <summary>Put the truck back on its start mark.</summary>
    public static bool Reset
    {
        get
        {
#if ENABLE_INPUT_SYSTEM
            return Keyboard.current != null && Keyboard.current.rKey.wasPressedThisFrame;
#else
            return Input.GetKeyDown(KeyCode.R);
#endif
        }
    }

    public static bool Handbrake
    {
        get
        {
            if (Over) return false;
#if ENABLE_INPUT_SYSTEM
            return TouchHandbrake || (Keyboard.current != null && Keyboard.current.spaceKey.isPressed);
#else
            return Input.GetKey(KeyCode.Space);
#endif
        }
    }
}
