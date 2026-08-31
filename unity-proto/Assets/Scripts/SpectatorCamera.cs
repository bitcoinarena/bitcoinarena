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
/// Drag to look, WASD to move, Q/E for height, shift to hurry. On a phone,
/// drag to look and the two pads to move.
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

    Camera _cam;
    float _yaw, _pitch;
    Vector2 _lastPointer;
    bool _dragging;

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
            case Spot.Miner:
                look = new Vector3(gate != null ? gate.gateX : 114f, 30f, 0f);
                at = look + new Vector3(-150f, 60f, 0f);
                break;
            case Spot.PostOffice:
                look = new Vector3(post != null ? post.postX : -114f, 25f, 0f);
                at = look + new Vector3(140f, 55f, 0f);
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
        Look();
        Move();
    }

    void Look()
    {
        Vector2 p = Vector2.zero;
        bool down = false;

        var mouse = UnityEngine.InputSystem.Mouse.current;
        if (mouse != null && mouse.leftButton.isPressed)
        {
            p = mouse.position.ReadValue();
            down = true;
        }
        var touch = UnityEngine.InputSystem.Touchscreen.current;
        if (!down && touch != null && touch.primaryTouch.press.isPressed)
        {
            p = touch.primaryTouch.position.ReadValue();
            down = true;
        }

        if (down && _dragging)
        {
            var d = p - _lastPointer;
            _yaw += d.x * lookSpeed;
            _pitch = Mathf.Clamp(_pitch - d.y * lookSpeed, -85f, 85f);
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
        // usable on a phone. TouchPad has no held-state of its own - it
        // resolves a list of live points - so the touches are collected here
        // and handed to the same hit test the driving controls use.
        var touch = UnityEngine.InputSystem.Touchscreen.current;
        if (touch != null)
        {
            var points = new System.Collections.Generic.List<Vector2>();
            foreach (var t in touch.touches)
                if (t.press.isPressed) points.Add(t.position.ReadValue());

            if (points.Count > 0)
            {
                int w = Screen.width, h = Screen.height;
                if (TouchPad.Hit(TouchPad.Pad.Up, w, h, points)) move += transform.forward;
                if (TouchPad.Hit(TouchPad.Pad.Down, w, h, points)) move -= transform.forward;
                if (TouchPad.Hit(TouchPad.Pad.Left, w, h, points)) move -= transform.right;
                if (TouchPad.Hit(TouchPad.Pad.Right, w, h, points)) move += transform.right;
            }
        }

        if (move.sqrMagnitude > 0.0001f)
            transform.position += move.normalized *
                                  (fast ? fastSpeed : speed) * Time.unscaledDeltaTime;
    }
}
