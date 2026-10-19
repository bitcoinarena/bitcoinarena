// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

/// <summary>
/// On-screen driving controls for phones.
///
/// Deliberately NOT GUI.Button: that resolves one press at a time, and driving
/// needs throttle and steering held together. Touch points are hit-tested
/// against the pad rects directly, so every finger counts.
///
/// Arrows are rasterised into textures rather than drawn as glyphs, because
/// the geometric-shape characters are not guaranteed to exist in the default
/// font and would render as empty boxes.
/// </summary>
public class TouchControls : MonoBehaviour
{
    public bool forceShow;

    /// <summary>
    /// Stand in for real fingers. When set, these GUI-space points replace the
    /// touchscreen - so a test can press the actual pad rectangles and drive
    /// the truck through the whole chain rather than around it.
    /// </summary>
    public List<Vector2> debugPoints;

    readonly List<Vector2> _points = new List<Vector2>();
    bool _viewHeld;
    Texture2D _flat;
    readonly Dictionary<TouchPad.Pad, Texture2D> _arrows = new Dictionary<TouchPad.Pad, Texture2D>();

    /// <summary>Show on touch devices, and on desktop only when asked (so it can be checked).</summary>
    public bool Visible => forceShow || TouchScreen;

    /// <summary>
    /// A touch device: the pads are the controls. Otherwise a desktop (the HUD chart goes top right there).
    ///
    /// THE OWNER'S DESKTOP REPORTS ONE and draws the pads - that is what the 20:22 letter is about, and where the pads
    /// are drawn the mouse now drives them (AMouseOnTheGasPadDrivesTheTruck presses a real mouse device on the gas
    /// pad). Drawing them on a screen that reports NO touch device is a layout question, not an input one: measured,
    /// the HUD has no room for the score column beside the pads at 1024x768. Written down in TASKBOOK.
    /// </summary>
    public static bool TouchScreen => Application.isMobilePlatform
#if ENABLE_INPUT_SYSTEM
        || Touchscreen.current != null
#endif
        ;

    void Awake()
    {
        _flat = new Texture2D(1, 1); _flat.SetPixel(0, 0, Color.white); _flat.Apply();
        foreach (TouchPad.Pad p in System.Enum.GetValues(typeof(TouchPad.Pad)))
            if (p != TouchPad.Pad.Handbrake && p != TouchPad.Pad.View) _arrows[p] = MakeArrow(p);
    }

    /// <summary>Solid triangle pointing the pad's way, on a transparent field.</summary>
    static Texture2D MakeArrow(TouchPad.Pad pad)
    {
        const int N = 64;
        var t = new Texture2D(N, N, TextureFormat.RGBA32, false);
        var px = new Color32[N * N];
        for (int y = 0; y < N; y++)
            for (int x = 0; x < N; x++)
            {
                // work in a canonical "points up" space, then rotate the sample
                float u = (x + 0.5f) / N, v = (y + 0.5f) / N;
                float cu, cv;
                switch (pad)
                {
                    case TouchPad.Pad.Up:    cu = u;     cv = v;     break;
                    case TouchPad.Pad.Down:  cu = u;     cv = 1 - v; break;
                    case TouchPad.Pad.Left:  cu = v;     cv = 1 - u; break;
                    default:                 cu = 1 - v; cv = u;     break;   // Right
                }
                // triangle: apex at cv=0.86, base at cv=0.18
                float t01 = Mathf.InverseLerp(0.86f, 0.18f, cv);
                bool inside = t01 >= 0f && t01 <= 1f && Mathf.Abs(cu - 0.5f) <= t01 * 0.40f;
                px[y * N + x] = inside ? new Color32(255, 255, 255, 255) : new Color32(255, 255, 255, 0);
            }
        t.SetPixels32(px); t.Apply();
        t.filterMode = FilterMode.Bilinear;
        return t;
    }

