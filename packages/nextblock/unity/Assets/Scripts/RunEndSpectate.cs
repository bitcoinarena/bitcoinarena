// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

/// <summary>
/// SPECTATE AFTER THE RUN (2026-10-03, PRIORITIES: "When wrecked/finished the *real* spectate mode should run"; the
/// letter: "when the run ends WRECKED or FINISHED, switch to a free-roam spectate camera instead of freezing ... over about
/// 3 s it rises from the chase view to a steep top-down view. Then arrows or swipe pan, and pinch or wheel zoom").
///
/// Display only. The core has already named the run (DELIVERED or WRECKED latch in S_STATE) and DriveInput reads no
/// throttle or steer after that, so the keys and pads that drove the truck now move this camera and nothing else: the
/// truck stays where the run ended. The HUD - the block timer, the result card and its controls - is drawn over whatever
/// camera is up and stays. A MISSED run is not this: the block closed on a truck still driving.
///
/// The chase camera is switched off while this has the view and back on when the next run's cargo panel opens or the
/// core is live again.
/// </summary>
public class RunEndSpectate : MonoBehaviour
{
    public ChaseCamera chase;
    public Transform truck;
    public LoadoutPanel loadout;
    public SpectatorCamera spectator;
    /// <summary>The death sequence: in a live round this waits for its band to hold and fade.</summary>
    public WastedSequence wasted;
    /// <summary>The truck's wreck: put right when the next run's bay opens under this camera.</summary>
    public TruckHealth health;
    float _endSeenAt = -1f;

    [Tooltip("Seconds the rise from the chase view to the top-down view takes.")]
    public float riseSeconds = 3f;
    [Tooltip("Degrees below the horizon the top-down view looks: steep, not straight down, so the map keeps a direction.")]
    public float topPitch = 78f;
    public float startHeight = 80f;
    public float minHeight = 20f;
    public float maxHeight = 420f;
    [Tooltip("Pan speed, in screen heights a second at full stick.")]
    public float panRate = 0.9f;

    public bool Active { get; private set; }
    /// <summary>0 at the end of the run, 1 once the camera is top-down.</summary>
    public float Rise => Active ? Mathf.Clamp01(_t / Mathf.Max(0.01f, riseSeconds)) : 0f;
    /// <summary>The ground point the top-down view is centred on.</summary>
    public Vector3 Focus => _focus;
    public float Height => _height;

    Camera _cam;
    Vector3 _focus, _fromPos;
    Quaternion _fromRot;
    float _yaw, _height, _t;
    bool _dragging, _pinching;
    Vector2 _pressAt, _lastPointer;
    float _lastPinch;

    /// <summary>The top-down pose over <paramref name="focus"/>: steep, facing <paramref name="yaw"/>, <paramref name="height"/> up.</summary>
    public static Pose TopPose(Vector3 focus, float yaw, float height, float pitch)
    {
        var rot = Quaternion.Euler(pitch, yaw, 0f);
        // back along the view by the height over the sine of the pitch: the focus is the centre of the screen
        var pos = focus - rot * Vector3.forward * (height / Mathf.Max(0.05f, Mathf.Sin(pitch * Mathf.Deg2Rad)));
        return new Pose(pos, rot);
    }

    /// <summary>The focus after a pan: stick (x right, y up the screen) at a rate in screen heights a second.</summary>
    public static Vector3 Panned(Vector3 focus, float yaw, Vector2 stick, float height, float rate, float dt)
    {
        var fwd = Quaternion.Euler(0f, yaw, 0f) * Vector3.forward;
        var right = Quaternion.Euler(0f, yaw, 0f) * Vector3.right;
        float metres = height * rate * dt;
        return focus + (right * stick.x + fwd * stick.y) * metres;
    }

    /// <summary>The height after a zoom of <paramref name="steps"/> (positive closer), clamped.</summary>
    public static float Zoomed(float height, float steps, float min, float max)
        => Mathf.Clamp(height * Mathf.Exp(-0.15f * steps), min, max);

    void Awake() => _cam = GetComponent<Camera>();

    /// <summary>The run has ended: take the view from where the chase camera has it and rise over <paramref name="at"/>.</summary>
    public void Begin(Vector3 at)
    {
        if (Active) return;
        Active = true;
        _t = 0f;
        _focus = new Vector3(at.x, at.y, at.z);
        _fromPos = transform.position;
        _fromRot = transform.rotation;
        // up the screen stays the way the chase camera was looking
        var f = transform.forward; f.y = 0f;
        _yaw = f.sqrMagnitude > 1e-4f ? Quaternion.LookRotation(f.normalized, Vector3.up).eulerAngles.y : 0f;
        _height = startHeight;
        _dragging = _pinching = false;
        if (chase != null) chase.enabled = false;
        Debug.Log($"[arena] spectate: the run is over, the camera rises over {at.x:0},{at.z:0}");
    }

