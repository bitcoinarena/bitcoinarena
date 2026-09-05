using UnityEngine;

/// <summary>
/// Chase cam. Follows the direction of TRAVEL rather than the nose, so when the
/// truck slides the camera stays square to the road and you watch your own
/// flank come round - which is how a drift reads as a drift.
/// </summary>
public class ChaseCamera : MonoBehaviour
{
    public enum Mode { Follow, God }

    public Transform target;
    public Rigidbody targetBody;

    [Header("God view")]
    public MempoolTerrain terrain;
    /// <summary>Tilt of the overview. Straight down reads as a map; this reads as a battlefield.</summary>
    public float godPitch = 62f;

    [Header("Look around")]
    [Tooltip("Degrees of camera yaw per screen width dragged.")]
    public float dragYaw = 220f;
    [Tooltip("Degrees of camera pitch per screen height dragged.")]
    public float dragPitch = 120f;
    [Tooltip("How far the view may be tilted up and down, in degrees.")]
    public float pitchLimit = 55f;
    [Tooltip("Seconds the view is held after a drag before it eases back " +
             "behind the truck. Zero keeps it until the next drag.")]
    public float recentreAfter = 2.5f;

    [Tooltip("How fast the view eases back once it starts, per second. The " +
             "view keeps a fraction exp(-rate * t) of where it was, so 2 " +
             "leaves a thirtieth after 1.7 s.")]
    public float recentreRate = 2f;

    public Mode View { get; private set; } = Mode.Follow;
    public void Toggle() => View = View == Mode.Follow ? Mode.God : Mode.Follow;

    [Header("Framing")]
    public float distance = 9f;
    public float distanceAtSpeed = 4.5f;
    public float height = 4.2f;
    public float heightAtSpeed = 1.8f;
    public float lookAhead = 6f;

    [Header("Damping")]
    public float positionDamp = 6.5f;

    [Header("Feel")]
    [Tooltip("Field of view standing still.")]
    public float fovIdle = 58f;

    [Tooltip("Field of view flat out. The widening IS the sense of speed - " +
             "a fixed lens makes 30 m/s look like 8.")]
    public float fovFlatOut = 78f;

    [Tooltip("Speed at which the lens is fully open. Set to what the truck " +
             "actually reaches on this map - about 20 m/s - not to its " +
             "theoretical top speed: measured against topSpeed and squared, " +
             "a hard-driven run moved the lens by two degrees and felt the " +
             "same as standing still.")]
    public float fovAtSpeed = 20f;

    [Tooltip("How hard the camera is thrown by an impact.")]
    public float shakeScale = 1f;
    public float yawDamp = 2.8f;
    public float topSpeed = 34f;

    float _yaw;
    Vector3 _pos;

    /// <summary>
    /// High enough that the whole battlefield fits, worked out from the field
    /// size and the lens rather than a hand-tuned height - the terrain is
    /// 260 by 170, and a number that happens to fit today stops fitting the
    /// moment either changes.
    /// </summary>
    void GodView()
    {
        var cam = GetComponent<Camera>();
        float w = terrain != null ? terrain.width : 260f;
        float d = terrain != null ? terrain.depth : 170f;

        float vFov = cam.fieldOfView * Mathf.Deg2Rad;
        float hFov = 2f * Mathf.Atan(Mathf.Tan(vFov * 0.5f) * cam.aspect);
        // distance needed for each axis, with a margin so nothing touches the edge
        float need = Mathf.Max(d * 0.5f / Mathf.Tan(vFov * 0.5f), w * 0.5f / Mathf.Tan(hFov * 0.5f)) * 1.25f;

        float pitch = godPitch * Mathf.Deg2Rad;
        var centre = new Vector3(0f, 0f, 0f);
        var pos = centre + new Vector3(0f, Mathf.Sin(pitch), -Mathf.Cos(pitch)) * need;

        _pos = Vector3.Lerp(_pos, pos, 1f - Mathf.Exp(-4f * Time.deltaTime));
        transform.position = _pos;
        transform.rotation = Quaternion.LookRotation(centre - _pos, Vector3.up);
    }

