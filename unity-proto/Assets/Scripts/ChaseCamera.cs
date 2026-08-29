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
        transform.position = _pos;

        // look down the road ahead, not at the tailgate
        Vector3 look = target.position + target.forward * (lookAhead * (0.4f + speed01)) + Vector3.up * 1.2f;
        transform.rotation = Quaternion.LookRotation(look - _pos, Vector3.up);
    }
}
