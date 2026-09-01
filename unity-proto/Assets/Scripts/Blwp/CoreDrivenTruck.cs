using UnityEngine;

namespace Blwp
{
    /// <summary>
    /// Drives the truck from the deterministic core instead of from PhysX.
    ///
    /// This is the whole of M1 in one component. When it is enabled and a core
    /// is answering, the Rigidbody is switched to kinematic and the transform
    /// is written from the core's state each tick - Unity stops being a
    /// simulator and becomes a renderer.
    ///
    /// Two things it deliberately does NOT touch: the chase camera and the
    /// suspension, particle and audio work. Those read the truck's transform
    /// and speed and go on working unchanged, which is the point of keeping the
    /// core's output in the same units Unity already uses.
    /// </summary>
    [RequireComponent(typeof(TruckController))]
    public class CoreDrivenTruck : MonoBehaviour
    {
        [Tooltip("Off by default. The core only exists in a WebGL build with " +
                 "the bundle loaded, and everywhere else the truck must keep " +
                 "its own physics or it simply stands still.")]
        public bool useCore = true;

        [Tooltip("Simulation rate. Fixed, and decoupled from the frame rate: a " +
                 "time step that follows deltaTime is not reproducible, which " +
                 "is the one thing the core cannot give up.")]
        public int tickHz = 60;

        [Tooltip("Height above the sampled ground. The core is two-dimensional; " +
                 "the terrain is Unity's.")]
        public float rideHeight = 1.4f;

        public MempoolTerrain terrain;
        public int seed = 0x5eed1234;

        /// <summary>True while the core is actually driving.</summary>
        public bool Driving { get; private set; }

        TruckController _truck;
        Rigidbody _rb;
        float _accumulator;
        bool _wasKinematic;

        // Wheel meshes, and where each one sits ON THE TRUCK.
        //
        // World space, deliberately, because the meshes are NOT children of
        // the chassis - Bootstrap instantiates them unparented and the old
        // code placed them in the world each frame from the WheelCollider.
        // Posing them in local space instead parked the whole set at the
        // world origin and the truck drove around with no wheels at all.
        //
        // So: same world-space placement as before, but the pose comes from
        // the core rather than from a collider that is no longer simulated.
        // The colliders ARE children of the chassis, so they still give the
        // mounting points for free.
        int _groundRevision = -1;
        Transform[] _wheels;
        Vector3[] _wheelMount;      // in the truck's own frame
        Quaternion[] _wheelBase;    // resting orientation, relative to the truck
        bool[] _wheelSteers;
        float _wheelRadius = 0.55f;
        float _spin;

        void Awake()
        {
            _truck = GetComponent<TruckController>();
            _rb = GetComponent<Rigidbody>();
        }

        void Start()
        {
            if (!useCore) return;
            if (!BlwpCore.Init(seed))
            {
                // Not an error in the editor: there is no JavaScript there, and
                // the fallback to PhysX is the correct behaviour rather than a
                // degraded one.
                Debug.Log(BlwpCore.Compiled
                    ? "[blwp] no core answered - falling back to PhysX"
                    : "[blwp] not a WebGL build - PhysX drives, as expected");
                return;
            }

            Driving = true;
            if (_rb != null) { _wasKinematic = _rb.isKinematic; _rb.isKinematic = true; }
            if (_truck != null) _truck.externallyDriven = true;
            CollectWheels();
            UploadGround();
            Debug.Log("[blwp] core is driving");
        }

        void OnDisable()
        {
            if (Driving && _rb != null) _rb.isKinematic = _wasKinematic;
            if (Driving && _truck != null) _truck.externallyDriven = false;
            Driving = false;
        }

        /// <summary>Remembers where each wheel sits on the truck.</summary>
        void CollectWheels()
        {
            var t = new System.Collections.Generic.List<Transform>();
            var steers = new System.Collections.Generic.List<bool>();
            var mount = new System.Collections.Generic.List<Vector3>();
            var basis = new System.Collections.Generic.List<Quaternion>();

            if (_truck != null && _truck.axles != null)
                foreach (var a in _truck.axles)
                {
                    if (a == null) continue;
                    foreach (var pair in new[] { (a.leftMesh, a.left), (a.rightMesh, a.right) })
                    {
                        var mesh = pair.Item1;
                        var col = pair.Item2;
                        if (mesh == null) continue;

                        t.Add(mesh);
                        steers.Add(a.steering);

                        // The collider is a child of the chassis and sits where
                        // the wheel belongs; drop it by the resting suspension
                        // travel so the wheel is not floating in the arch.
                        if (col != null)
                        {
                            var local = transform.InverseTransformPoint(col.transform.position);
                            local.y -= col.suspensionDistance * col.suspensionSpring.targetPosition;
                            mount.Add(local);
                            _wheelRadius = Mathf.Max(0.1f, col.radius);
                        }
                        else mount.Add(transform.InverseTransformPoint(mesh.position));

                        basis.Add(Quaternion.Inverse(transform.rotation) * mesh.rotation);
                    }
                }

            _wheels = t.ToArray();
            _wheelSteers = steers.ToArray();
            _wheelMount = mount.ToArray();
            _wheelBase = basis.ToArray();
        }