    void Start()
    {
        if (target == null) return;
        _yaw = target.eulerAngles.y * Mathf.Deg2Rad;
        _pos = target.position;
    }

    /// <summary>
    /// Where the wreck is while the death sequence runs, or null.
    /// The camera pulls back off the burning truck and circles it, which is the
    /// half of a GTA death that is doing the work - the text on its own over a
    /// frozen chase cam just reads as a paused game.
    /// </summary>
    public Vector3? deathOrbit;

    public float deathDistance = 15f;
    public float deathHeight = 7.5f;
    public float deathSpin = 22f;          // degrees a second

    float _deathYaw;

    // Where the player has dragged the view to, relative to the automatic one.
    float _orbitYaw, _orbitPitch;
    float _worstOffNose, _worstRoll;
    Vector3 _downAt;
    bool _pointerDown, _onPad;
    float _dragIdle;
    bool _dragging;
    Vector3 _lastPointer;

    Vector3 _flyFrom, _flyLook;
    float _flySeconds, _flyLeft;

    /// <summary>
    /// Fly the camera in to the truck.
    ///
    /// Used twice: entering a round, and coming back from the miner after a
    /// delivery. Both run the length of the map over the fighting, because the
    /// fighting and the mempool building are the two things worth showing and
    /// a cut straight to the tailgate shows neither.
    ///
    /// It looks at `lookAt` to begin with and swings onto the truck as it
    /// arrives, so the building is held in frame while the camera is still far
    /// enough away for it to read.
    /// </summary>
    public void FlyIn(Vector3 from, Vector3 lookAt, float seconds)
    {
        _flyFrom = from;
        _flyLook = lookAt;
        _flySeconds = Mathf.Max(0.2f, seconds);
        _flyLeft = _flySeconds;
        _pos = from;
    }

    /// <summary>True while a scripted approach is running.</summary>
    public bool Flying => _flyLeft > 0f;

    float _shake;
    float _lastHeading;
    Camera _cam;

    /// <summary>
    /// Throw the camera about. Called on an impact, on a kill under the
    /// wheels, and when the truck is written off.
    ///
    /// A collision that the camera does not react to reads as the game not
    /// having noticed it.
    /// </summary>
    public void Shake(float amount) => _shake = Mathf.Min(2.5f, _shake + amount * shakeScale);

    /// <summary>Current shake, for a test to watch it decay.</summary>
    public float ShakeAmount => _shake;

    /// <summary>
    /// Drag to look around.
    ///
    /// A chase camera locked behind the truck gives the player no way to read
    /// how the truck is SITTING - whether it is nose-down on a descent, or
    /// leaning across a slope - because the one view that shows it is the one
    /// view they cannot get to. Dragging swings the camera round the truck and
    /// it eases back on its own afterwards, so looking does not cost the run.
    ///
    /// Drags that begin on a driving pad are ignored: on a phone the pads are
    /// the controls, and a thumb sliding on one must steer, not pan.
    ///
    /// AND A TAP IS NOT A DRAG. Every touch outside a pad used to become a
    /// look the instant it landed, so the view swung on the way to pressing
    /// anything and the player lost the road for the seconds it took to come
    /// back. A pointer has to travel first, and the distance is derived rather
    /// than chosen: `dragYaw` degrees per screen width means one degree costs
    /// `Screen.width / dragYaw` pixels, so the threshold IS one degree of aim.
    /// A finger may wander that far on the way to a tap; further than that it
    /// meant to look.
    /// </summary>
    void ReadDrag()
    {
        bool held = Held;
        Vector3 at = Pointer;

        if (held && !_pointerDown)
        {
            _pointerDown = true;
            _downAt = at;
            _lastPointer = at;
            _onPad = OverAPad(at);
        }
        else if (!held)
        {
            _pointerDown = false;
            _dragging = false;
        }

        // Past the dead zone, and not on a pad: this is a look.
        if (held && !_dragging && !_onPad
            && (at - _downAt).magnitude > DeadZonePixels)
        {
            _dragging = true;
            // From exactly one dead zone along the way, not from wherever the
            // pointer happens to be on the frame it crossed. Measured: with
            // `_lastPointer = at` a drag that covered a quarter of the screen
            // in one frame moved the aim by nothing at all, because the whole
            // travel was swallowed. A finger moving a few pixels a frame would
            // never have shown it, and a slow phone would.
            _lastPointer = _downAt + (at - _downAt).normalized * DeadZonePixels;
        }

        if (held && _dragging)
        {
            Vector3 d = at - _lastPointer;
            _lastPointer = at;
            _orbitYaw += d.x / Mathf.Max(1, Screen.width) * dragYaw;
            _orbitPitch = Mathf.Clamp(_orbitPitch - d.y / Mathf.Max(1, Screen.height) * dragPitch,
                                      -pitchLimit, pitchLimit);
            _dragIdle = 0f;
            return;                       // no easing back while still looking
        }

        // Everything else eases back - including a finger resting inside the
        // dead zone, which is a tap in progress and not a held view.
        _dragIdle += Time.unscaledDeltaTime;
        if (recentreAfter > 0f && _dragIdle > recentreAfter)
        {
            float k = 1f - Mathf.Exp(-recentreRate * Time.unscaledDeltaTime);
            _orbitYaw = Mathf.Lerp(_orbitYaw, 0f, k);
            _orbitPitch = Mathf.Lerp(_orbitPitch, 0f, k);
        }
    }

