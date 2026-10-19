// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// Screen layout and hit testing for the on-screen driving controls, kept as
/// pure functions so the placement can be tested without a device.
///
/// Rects are in GUI space: origin top-left, y down.
/// </summary>
public static class TouchPad
{
    public enum Pad { Left, Right, Up, Down, Handbrake, View, Sound, Debug }

    /// <summary>
    /// Button size. Thumbs are blunt and a phone held in landscape has very
    /// little vertical room, so this is driven by the SHORT edge - a wide
    /// screen must not inflate the buttons past the height available.
    /// </summary>
    public static float ButtonSize(int screenW, int screenH)
        => Mathf.Max(76f, Mathf.Min(screenW, screenH) * 0.20f);

    public static float Margin(int screenW, int screenH)
        => Mathf.Max(14f, Mathf.Min(screenW, screenH) * 0.035f);

    /// <summary>
    /// Steering on the left thumb, throttle and brake on the right, handbrake
    /// inboard of the throttle - the layout a thumb can reach without the hand
    /// leaving the edge of the device.
    /// </summary>
    public static Rect RectFor(Pad pad, int screenW, int screenH)
    {
        float s = ButtonSize(screenW, screenH);
        float m = Margin(screenW, screenH);
        float bottom = screenH - m - s;

        switch (pad)
        {
            case Pad.Left:      return new Rect(m, bottom, s, s);
            case Pad.Right:     return new Rect(m + s + m * 0.5f, bottom, s, s);
            case Pad.Up:        return new Rect(screenW - m - s, bottom - s - m * 0.5f, s, s);
            case Pad.Down:      return new Rect(screenW - m - s, bottom, s, s);
            case Pad.Handbrake: return new Rect(screenW - m - s * 2f - m * 0.5f, bottom, s, s);
            // top-left is the diagnostics box and top-centre is the price, so
            // the view toggle goes top-right where nothing else lives
            case Pad.View:      return new Rect(screenW - m - s * 0.7f, m, s * 0.7f, s * 0.7f);

            // Settings, top-right under the view toggle. Registered as pads so
            // a drag that starts on one looks around nothing - the camera
            // guard walks this enum.
            // BELOW the view toggle, not on top of it. They were placed at the
            // same origin, so a click on SOUND also registered as a tap on the
            // view pad and flipped the camera to the god view - which reads as
            // the on-screen buttons not working at all.
            // ICONS, side by side, not two stacked word-buttons. As text they
            // were two grey slabs the height of the block board, stacked down
            // the right edge of a phone, and MUTED and DEBUG are the two least
            // interesting things on the screen. Square and paired they take one
            // row instead of two and the same width the view toggle already
            // uses, so the right column did not get wider.
            case Pad.Sound:     return new Rect(screenW - m - s * 0.7f,
                                                m + s * 0.80f, s * 0.34f, s * 0.34f);
            case Pad.Debug:     return new Rect(screenW - m - s * 0.34f,
                                                m + s * 0.80f, s * 0.34f, s * 0.34f);
            default:            return new Rect();
        }
    }

    /// <summary>Is any of the given GUI-space points inside this pad?</summary>
    public static bool Hit(Pad pad, int screenW, int screenH, System.Collections.Generic.IList<Vector2> points)
    {
        if (points == null || points.Count == 0) return false;
        var r = RectFor(pad, screenW, screenH);
        for (int i = 0; i < points.Count; i++)
            if (r.Contains(points[i])) return true;
        return false;
    }

    /// <summary>
    /// Fingers to controls. Pure, so the whole chain from a touch position to a
    /// throttle value can be tested without a device or a screenshot.
    /// </summary>
    public static void Resolve(System.Collections.Generic.IList<Vector2> points, int screenW, int screenH,
                               out float throttle, out float steer, out bool handbrake)
    {
        bool up = Hit(Pad.Up, screenW, screenH, points);
        bool down = Hit(Pad.Down, screenW, screenH, points);
        bool left = Hit(Pad.Left, screenW, screenH, points);
        bool right = Hit(Pad.Right, screenW, screenH, points);
        throttle = (up ? 1f : 0f) - (down ? 1f : 0f);
        steer = (right ? 1f : 0f) - (left ? 1f : 0f);
        handbrake = Hit(Pad.Handbrake, screenW, screenH, points);
    }

    /// <summary>True when no two pads overlap, which is what makes multi-touch honest.</summary>
    public static bool LayoutIsDisjoint(int screenW, int screenH)
    {
        var pads = (Pad[])System.Enum.GetValues(typeof(Pad));
        for (int i = 0; i < pads.Length; i++)
            for (int j = i + 1; j < pads.Length; j++)
                if (RectFor(pads[i], screenW, screenH).Overlaps(RectFor(pads[j], screenW, screenH)))
                    return false;
        return true;
    }

    /// <summary>True when every pad sits fully on screen.</summary>
    public static bool LayoutFitsOnScreen(int screenW, int screenH)
    {
        var screen = new Rect(0, 0, screenW, screenH);
        foreach (Pad p in System.Enum.GetValues(typeof(Pad)))
        {
            var r = RectFor(p, screenW, screenH);
            if (!screen.Contains(new Vector2(r.xMin, r.yMin)) || !screen.Contains(new Vector2(r.xMax, r.yMax)))
                return false;
        }
        return true;
    }
}
