// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// A free camera for looking at the map from any angle.
///
/// The buildings at either end are the most expensive things in the project
/// and the hardest to judge: they are 170 m wide, streamed in, and normally
/// only ever seen from behind a truck at windscreen height. Being able to fly
/// round them is the difference between "it looks about right" and knowing
/// whether the fans turn true, whether the lettering fits, and whether the
/// bay a player spawns in lines up with the doors.
///
/// Drag to look, WASD to move, Q/E for height, shift to hurry. On a phone:
/// one finger to look, the pads to move, two fingers dragged up or down for
/// height, and the EXIT button to go back to the truck.
/// </summary>
public class SpectatorCamera : MonoBehaviour
{
    public ChaseCamera chase;
    public Transform truck;
    public DeliveryGate gate;
    public PostOffice post;

    public float speed = 40f;
    public float fastSpeed = 140f;
    public float lookSpeed = 0.16f;

    public bool Active { get; private set; }

    [Tooltip("Metres of altitude per screen height of two-finger drag.")]
    public float liftSpeed = 90f;

    Camera _cam;
    float _yaw, _pitch;
    Vector2 _lastPointer;
    bool _dragging;
    float _lastPinch;
    bool _lifting;
    Texture2D _flat;

    /// <summary>Where the EXIT button sits, in GUI space.</summary>
    public static Rect ExitRect(int w, int h)
    {
        float s = TouchPad.ButtonSize(w, h) * 0.62f;
        float m = TouchPad.Margin(w, h);
        return new Rect(m, m, s * 1.7f, s * 0.62f);
    }

    /// <summary>Places to jump to, so the two big models are one tap away.</summary>
    public enum Spot { Truck, PostOffice, Miner, Overview }

    void Awake() => _cam = GetComponent<Camera>();

    public void Enter()
    {
        if (Active) return;
        Active = true;
        if (chase != null) chase.enabled = false;
        Go(Spot.PostOffice);
    }

    public void Leave()
    {
        if (!Active) return;
        Active = false;
        if (chase != null) chase.enabled = true;
    }

    public void Go(Spot spot)
    {
        Vector3 at, look;
        switch (spot)
        {
            // 95 m OFF EACH BUILDING, NOT 140 AND 150 (2026-09-19, after the world grew east). Those stand-offs were
            // chosen when the two buildings were 228.8 m apart, and they put both viewpoints in the middle of the
            // map; at 283.4 m apart they landed 12 m from each other - PlayMode measured the jump to the miner
            // moving the camera 12 m and called it, rightly, no jump at all. 95 m keeps each spot in front of its
            // own building and 103 m from the other.
            case Spot.Miner:
                look = new Vector3(gate != null ? gate.gateX : Arena.Layout.MINER_X / 65536f, 30f, 0f);
                at = look + new Vector3(-95f, 60f, 0f);
                break;
            case Spot.PostOffice:
                look = new Vector3(post != null ? post.postX : Arena.Layout.POST_X / 65536f, 25f, 0f);
                at = look + new Vector3(95f, 55f, 0f);
                break;
            case Spot.Overview:
                look = Vector3.zero;
                at = new Vector3(0f, 220f, -150f);
                break;
            default:
                look = truck != null ? truck.position : Vector3.zero;
                at = look + new Vector3(-14f, 7f, -10f);
                break;
        }
        transform.position = at;
        transform.rotation = Quaternion.LookRotation((look - at).normalized, Vector3.up);
        var e = transform.rotation.eulerAngles;
        _yaw = e.y;
        _pitch = e.x > 180f ? e.x - 360f : e.x;
    }

    void Update()
    {
        if (!Active) return;
        Fingers();
        Look();
        Move();
    }

    /// <summary>
    /// Every finger on the glass, in GUI space - origin top left, y down.
    ///
    /// GUI space, not input space, because that is what TouchPad hit-tests in.
    /// Reading the raw touch position and passing it straight to TouchPad.Hit
    /// is what made the pads dead in this mode: the y axis was upside down, so
    /// pressing the forward pad at the bottom of the screen tested a rectangle
    /// at the top and nothing ever moved.
    /// </summary>
    readonly System.Collections.Generic.List<Vector2> _fingers = new();

    /// <summary>
    /// The fingers AND the mouse: everything pressing the glass right now, which is what the flying pads are hit-tested
    /// against.
    ///
    /// THE PADS DID NOTHING ON A DESKTOP (2026-09-18 21:52, photographed in spectate: "I can press it with the
    /// mouse but it won't do anything ... and only on spectate"). The pad LIT UP under the pointer, because the pads
    /// themselves read the mouse - but this mode collected touches only, so on a screen with no glass the list was
    /// always empty and `Move` never saw the press. `Look` then read the same press as "on a control" and rightly
    /// refused to turn the camera, which is why nothing at all happened.
    ///
    /// The two-finger height pinch stays with real fingers: one mouse is not two fingers.
    /// </summary>
    readonly System.Collections.Generic.List<Vector2> _pressed = new();

    void Fingers()
    {
        _fingers.Clear();
        var touch = UnityEngine.InputSystem.Touchscreen.current;
        if (touch != null)
            foreach (var t in touch.touches)
                if (t.press.isPressed)
                {
                    var p = t.position.ReadValue();
                    _fingers.Add(new Vector2(p.x, Screen.height - p.y));
                }

        _pressed.Clear();
        _pressed.AddRange(_fingers);
        var mouse = UnityEngine.InputSystem.Mouse.current;
        if (mouse != null && mouse.leftButton.isPressed)
        {
            var m = mouse.position.ReadValue();
            _pressed.Add(new Vector2(m.x, Screen.height - m.y));
        }
    }