    /// <summary>One degree of aim, in pixels of this screen.</summary>
    public float DeadZonePixels => Mathf.Max(1f, Screen.width / Mathf.Max(1f, dragYaw));

    /// <summary>Where the view has been dragged to, for a test to read it.</summary>
    public float OrbitYaw => _orbitYaw;
    public float OrbitPitch => _orbitPitch;

    /// <summary>
    /// The pointer, or a test's idea of one.
    ///
    /// Same shape as `TruckController.useExternalInput`: the camera cannot be
    /// driven by `Input` in a test, and a look that is only ever measured
    /// through a browser is measured once and never again.
    /// </summary>
    public bool useExternalPointer;
    public bool externalPointerHeld;
    public Vector3 externalPointerAt;

    bool Held => useExternalPointer ? externalPointerHeld : Input.GetMouseButton(0);
    Vector3 Pointer => useExternalPointer ? externalPointerAt : Input.mousePosition;

    /// <summary>True if a screen point is on one of the touch controls.</summary>
    public static bool OverAPad(Vector3 screenPoint)
    {
        // GUI space: y runs down from the top, Input.mousePosition runs up.
        var p = new Vector2(screenPoint.x, Screen.height - screenPoint.y);
        foreach (TouchPad.Pad pad in System.Enum.GetValues(typeof(TouchPad.Pad)))
            if (TouchPad.RectFor(pad, Screen.width, Screen.height).Contains(p)) return true;
        return false;
    }