        /// <summary>True when the axles no longer point at the wheels we hold.</summary>
        bool WheelsWentStale()
        {
            if (_truck == null || _truck.axles == null) return false;
            int i = 0;
            foreach (var a in _truck.axles)
            {
                if (a == null) continue;
                foreach (var mesh in new[] { a.leftMesh, a.rightMesh })
                {
                    if (mesh == null) continue;
                    if (_wheels == null || i >= _wheels.Length || _wheels[i] != mesh) return true;
                    i++;
                }
            }
            return _wheels != null && i != _wheels.Length;
        }

        /// <summary>
        /// Wheels from the core: the front pair turn with the steer angle and
        /// every wheel rolls at the speed the core reports. Purely visual, so
        /// the spin may use frame time - nothing here is read back.
        /// </summary>
        void PoseWheels()
        {
            // Bootstrap swaps the placeholder truck for the streamed model
            // after Start and hands the axles a different set of wheels, so
            // the list collected once at startup goes stale. Cheap to notice,
            // and invisible if it is missed - the old wheels simply keep being
            // posed while the new ones sit wherever they were instantiated.
            if (WheelsWentStale()) CollectWheels();
            if (_wheels == null || _wheels.Length == 0) return;

            float steer = BlwpCore.TruckSteerDegrees;
            float speed = BlwpCore.TruckSpeed;

            // Once per frame, not once per wheel: advancing it inside the loop
            // left every wheel on a slightly different angle.
            _spin += speed / _wheelRadius * Mathf.Rad2Deg * Time.deltaTime;
            if (_spin > 360f || _spin < -360f) _spin %= 360f;

            for (int i = 0; i < _wheels.Length; i++)
            {
                if (_wheels[i] == null) continue;
                var turn = Quaternion.Euler(0f, _wheelSteers[i] ? steer : 0f, 0f);
                _wheels[i].SetPositionAndRotation(
                    transform.TransformPoint(_wheelMount[i]),
                    transform.rotation * turn * _wheelBase[i] * Quaternion.Euler(_spin, 0f, 0f));
            }
        }

        /// <summary>
        /// Gives the core the relief the game is drawing.
        ///
        /// Re-sent when the terrain rebuilds, because the ground comes from a
        /// live fetch and changes under us: a core still holding the flat
        /// placeholder from before the first fetch would drive a hillside as
        /// though it were a table, which is exactly the bug this exists to fix.
        /// </summary>
        void UploadGround()
        {
            if (terrain == null || _groundRevision == terrain.Revision) return;
            _groundRevision = terrain.Revision;

            const int cols = 160, rows = 96;      // the terrain's own grid
            if (BlwpCore.SetGround(terrain.HeightGrid(cols, rows), cols, rows))
                Debug.Log($"[blwp] relief uploaded, revision {_groundRevision}");
            else
                Debug.LogWarning("[blwp] the core refused the relief - it stays flat");
        }

        void Update()
        {
            if (!Driving) return;
            UploadGround();

            // A fixed step, caught up in whole ticks. Rendering interpolates
            // between them; the simulation never sees a partial one.
            _accumulator += Time.deltaTime;
            float step = 1f / Mathf.Max(1, tickHz);
            int guard = 0;
            while (_accumulator >= step && guard++ < 8)
            {
                _accumulator -= step;
                BlwpCore.Step(Throttle(), Steer(), Brake(), Handbrake(), PracticeMode.Input);
            }
            Apply();
        }

        /// <summary>
        /// Inputs in the core's own units, Q16.16 in [-1, 1].
        ///
        /// Converted here and nowhere else: the boundary is the one place a
        /// rounding rule could differ between the recorded transcript and the
        /// replay, so it happens once and is easy to audit.
        /// </summary>
        bool Locked => _truck != null && _truck.controlsLocked;

        int Throttle() => Q(Locked ? 0f : DriveInput.Throttle);
        int Steer() => Q(Locked ? 0f : DriveInput.Steer);

        // Brake and handbrake are separate inputs in the core but the game has
        // only ever had one. Reverse throttle brakes, as it does today, and the
        // handbrake maps straight across.
        int Brake() => 0;
        int Handbrake() => Locked || !DriveInput.Handbrake ? 0 : BlwpCore.ONE;

        static int Q(float v) => Mathf.RoundToInt(Mathf.Clamp(v, -1f, 1f) * BlwpCore.ONE);

        void Apply()
        {
            float ground = terrain != null
                ? terrain.SampleSurface(BlwpCore.Metres(BlwpCore.State[Layout.O_TRUCK + Layout.T_X]),
                                        BlwpCore.Metres(BlwpCore.State[Layout.O_TRUCK + Layout.T_Z]))
                : 0f;

            transform.SetPositionAndRotation(
                BlwpCore.TruckPosition(ground + rideHeight),
                Quaternion.Euler(0f, BlwpCore.TruckHeading, 0f));

            if (_rb != null) _rb.position = transform.position;
            PoseWheels();
        }
    }
}
