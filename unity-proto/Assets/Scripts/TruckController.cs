using UnityEngine;

/// <summary>
/// Armoured mail truck. Built on WheelCollider, so suspension, load transfer
/// and tyre slip are solved by the physics engine rather than approximated -
/// which is the main reason this port is worth doing at all.
///
/// Controls follow the three.js build, which follows GTA: W/S throttle and
/// brake, A/D steer, space handbrake.
/// </summary>
[RequireComponent(typeof(Rigidbody))]
public class TruckController : MonoBehaviour
{
    [System.Serializable]
    public class Axle
    {
        public WheelCollider left;
        public WheelCollider right;
        public Transform leftMesh;
        public Transform rightMesh;
        public bool steering;
        public bool driven;
        public bool handbraked;
    }

    [Header("Axles (front first)")]
    public Axle[] axles = new Axle[2];

    [Header("Drivetrain")]
    public float motorTorque = 2600f;
    public float brakeTorque = 6000f;
    public float handbrakeTorque = 9000f;
    public float topSpeed = 34f;              // m/s, matches the three.js sprint

    [Header("Steering")]
    [Tooltip("Lock at a standstill, in degrees.")]
    public float steerLock = 34f;
    [Tooltip("Lock at top speed. A van that darts at 34 m/s is undriveable.")]
    public float steerLockFast = 9f;
    public float steerRate = 5.5f;

    [Header("Stability")]
    [Tooltip("A high centre of mass makes a tall van roll over on the first corner.")]
    public Vector3 centreOfMass = new Vector3(0f, -0.6f, 0f);
    public float downforce = 60f;

    [Header("Handbrake grip")]
    [Tooltip("Rear sideways stiffness is cut to this fraction while the handbrake is in.")]
    public float handbrakeGrip = 0.35f;

    Rigidbody _rb;
    float _steer;
    float[] _rearStiffness;

    public float SpeedKmh => _rb.linearVelocity.magnitude * 3.6f;
    /// <summary>How far the truck is travelling sideways, in m/s. This is the drift readout.</summary>
    public float Slip => Mathf.Abs(transform.InverseTransformDirection(_rb.linearVelocity).x);

    void Awake()
    {
        _rb = GetComponent<Rigidbody>();
        _rb.centerOfMass = centreOfMass;

        // remember the designed rear grip so the handbrake can restore it
        var rear = new System.Collections.Generic.List<float>();
        foreach (var a in axles)
            if (a.handbraked) { rear.Add(a.left.sidewaysFriction.stiffness); rear.Add(a.right.sidewaysFriction.stiffness); }
        _rearStiffness = rear.ToArray();
    }

    void FixedUpdate()
    {
        float throttle = Input.GetAxis("Vertical");
        float steerIn = Input.GetAxis("Horizontal");
        bool handbrake = Input.GetKey(KeyCode.Space);

        float speed = _rb.linearVelocity.magnitude;
        float forward = Vector3.Dot(_rb.linearVelocity, transform.forward);

        // steering tightens with speed
        float lock_ = Mathf.Lerp(steerLock, steerLockFast, Mathf.Clamp01(speed / topSpeed));
        _steer = Mathf.MoveTowards(_steer, steerIn * lock_, steerRate * lock_ * Time.fixedDeltaTime);

        // throttle, or brake if it opposes the direction of travel
        bool braking = throttle != 0f && Mathf.Sign(throttle) != Mathf.Sign(forward) && Mathf.Abs(forward) > 0.6f;
        float motor = braking ? 0f : throttle * motorTorque * (1f - Mathf.Clamp01(speed / topSpeed));
        float brake = braking ? brakeTorque : 0f;

        int stiffIdx = 0;
        foreach (var a in axles)
        {
            if (a.steering) { a.left.steerAngle = _steer; a.right.steerAngle = _steer; }
            if (a.driven) { a.left.motorTorque = motor; a.right.motorTorque = motor; }

            float b = brake;
            if (handbrake && a.handbraked) b = handbrakeTorque;
            a.left.brakeTorque = b; a.right.brakeTorque = b;

            // Cutting rear sideways stiffness is what turns the handbrake into a
            // drift rather than just a stop.
            if (a.handbraked && _rearStiffness != null)
            {
                foreach (var w in new[] { a.left, a.right })
                {
                    var f = w.sidewaysFriction;
                    f.stiffness = _rearStiffness[stiffIdx] * (handbrake ? handbrakeGrip : 1f);
                    w.sidewaysFriction = f;
                    stiffIdx++;
                }
            }

            PoseWheel(a.left, a.leftMesh);
            PoseWheel(a.right, a.rightMesh);
        }

        // keeps the tall body planted over crests instead of taking off
        _rb.AddForce(-transform.up * downforce * speed);
    }

    /// <summary>
    /// Wheel meshes are driven from the collider, so they spin at the rolling
    /// radius, steer, and rise and fall with the suspension - all for free.
    /// </summary>
    static void PoseWheel(WheelCollider wheel, Transform mesh)
    {
        if (wheel == null || mesh == null) return;
        wheel.GetWorldPose(out var pos, out var rot);
        mesh.SetPositionAndRotation(pos, rot);
    }
}
