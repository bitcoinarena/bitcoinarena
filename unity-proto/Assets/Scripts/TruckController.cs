// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
    // Empty, not new Axle[2]: AddComponent runs Awake immediately, so a default
    // array of nulls would be walked before anything could fill it in.
    public Axle[] axles = new Axle[0];

    [Header("Drivetrain")]
    // Traction-limited, not power-limited: raising this to 4800 spun the tyres
    // up and the truck travelled LESS (2.6 units in 3 s against 12 at 2600).
    // More speed has to come from the tyre model or lighter relief, not torque.
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
    public float handbrakeGrip = 0.2f;

    /// <summary>
    /// Drive this truck from code rather than the keyboard. The unattended
    /// trucks in the full game need exactly this seam, and it lets the physics
    /// rig be tested through the real control path instead of around it.
    /// </summary>
    [System.NonSerialized] public bool useExternalInput;

    /// <summary>
    /// Set while the player is loading the truck. Driving off before the
    /// freight is aboard is the one thing the loading bay exists to prevent.
    /// </summary>
    [System.NonSerialized] public bool controlsLocked;

    /// <summary>
    /// Set by CoreDrivenTruck while the deterministic core is driving.
    ///
    /// Everything below this point assumes PhysX is simulating: motor torque,
    /// downforce, and above all posing the wheel meshes in WORLD space from
    /// WheelCollider.GetWorldPose. Once the body is kinematic and the chassis
    /// is written from the core, none of that resolves any more - the wheels
    /// were left behind in world space while the body turned away from them,
    /// which is exactly what it looked like on the phone.
    /// </summary>
    [System.NonSerialized] public bool externallyDriven;

    /// <summary>
    /// Condition, 0..1. A battered truck pulls, loses power and steers badly.
    ///
    /// Without this the health bar was binary - whole or dead - and a hit
    /// changed nothing you could feel until the last one. Set by TruckHealth.
    /// </summary>
    [System.NonSerialized] public float condition = 1f;
    [System.NonSerialized] public float externalThrottle;
    [System.NonSerialized] public float externalSteer;
    [System.NonSerialized] public bool externalHandbrake;

    Rigidbody _rb;
    float _steer;
    float[] _rearStiffness;      // sideways, per rear wheel
    float[] _rearForward;        // longitudinal, per rear wheel

    /// <summary>Where the truck goes back to when it leaves the world or lands on its roof.</summary>
    [System.NonSerialized] public Vector3 spawnPosition;
    [System.NonSerialized] public Quaternion spawnRotation = Quaternion.identity;

    public float SpeedKmh => _rb.linearVelocity.magnitude * 3.6f;

    /// <summary>Front wheel angle in degrees. Read by the reference harness.</summary>
    public float SteerAngle => _steer;
    /// <summary>How far the truck is travelling sideways, in m/s. This is the drift readout.</summary>
    public float Slip => Mathf.Abs(transform.InverseTransformDirection(_rb.linearVelocity).x);

    void Awake()
    {
        _rb = GetComponent<Rigidbody>();
        _rb.centerOfMass = centreOfMass;
        spawnPosition = transform.position;
        spawnRotation = transform.rotation;
        _pull = Random.value < 0.5f ? -1f : 1f;
    }

    /// <summary>Drop the truck back on its start mark, stationary and upright.</summary>
    /// <summary>Which way a damaged truck pulls. Fixed per truck.</summary>
    float _pull;

    public void Respawn()
    {
        // PHYSX DOES NOT OWN THE POSE OF A CORE-DRIVEN TRUCK (2026-09-16).
        //
        // While the core is answering, `CoreDrivenTruck` holds this Rigidbody kinematic and rewrites
        // the transform from core words every frame. These four writes therefore moved nothing at all
        // on that path - measured on the Daily, the truck's re-seat came entirely from the teleport
        // below - while making the code read as though PhysX still decided where the truck was. They
        // stay for the free-driving truck, which really is a physics body.
        if (!externallyDriven)
        {
            _rb.linearVelocity = Vector3.zero;
            _rb.angularVelocity = Vector3.zero;
            _rb.position = spawnPosition;
            _rb.rotation = spawnRotation;
        }
        transform.SetPositionAndRotation(spawnPosition, spawnRotation);
        _steer = 0f;

        // And tell the core, which owns the position when it is driving.
        //
        // Without this the two lines above were undone on the very next frame:
        // the truck was moved back to the bay and the core put it straight
        // back at the miner. A round that timed out therefore did nothing
        // visible at all - the player stayed where they were, could not load,
        // and the bay was eighty metres away.
        if (externallyDriven)
        {
            // HOW FAR THE CORE'S TRUCK ACTUALLY MOVED (2026-09-16 08:17).
            //
            // The four Rigidbody writes above cannot move a core-driven truck: `CoreDrivenTruck` holds
            // the body kinematic while the core answers and rewrites the transform from core words
            // every frame. So the jump a player sees is this teleport and nothing else, and the size of
            // it is the CORE's before-and-after, not Unity's. Measured here rather than inferred.
            var before = Arena.ArenaCore.TruckPosition(0f);
            bool took = Arena.ArenaCore.Teleport(spawnPosition, spawnRotation.eulerAngles.y);
            var after = Arena.ArenaCore.TruckPosition(0f);
            float moved = Vector2.Distance(new Vector2(before.x, before.z), new Vector2(after.x, after.z));
            Debug.Log($"[spawnmark] respawn teleport {(took ? "taken" : "REFUSED")}: core was "
                      + $"{before.x:F2},{before.z:F2} -> {after.x:F2},{after.z:F2}, moved {moved:F2} m in 2-D; "
                      + $"asked for {spawnPosition.x:F2},{spawnPosition.z:F2} "
                      + $"(y {spawnPosition.y:F2} dropped by the core, which owns height)");
        }
    }

    /// <summary>
    /// Remember the designed rear grip so the handbrake has something to restore.
    /// Deferred rather than done in Awake because a truck assembled in code has
    /// no axles yet at the moment AddComponent returns.
    /// </summary>
    void EnsureInit()
    {
        if (_rearStiffness != null) return;
        var side = new System.Collections.Generic.List<float>();
        var fwd = new System.Collections.Generic.List<float>();
        foreach (var a in axles)
        {
            if (a == null || !a.handbraked || a.left == null || a.right == null) continue;
            side.Add(a.left.sidewaysFriction.stiffness);
            side.Add(a.right.sidewaysFriction.stiffness);
            fwd.Add(a.left.forwardFriction.stiffness);
            fwd.Add(a.right.forwardFriction.stiffness);
        }
        _rearStiffness = side.ToArray();
        _rearForward = fwd.ToArray();
    }

    void FixedUpdate()
    {
        if (externallyDriven) return;
        if (axles == null || axles.Length == 0) return;
        EnsureInit();

        float throttle = useExternalInput ? externalThrottle : DriveInput.Throttle;
        float steerIn = useExternalInput ? externalSteer : DriveInput.Steer;
        bool handbrake = useExternalInput ? externalHandbrake : DriveInput.Handbrake;
        if (!useExternalInput && DriveInput.Reset) Respawn();

        // Held at the loading bay until the freight is aboard. The handbrake
        // rather than merely no throttle, so it stands still on the slope the
        // apron happens to be on instead of rolling into the war unmanned.
        if (controlsLocked)
        {
            throttle = 0f;
            steerIn = 0f;
            handbrake = true;
        }

        // Damage is felt, not just displayed. A beaten truck is down on power
        // and pulls to one side, so the last stretch of a bad run is a fight.
        // The pull is deterministic per truck rather than random, or it would
        // read as the controls being unreliable instead of the truck being
        // hurt.
        float hurt = 1f - Mathf.Clamp01(condition);
        if (hurt > 0.02f)
        {
            throttle *= Mathf.Lerp(1f, 0.55f, hurt);
            steerIn = Mathf.Clamp(steerIn + _pull * hurt * 0.35f, -1f, 1f);
        }

        float speed = _rb.linearVelocity.magnitude;
        float forward = Vector3.Dot(_rb.linearVelocity, transform.forward);

        // steering tightens with speed
        float lock_ = Mathf.Lerp(steerLock, steerLockFast, Mathf.Clamp01(speed / topSpeed));
        _steer = Mathf.MoveTowards(_steer, steerIn * lock_, steerRate * lock_ * Time.fixedDeltaTime);

        // throttle, or brake if it opposes the direction of travel
        bool braking = throttle != 0f && Mathf.Sign(throttle) != Mathf.Sign(forward) && Mathf.Abs(forward) > 0.6f;
        float motor = braking ? 0f : throttle * motorTorque * (1f - Mathf.Clamp01(speed / topSpeed));
        float brake = braking ? brakeTorque : 0f;

        // Hold on a hill. The ground here is generated from live mempool data,
        // so the slope under a parked truck is different every session - and
        // without this it simply rolls away whenever you let go, which is both
        // annoying to play and why "does it come to rest" was measuring
        // something different on every run.
        if (throttle == 0f && !handbrake)
            // Below a walking pace it holds outright; above it this is engine
            // braking, which a lorry has and which is what stops a slope from
            // accelerating it away. A brake that only engages under 1.5 m/s
            // never engages at all: it rolls straight past that on the way down.
            brake = Mathf.Max(brake, brakeTorque * (speed < 2f ? 0.6f : 0.14f));

        int stiffIdx = 0, grounded = 0;
        foreach (var a in axles)
        {
            if (a == null || a.left == null || a.right == null) continue;
            if (a.left.isGrounded) grounded++;
            if (a.right.isGrounded) grounded++;
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
                    // A locked wheel loses grip in BOTH directions. Cutting only
                    // the sideways stiffness leaves the rear still pulling the
                    // truck straight, so it just brakes instead of stepping out.
                    var side = w.sidewaysFriction;
                    side.stiffness = _rearStiffness[stiffIdx] * (handbrake ? handbrakeGrip : 1f);
                    w.sidewaysFriction = side;

                    var fwd = w.forwardFriction;
                    fwd.stiffness = _rearForward[stiffIdx] * (handbrake ? handbrakeGrip : 1f);
                    w.forwardFriction = fwd;
                    stiffIdx++;
                }
            }

            PoseWheel(a.left, a.leftMesh);
            PoseWheel(a.right, a.rightMesh);
        }

        // Keeps the tall body planted over crests. ONLY while a wheel is down:
        // -transform.up flips to world-up once the truck rolls past 90 degrees,
        // turning downforce into thrust that scales with speed - a runaway that
        // launched the truck off the map at 136 m/s.
        if (grounded > 0)
            _rb.AddForce(-transform.up * Mathf.Min(downforce * speed, downforce * topSpeed));

        // Airborne, upside down, or off the edge of the world: put it back.
        if (_rb.position.y < -40f
            || Mathf.Abs(_rb.position.x) > 200f || Mathf.Abs(_rb.position.z) > 130f)
            Respawn();
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