    /// <summary>Is this finger on one of the on-screen controls?</summary>
    static bool OnAControl(Vector2 gui, int w, int h)
    {
        var one = new System.Collections.Generic.List<Vector2> { gui };
        return ExitRect(w, h).Contains(gui)
            || TouchPad.Hit(TouchPad.Pad.Up, w, h, one)
            || TouchPad.Hit(TouchPad.Pad.Down, w, h, one)
            || TouchPad.Hit(TouchPad.Pad.Left, w, h, one)
            || TouchPad.Hit(TouchPad.Pad.Right, w, h, one);
    }

    void Look()
    {
        int w = Screen.width, h = Screen.height;

        // Two fingers: height. A phone has no Q and E, and a free camera that
        // can only be flown at one altitude is no use for looking at a
        // building 52 m tall.
        if (_fingers.Count >= 2)
        {
            float mid = (_fingers[0].y + _fingers[1].y) * 0.5f;
            if (_lifting)
                transform.position += Vector3.up * ((_lastPinch - mid) / h * liftSpeed);
            _lastPinch = mid;
            _lifting = true;
            _dragging = false;
            return;
        }
        _lifting = false;

        Vector2 p = Vector2.zero;
        bool down = false;

        var mouse = UnityEngine.InputSystem.Mouse.current;
        if (mouse != null && mouse.leftButton.isPressed)
        {
            var m = mouse.position.ReadValue();
            p = new Vector2(m.x, Screen.height - m.y);
            down = !OnAControl(p, w, h);
        }
        if (!down && _fingers.Count == 1 && !OnAControl(_fingers[0], w, h))
        {
            p = _fingers[0];
            down = true;
        }

        if (down && _dragging)
        {
            var d = p - _lastPointer;
            _yaw += d.x * lookSpeed;
            // GUI space has y running down, so a drag DOWN raises the pitch
            _pitch = Mathf.Clamp(_pitch + d.y * lookSpeed, -85f, 85f);
            transform.rotation = Quaternion.Euler(_pitch, _yaw, 0f);
        }
        _dragging = down;
        _lastPointer = p;
    }

    void Move()
    {
        var kb = UnityEngine.InputSystem.Keyboard.current;
        var move = Vector3.zero;
        bool fast = false;
        if (kb != null)
        {
            if (kb.wKey.isPressed) move += transform.forward;
            if (kb.sKey.isPressed) move -= transform.forward;
            if (kb.aKey.isPressed) move -= transform.right;
            if (kb.dKey.isPressed) move += transform.right;
            if (kb.eKey.isPressed) move += Vector3.up;
            if (kb.qKey.isPressed) move -= Vector3.up;
            fast = kb.leftShiftKey.isPressed;
        }

        // The driving pads double as movement while spectating, so the mode is
        // usable on a phone AND on a desktop with a mouse. TouchPad has no
        // held-state of its own - it resolves a list of live points - so
        // everything pressing the glass is handed to the same hit test the
        // driving controls use.
        if (_pressed.Count > 0)
        {
            int w = Screen.width, h = Screen.height;
            if (TouchPad.Hit(TouchPad.Pad.Up, w, h, _pressed)) move += transform.forward;
            if (TouchPad.Hit(TouchPad.Pad.Down, w, h, _pressed)) move -= transform.forward;
            if (TouchPad.Hit(TouchPad.Pad.Left, w, h, _pressed)) move -= transform.right;
            if (TouchPad.Hit(TouchPad.Pad.Right, w, h, _pressed)) move += transform.right;
        }

        if (move.sqrMagnitude > 0.0001f)
            transform.position += move.normalized *
                                  (fast ? fastSpeed : speed) * Time.unscaledDeltaTime;
    }

    /// <summary>
    /// The way back, and how to fly.
    ///
    /// Spectating was reachable from the title screen and had no exit at all
    /// on a phone: no key to press, and the pads that move the camera look
    /// exactly like the pads that drive the truck. A labelled button and one
    /// line of instructions cost nothing and are the difference between a mode
    /// and a trap.
    /// </summary>
    void OnGUI()
    {
        if (!Active || CleanHud.On) return;
        if (_flat == null)
        {
            _flat = new Texture2D(1, 1);
            _flat.SetPixel(0, 0, Color.white);
            _flat.Apply();
        }

        int w = Screen.width, h = Screen.height;
        var exit = ExitRect(w, h);

        GUI.color = new Color(0f, 0f, 0f, 0.55f);
        GUI.DrawTexture(exit, _flat);
        GUI.color = new Color(1f, 1f, 1f, 0.85f);
        GUI.DrawTexture(new Rect(exit.x, exit.y, exit.width, 2f), _flat);
        GUI.DrawTexture(new Rect(exit.x, exit.yMax - 2f, exit.width, 2f), _flat);
        GUI.DrawTexture(new Rect(exit.x, exit.y, 2f, exit.height), _flat);
        GUI.DrawTexture(new Rect(exit.xMax - 2f, exit.y, 2f, exit.height), _flat);
        GUI.color = Color.white;

        var label = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.MiddleCenter,
            fontStyle = FontStyle.Bold,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(exit.height * 0.42f, 11f, 22f)),
        };
        label.normal.textColor = Color.white;
        if (GUI.Button(exit, "EXIT", label)) Leave();

        var hint = new GUIStyle(GUI.skin.label)
        {
            alignment = TextAnchor.UpperLeft,
            fontSize = Mathf.RoundToInt(Mathf.Clamp(Mathf.Min(w, h) * 0.021f, 10f, 17f)),
        };
        hint.normal.textColor = new Color(1f, 1f, 1f, 0.65f);
        GUI.Label(new Rect(exit.x, exit.yMax + 6f, w * 0.6f, hint.fontSize * 3f),
                  "drag to look  ·  pads to fly  ·  two fingers up/down for height", hint);
    }
}
