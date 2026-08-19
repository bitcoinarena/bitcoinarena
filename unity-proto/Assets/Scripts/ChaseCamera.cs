using UnityEngine;

/// <summary>
/// Chase cam. Follows the direction of TRAVEL rather than the nose, so when the
/// truck slides the camera stays square to the road and you watch your own
/// flank come round - which is how a drift reads as a drift.
/// </summary>
public class ChaseCamera : MonoBehaviour
{
    public Transform target;
    public Rigidbody targetBody;

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

    void Start()
    {
        if (target == null) return;
        _yaw = target.eulerAngles.y * Mathf.Deg2Rad;
        _pos = target.position;
    }

    void LateUpdate()
    {
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
