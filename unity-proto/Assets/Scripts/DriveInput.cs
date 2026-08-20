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

    static float Merge(float key, float touch) => Mathf.Abs(touch) > Mathf.Abs(key) ? touch : key;

    /// <summary>-1 reverse / brake, +1 throttle.</summary>
    public static float Throttle
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

    /// <summary>-1 left, +1 right.</summary>
    public static float Steer
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
#if ENABLE_INPUT_SYSTEM
            return TouchHandbrake || (Keyboard.current != null && Keyboard.current.spaceKey.isPressed);
#else
            return Input.GetKey(KeyCode.Space);
#endif
        }
    }
}