    void Update()
    {
        _points.Clear();
        if (debugPoints != null) { _points.AddRange(debugPoints); Apply(); return; }
        if (!Visible) { Apply(); return; }
#if ENABLE_INPUT_SYSTEM
        var ts = Touchscreen.current;
        if (ts != null)
            foreach (var t in ts.touches)
                if (t.press.isPressed)
                {
                    var p = t.position.ReadValue();
                    // input space is origin bottom-left, GUI space is top-left
                    _points.Add(new Vector2(p.x, Screen.height - p.y));
                }
        var m = Mouse.current;
        if (m != null && m.leftButton.isPressed)
        {
            var p = m.position.ReadValue();
            _points.Add(new Vector2(p.x, Screen.height - p.y));
        }
#endif
        Apply();
    }

    void Apply()
    {
        TouchPad.Resolve(_points, Screen.width, Screen.height,
                         out var throttle, out var steer, out var handbrake);
        DriveInput.TouchThrottle = throttle;
        DriveInput.TouchSteer = steer;
        DriveInput.TouchHandbrake = handbrake;

        // the view pad is a tap, not a hold: fire on the press edge only, or
        // resting a thumb on it flips the camera every frame
        bool view = TouchPad.Hit(TouchPad.Pad.View, Screen.width, Screen.height, _points);
        DriveInput.TouchCameraTapped = view && !_viewHeld;
        _viewHeld = view;
    }

    void OnGUI()
    {
        if (!Visible || CleanHud.On) return;
        int w = Screen.width, h = Screen.height;

        foreach (TouchPad.Pad pad in System.Enum.GetValues(typeof(TouchPad.Pad)))
        {
            // The handbrake and the view toggle are off the screen. Neither is
            // something a player reaches for mid-run, and both were taking room
            // the score needs. The INPUTS stay - the keys still work, and the
            // god view is shown behind the splash screen instead.
            // The settings buttons are drawn by the HUD, which owns their
            // labels and their state; here they would be two blank pads.
            if (pad == TouchPad.Pad.Handbrake || pad == TouchPad.Pad.View
                || pad == TouchPad.Pad.Sound || pad == TouchPad.Pad.Debug) continue;

            var r = TouchPad.RectFor(pad, w, h);
            bool held = TouchPad.Hit(pad, w, h, _points);

            // pad face, then a brighter ring, so it reads over both sky and dirt
            GUI.color = held ? new Color(1f, 0.78f, 0.2f, 0.72f) : new Color(0f, 0f, 0f, 0.42f);
            GUI.DrawTexture(r, _flat);
            GUI.color = held ? new Color(1f, 1f, 1f, 0.95f) : new Color(1f, 1f, 1f, 0.55f);
            DrawRing(r, Mathf.Max(2f, r.width * 0.035f));

            if (pad == TouchPad.Pad.View)
            {
                var vs = new GUIStyle(GUI.skin.label)
                {
                    alignment = TextAnchor.MiddleCenter,
                    fontSize = Mathf.RoundToInt(r.width * 0.30f),
                    fontStyle = FontStyle.Bold,
                };
                vs.normal.textColor = held ? Color.black : Color.white;
                GUI.Label(r, "VIEW", vs);
            }
            else if (pad == TouchPad.Pad.Handbrake)
            {
                var st = new GUIStyle(GUI.skin.label)
                {
                    alignment = TextAnchor.MiddleCenter,
                    fontSize = Mathf.RoundToInt(r.width * 0.22f),
                    fontStyle = FontStyle.Bold,
                };
                st.normal.textColor = held ? Color.black : Color.white;
                GUI.Label(r, "HAND\nBREMSE", st);
            }
            else
            {
                var inner = new Rect(r.x + r.width * 0.22f, r.y + r.height * 0.22f, r.width * 0.56f, r.height * 0.56f);
                GUI.color = held ? new Color(0.1f, 0.08f, 0f, 1f) : new Color(1f, 1f, 1f, 0.9f);
                GUI.DrawTexture(inner, _arrows[pad], ScaleMode.ScaleToFit, true);
            }
        }
        GUI.color = Color.white;
    }

    void DrawRing(Rect r, float t)
    {
        GUI.DrawTexture(new Rect(r.x, r.y, r.width, t), _flat);
        GUI.DrawTexture(new Rect(r.x, r.yMax - t, r.width, t), _flat);
        GUI.DrawTexture(new Rect(r.x, r.y, t, r.height), _flat);
        GUI.DrawTexture(new Rect(r.xMax - t, r.y, t, r.height), _flat);
    }
}
