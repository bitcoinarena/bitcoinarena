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

    [Tooltip("How far the camera leans into a corner, in degrees.")]
    public float leanDegrees = 6f;

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

    float _shake;
    float _lean;
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

    void LateUpdate()
    {
        if (DriveInput.CameraToggle) Toggle();

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

        Vector3 v = targetBody != null ? targetBody.linearVelocity : Vector3.zero;
        v.y = 0f;
        float speed01 = Mathf.Clamp01(v.magnitude / topSpeed);

        // below a walking pace the velocity vector is noise, so fall back to the nose
        float wanted = v.magnitude > 6f
            ? Mathf.Atan2(v.x, v.z)
            : target.eulerAngles.y * Mathf.Deg2Rad;
        _yaw = Mathf.LerpAngle(_yaw * Mathf.Rad2Deg, wanted * Mathf.Rad2Deg,
                   1f - Mathf.Exp(-yawDamp * Time.deltaTime)) * Mathf.Deg2Rad;

        Vector3 back = new Vector3(-Mathf.Sin(_yaw), 0f, -Mathf.Cos(_yaw));
        Vector3 goal = target.position
                     + back * (distance + distanceAtSpeed * speed01)
                     + Vector3.up * (height + heightAtSpeed * speed01);

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

        // Lean into the corner, off the CORNERING LOAD - yaw rate times speed,
        // which is the sideways acceleration the driver is actually feeling.
        //
        // Taking the sideways velocity instead, as this first did, measures
        // how much the truck is sliding: a vehicle with grip barely slides at
        // all, so a hard corner produced 0.7 degrees of lean and the camera sat
        // there flat while the truck heeled over on its springs.
        float yawRate = targetBody != null ? targetBody.angularVelocity.y : 0f;
        float forwardSpeed = Vector3.Dot(v, target.forward);
        float corneringG = yawRate * forwardSpeed;              // m/s^2, signed
        float wantedLean = Mathf.Clamp(corneringG / 7f, -1f, 1f) * leanDegrees;
        _lean = Mathf.Lerp(_lean, wantedLean, 1f - Mathf.Exp(-3.5f * Time.deltaTime));

        // look down the road ahead, not at the tailgate
        Vector3 look = target.position + target.forward * (lookAhead * (0.4f + speed01)) + Vector3.up * 1.2f;
        transform.rotation = Quaternion.LookRotation(look - _pos, Vector3.up)
                           * Quaternion.Euler(0f, 0f, _lean + (_shake > 0.001f ? _shake * 2f : 0f));

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