    public void Leave()
    {
        if (!Active) return;
        Active = false;
        if (chase != null) chase.enabled = true;
        _leftAt = Time.unscaledTime; _reportFrom = _leftAt; _reported = false;
        Debug.Log("[arena] spectate: back to the chase camera");
    }

    // THE NEXT TRUCK IN VIEW: 2 s after spectate lets go, where the camera is against the truck, once.
    float _leftAt = -1f, _reportFrom = -1f;
    bool _reported;
    void ReportChase()
    {
        if (_leftAt < 0f || truck == null) return;
        // reported 2 s after the camera last settled: after the hand-back, or after a cut fly-in
        if (_reportFrom < _leftAt) _reportFrom = _leftAt;
        if (chase != null && chase.Flying) { _reportFrom = Time.unscaledTime; return; }
        if (Time.unscaledTime - _reportFrom < 2f) return;
        if (Time.unscaledTime - _leftAt > 60f) { _leftAt = -1f; return; }
        if (_reported) return;
        _reported = true;
        var cam = _cam != null ? _cam.transform : transform;
        float d = Vector3.Distance(cam.position, truck.position);
        float ahead = Vector3.Dot(cam.forward, (truck.position - cam.position).normalized);
        Debug.Log($"[arena] chase: 2 s after spectate, the camera is {d:0.0} m from the truck, facing it {ahead:0.00}, chase on {(chase != null && chase.enabled)}, death orbit {(chase != null && chase.deathOrbit.HasValue ? "set" : "none")}, truck {(health != null && health.IsDestroyed ? "still a wreck" : "whole")}");
    }

    /// <summary>Whether the core says this live round's run ended WRECKED or DELIVERED (a MISSED end is not spectated).</summary>
    static bool RunEndedHere()
    {
        if (!Arena.ArenaCore.Available || DeliveryGate.BackToTheBay(Arena.ArenaNet.RoundSeed)) return false;
        int s = Arena.ArenaCore.RunState;
        return s == Arena.Layout.RUN_DELIVERED || s == Arena.Layout.RUN_WRECKED;
    }

    void Update()
    {
        bool cargoOpen = loadout != null && loadout.IsOpen;
        if (!Active)
        {
            bool ended = RunEndedHere();
            if (!ended) _endSeenAt = -1f; else if (_endSeenAt < 0f) _endSeenAt = Time.unscaledTime;
            // A WRECK WAITS FOR ITS WASTED: the core names the wreck in the same frame the truck's health does, so
            // "no band up yet" is not "the band is over" - measured on 0.0.2731, the rise began 0.1 s before WASTED came up.
            // It starts once this wreck's sequence has ended, or after hold + fade + 0.5 s if none ever came up.
            bool waitWasted = ended && wasted != null && Arena.ArenaCore.RunState == Arena.Layout.RUN_WRECKED
                && (wasted.BandUp || (wasted.LiveEndedAt < _endSeenAt
                    && Time.unscaledTime - _endSeenAt < wasted.holdSeconds + wasted.fadeOutSeconds + 0.5f));
            if (!cargoOpen && truck != null && (spectator == null || !spectator.Active) && !waitWasted && ended) Begin(truck.position);
            // STRAIGHT ONTO THE NEXT TRUCK (measured on 0.0.2732: 2 s into the next round the camera was still 67 m out on
            // PLAY's 4.2 s fly-in over the field): after a spectate, the next round's fly-in is cut to the view behind the
            // truck - the player has just watched the field. PLAY from the lobby keeps its fly-in.
            if (_leftAt >= 0f && chase != null && chase.Flying && Time.unscaledTime - _leftAt < 60f)
            {
                chase.EndFlyIn();
                _reported = false; _reportFrom = Time.unscaledTime;   // the report comes 2 s after this cut
                Debug.Log("[arena] spectate: the next round's fly-in is cut to the truck");
            }
            ReportChase();
            return;
        }
        if (cargoOpen || (Arena.ArenaCore.Available && Arena.ArenaCore.RunState == Arena.Layout.RUN_LIVE))
        {
            // THE NEXT TRUCK IS WHOLE: measured on 0.0.2731, the next round's bay opened on the last run's wreck,
            // still burning, for its whole countdown - only PLAY put it right. The bay opening under this camera does now.
            if (health != null && health.IsDestroyed) { health.Revive(); Debug.Log("[arena] spectate: the last run's wreck is put right for the next truck"); }
            Leave();
            return;
        }
        Steer(Time.unscaledDeltaTime);
    }

    /// <summary>One frame of the camera: the rise, then pan and zoom from the keys, pads, pointer, wheel and fingers.</summary>
    public void Steer(float dt)
    {
        _t += dt;
        if (Rise >= 1f) ReadControls(dt);
        var top = TopPose(_focus, _yaw, _height, topPitch);
        float e = Rise; e = e * e * (3f - 2f * e);
        transform.position = Vector3.Lerp(_fromPos, top.position, e);
        transform.rotation = Quaternion.Slerp(_fromRot, top.rotation, e);
        Report();
    }