    void LateUpdate()
    {
        if (DriveInput.CameraToggle) Toggle();
        ReadDrag();

        if (deathOrbit.HasValue)
        {
            var at = deathOrbit.Value;
            // unscaled: the world is in slow motion, the camera move is not
            _deathYaw += deathSpin * Time.unscaledDeltaTime;
            float y = _deathYaw * Mathf.Deg2Rad;
            var orbit = at + new Vector3(-Mathf.Sin(y), 0f, -Mathf.Cos(y)) * deathDistance
                           + Vector3.up * deathHeight;
            _pos = Vector3.Lerp(_pos, orbit, 1f - Mathf.Exp(-2.2f * Time.unscaledDeltaTime));
            transform.position = _pos;
            transform.rotation = Quaternion.LookRotation(at + Vector3.up * 1.2f - _pos, Vector3.up);
            return;
        }

        if (View == Mode.God) { GodView(); return; }
        if (target == null) return;

        if (_flyLeft > 0f)
        {
            _flyLeft -= Time.unscaledDeltaTime;
            float t = Mathf.Clamp01(1f - _flyLeft / _flySeconds);
            float e = t * t * (3f - 2f * t);     // eased at both ends

            float head = target.eulerAngles.y * Mathf.Deg2Rad;
            var settled = target.position
                        + new Vector3(-Mathf.Sin(head), 0f, -Mathf.Cos(head)) * distance
                        + Vector3.up * height;

            _pos = Vector3.Lerp(_flyFrom, settled, e);

            // An impact is still felt during a scripted move. Swallowing it
            // reads as the game not having noticed the hit, which is exactly
            // what the shake exists to prevent - and the flight home from a
            // delivery is 4.6 seconds long.
            _shake = Mathf.Max(0f, _shake - Time.unscaledDeltaTime * 3.2f);
            if (_shake > 0.001f)
            {
                float ts = Time.time * 47f;
                _pos += new Vector3(Mathf.PerlinNoise(ts, 0f) - 0.5f,
                                    Mathf.PerlinNoise(0f, ts) - 0.5f,
                                    Mathf.PerlinNoise(ts, ts) - 0.5f) * (_shake * 1.6f);
            }

            transform.position = _pos;
            transform.rotation = Quaternion.LookRotation(
                Vector3.Lerp(_flyLook, target.position + Vector3.up * 1.2f, e) - _pos,
                Vector3.up);

            _yaw = head;
            _lastHeading = target.eulerAngles.y;
            return;
        }

        // The truck's velocity, from the core.
        //
        // `targetBody.linearVelocity` is 0 for good - the body went kinematic
        // when the core took the driving - and EVERY consumer below reads this
        // one vector: the reach and the rise (speed01), the direction the
        // camera settles behind (Atan2), the cornering load that drives the
        // lean, and the lens. All five were reading a truck standing still
        // while it was doing 19 m/s in the browser.
        //
        // Not `TruckSpeed`. That reads `T_WHEEL`, which despite the name
        // holds `total` from `rules/vehicle.js:222` - the resultant BEFORE
        // the 34 m/s cap is spent on it, while `T_VX`/`T_VZ` are written
        // after. The two part company exactly where the cap bites: 12 ticks
        // in 2400 on a hard drive, by up to 5.101 m/s. And a scalar carries
        // no direction at all, so it could not feed the Atan2 below.
        // `linearVelocity` was the planar body velocity; that is
        // `T_VX`/`T_VZ`.
        Vector3 v = Blwp.BlwpCore.Available
                  ? Blwp.BlwpCore.Velocity
                  : (targetBody != null ? targetBody.linearVelocity : Vector3.zero);
        v.y = 0f;
        float speed01 = Mathf.Clamp01(v.magnitude / topSpeed);

        // THE NOSE, not the velocity vector.
        //
        // `c09f39b` put the camera behind `Atan2(v.x, v.z)` because the body
        // velocity had been dead and five other things needed it. Reach, rise
        // and the lens still read it below - they want a SPEED. The direction
        // the camera settles behind is a different question, and the velocity
        // answers it wrongly: in a corner that vector points where the truck is
        // SLIDING. Measured on a slalom at 15.4 m/s, the camera ended up 8.7
        // degrees off the nose with 5.8 degrees of slip under it, which is the
        // driver looking at his own flank instead of the road.
        //
        // The nose is what the player steers, so the nose is what the camera
        // sits behind. It also puts the look-at target and the position on the
        // same basis: the goal below is built from this yaw and the aim point
        // from `target.forward`, and those two only agreed when the truck was
        // going exactly where it pointed.
        float wanted = target.eulerAngles.y * Mathf.Deg2Rad;
        _yaw = Mathf.LerpAngle(_yaw * Mathf.Rad2Deg, wanted * Mathf.Rad2Deg,
                   1f - Mathf.Exp(-yawDamp * Time.deltaTime)) * Mathf.Deg2Rad;

        float yaw = _yaw + _orbitYaw * Mathf.Deg2Rad;
        Vector3 back = new Vector3(-Mathf.Sin(yaw), 0f, -Mathf.Cos(yaw));
        float reach = distance + distanceAtSpeed * speed01;
        float rise = height + heightAtSpeed * speed01;

        // Dragged pitch swings the camera up and over, or down towards the
        // ground, keeping its distance from the truck.
        float p = _orbitPitch * Mathf.Deg2Rad;
        Vector3 goal = target.position
                     + back * (reach * Mathf.Cos(p))
                     + Vector3.up * (rise + reach * Mathf.Sin(p));

        _pos = Vector3.Lerp(_pos, goal, 1f - Mathf.Exp(-positionDamp * Time.deltaTime));

        // Shake decays fast. Held longer it stops reading as an impact and
        // starts reading as a fault in the camera.
        _shake = Mathf.Max(0f, _shake - Time.deltaTime * 3.2f);
        if (_shake > 0.001f)
        {
            float t = Time.time * 47f;
            _pos += new Vector3(Mathf.PerlinNoise(t, 0f) - 0.5f,
                                Mathf.PerlinNoise(0f, t) - 0.5f,
                                Mathf.PerlinNoise(t, t) - 0.5f) * (_shake * 1.6f);
        }
        transform.position = _pos;

        // NO LEAN. The horizon does not roll while steering.
        //
        // It used to: the cornering load - yaw rate times forward speed - was
        // clamped and multiplied by `leanDegrees` and fed straight into the
        // camera's Z rotation, and it reached 5.4 degrees in a measured
        // slalom. Nothing was wrong with the arithmetic and nothing came from
        // PhysX: the yaw rate is read off the target's own heading and the
        // speed off the core's velocity. It was simply the wrong thing to draw
        // - a driver turning the wheel wants the road to stay level and to see
        // where he is going, and a tilted horizon takes both away on a small
        // screen. So the number is no longer computed and no longer applied.
        //
        // `_lastHeading` is still kept: the fly-in path sets it, and a future
        // reading of the yaw rate should not start from a stale one.
        _lastHeading = target.eulerAngles.y;

        // look down the road ahead, not at the tailgate
        Vector3 look = target.position + target.forward * (lookAhead * (0.4f + speed01)) + Vector3.up * 1.2f;
        // The only thing left that can tilt the frame is an IMPACT, and that
        // is meant to be felt: it decays in a third of a second and it is not
        // steering.
        transform.rotation = Quaternion.LookRotation(look - _pos, Vector3.up)
                           * Quaternion.Euler(0f, 0f, _shake > 0.001f ? _shake * 2f : 0f);

        // THE MEASUREMENT for the driving view, and it only ever prints a new
        // worst case. A per-frame line would drown the console; what this
        // letter needs is the extremes: how far the camera is looking away
        // from the truck's nose, and how far the horizon has rolled. The slip
        // angle is printed beside them because it is the suspected cause -
        // the camera settles behind the velocity vector, and in a corner that
        // is where the truck is sliding, not where it points.
        float offNose = Vector3.Angle(Vector3.ProjectOnPlane(transform.forward, Vector3.up),
                                      Vector3.ProjectOnPlane(target.forward, Vector3.up));
        float roll = Mathf.DeltaAngle(0f, transform.eulerAngles.z);
        float slip = v.magnitude > 1f
            ? Mathf.Abs(Mathf.DeltaAngle(Mathf.Atan2(v.x, v.z) * Mathf.Rad2Deg,
                                         target.eulerAngles.y)) : 0f;
        if (offNose > _worstOffNose + 1f || Mathf.Abs(roll) > _worstRoll + 1f)
        {
            _worstOffNose = Mathf.Max(_worstOffNose, offNose);
            _worstRoll = Mathf.Max(_worstRoll, Mathf.Abs(roll));
            Debug.Log($"[cam] off-nose {offNose:F1} deg (worst {_worstOffNose:F1}), " +
                      $"roll {roll:F1} (worst {_worstRoll:F1}), slip {slip:F1}, " +
                      $"speed {v.magnitude:F1}");
        }

        // The lens opens up as it goes. This is most of the difference between
        // a truck that is moving and a truck that feels fast.
        if (_cam == null) _cam = GetComponent<Camera>();
        if (_cam != null)
        {
            float lens = Mathf.Pow(Mathf.Clamp01(v.magnitude / Mathf.Max(1f, fovAtSpeed)), 1.3f);
            _cam.fieldOfView = Mathf.Lerp(_cam.fieldOfView,
                                          Mathf.Lerp(fovIdle, fovFlatOut, lens),
                                          1f - Mathf.Exp(-2.4f * Time.deltaTime));
        }
    }
}