    // THE READINGS (2026-10-03: "Pan ... Record the move. Zoom ... Record the change"): the page cannot see Unity's
    // camera, so the camera says where it is - once when the rise is done, then at most every 0.25 s while a pan or a zoom
    // moves it - with the truck beside it, which must not move.
    bool _toldTop;
    float _toldAt;
    Vector3 _toldFocus;
    float _toldHeight;

    void Report()
    {
        if (Rise < 1f) { _toldTop = false; return; }
        bool moved = (_focus - _toldFocus).sqrMagnitude > 0.01f || Mathf.Abs(_height - _toldHeight) > 0.05f;
        if (_toldTop && (!moved || Time.unscaledTime - _toldAt < 0.25f)) return;
        Debug.Log($"[arena] spectate {(_toldTop ? "moved" : "top-down")}: focus {_focus.x:0.0},{_focus.z:0.0} height {_height:0.0} m, "
                + $"camera {transform.position.x:0.0},{transform.position.y:0.0},{transform.position.z:0.0} pitch {transform.eulerAngles.x:0.0}, "
                + $"truck {(truck != null ? $"{truck.position.x:0.0},{truck.position.z:0.0}" : "-")}");
        _toldTop = true; _toldAt = Time.unscaledTime; _toldFocus = _focus; _toldHeight = _height;
    }

    /// <summary>Pan by a stick (x right, y up the screen) for <paramref name="dt"/> seconds - the keys' and pads' way in.</summary>
    public void Pan(Vector2 stick, float dt) => _focus = Panned(_focus, _yaw, Vector2.ClampMagnitude(stick, 1f), _height, panRate, dt);

    public void Zoom(float steps) => _height = Zoomed(_height, steps, minHeight, maxHeight);

    void ReadControls(float dt)
    {
        // ARROWS, WASD AND THE ON-SCREEN PADS: what drove the truck, read raw (the run is over, so they drive nothing)
        var stick = new Vector2(DriveInput.HeldSteer, DriveInput.HeldThrottle);
        if (stick.sqrMagnitude > 1e-4f) Pan(stick, dt);

        float metresPerPixel = 2f * _height / Mathf.Max(0.05f, Mathf.Sin(topPitch * Mathf.Deg2Rad))
                             * Mathf.Tan((_cam != null ? _cam.fieldOfView : 60f) * 0.5f * Mathf.Deg2Rad) / Mathf.Max(1, Screen.height);
#if ENABLE_INPUT_SYSTEM
        // PINCH: two fingers apart is closer
        var touch = Touchscreen.current;
        int down = 0; Vector2 a = default, b = default;
        if (touch != null)
            foreach (var t in touch.touches)
                if (t.press.isPressed) { if (down == 0) a = t.position.ReadValue(); else if (down == 1) b = t.position.ReadValue(); down++; }
        if (down >= 2)
        {
            float d = Vector2.Distance(a, b);
            if (_pinching && _lastPinch > 1f) _height = Mathf.Clamp(_height * _lastPinch / Mathf.Max(1f, d), minHeight, maxHeight);
            _lastPinch = d; _pinching = true; _dragging = false;
            return;
        }
        _pinching = false;

        // THE WHEEL
        var mouse = Mouse.current;
        if (mouse != null)
        {
            float wheel = mouse.scroll.ReadValue().y;
            if (Mathf.Abs(wheel) > 0.01f) Zoom(Mathf.Sign(wheel) * Mathf.Min(3f, Mathf.Max(1f, Mathf.Abs(wheel) / 120f)));
        }

        // SWIPE OR DRAG: the map follows the finger (or the mouse), not on a pad, and only past a few pixels so a tap on
        // the result card's controls does not nudge the view
        bool pressed = false; Vector2 p = default;
        if (down == 1) { pressed = true; p = a; }
        else if (mouse != null && mouse.leftButton.isPressed) { pressed = true; p = mouse.position.ReadValue(); }
        if (!pressed) { _dragging = false; _pressAt = Vector2.zero; return; }
        if (!_dragging)
        {
            if (_pressAt == Vector2.zero) { _pressAt = p; _lastPointer = p; return; }
            if (ChaseCamera.OverAPad(p) || Vector2.Distance(p, _pressAt) < 8f) return;
            _dragging = true;
        }
        var delta = p - _lastPointer;
        _lastPointer = p;
        var fwd = Quaternion.Euler(0f, _yaw, 0f) * Vector3.forward;
        var right = Quaternion.Euler(0f, _yaw, 0f) * Vector3.right;
        _focus -= (right * delta.x + fwd * delta.y) * metresPerPixel;
#endif
    }
}
