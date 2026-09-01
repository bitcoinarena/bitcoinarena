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

        [Tooltip("Fallback height above the ground, used only when the truck " +
                 "has no wheels to measure. Normally the body's height is " +
                 "derived from where its own wheels have to sit.")]
        public float rideHeight = 1.4f;

        public MempoolTerrain terrain;

        [Tooltip("The road deck. Anything standing on the map stands on THIS, " +
                 "not on the bare terrain - the deck is lifted above it.")]
        public RoadNetwork roads;
        public int seed = 0x5eed1234;

        /// <summary>True while the core is actually driving.</summary>
        public bool Driving { get; private set; }

        /// <summary>Last slope under the truck, rise over run. For the debug panel.</summary>
        public float LastGrade { get; private set; }

        /// <summary>Last surface height the truck was set on to.</summary>
        public float LastSurface { get; private set; }

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
        int _solidCount = -1;
        int[] _armour = new int[64 * 2];
        float _solidsChecked;

        // The tick just gone, so a frame landing between two ticks can be
        // drawn between them instead of snapping to the later one.
        float _prevX, _prevZ, _prevHeading;
        bool _havePrev;
        Quaternion _lie = Quaternion.identity;
        Transform[] _wheels;
        Vector3[] _wheelMount;      // in the truck's own frame
        Quaternion[] _wheelBase;    // resting orientation, relative to the truck
        bool[] _wheelSteers;
        float _wheelRadius = 0.55f;

        // How far the body's origin sits above the ground, measured off the
        // wheels rather than assumed.
        //
        // It was a hard-coded 1.4 m, and the axles put the wheel centres at
        // -0.335 m in body space with a 0.55 m radius - so the correct height
        // is 0.885 and the truck rode half a metre high. That was invisible
        // while the wheels hung off the body and floated with it; the moment
        // they were put on the ground where they belong, the body stayed up
        // and the truck looked jacked up on stilts.
        float _bodyAboveGround = 1.4f;
        float _spin;

        void Awake()
        {
            _truck = GetComponent<TruckController>();
            _rb = GetComponent<Rigidbody>();
        }

        void Start()
        {
            if (roads == null) roads = FindFirstObjectByType<RoadNetwork>();

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
            UploadSolids();
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

            if (_wheelMount.Length > 0)
            {
                float meanY = 0f;
                foreach (var m in _wheelMount) meanY += m.y;
                meanY /= _wheelMount.Length;
                _bodyAboveGround = _wheelRadius - meanY;
            }
        }

        /// <summary>True when the axles no longer point at the wheels we hold.</summary>
        bool WheelsWentStale()
        {
            if (_truck == null || _truck.axles == null) return false;

            // Written out rather than looping over a temporary array: this runs
            // every frame, and `new[] { a.leftMesh, a.rightMesh }` allocated
            // one on each axle on each frame. Two hundred small arrays a second
            // is a collection every few seconds, and a collection is a dropped
            // frame - which is exactly the stutter this was meant to prevent.
            int i = 0;
            foreach (var a in _truck.axles)
            {
                if (a == null) continue;
                if (a.leftMesh != null)
                {
                    if (_wheels == null || i >= _wheels.Length || _wheels[i] != a.leftMesh) return true;
                    i++;
                }
                if (a.rightMesh != null)
                {
                    if (_wheels == null || i >= _wheels.Length || _wheels[i] != a.rightMesh) return true;
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

                // Each wheel meets the ground under ITSELF. Hanging them off
                // the body's plane leaves one corner buried and the opposite
                // one in the air the moment the truck is across a slope.
                var at = transform.TransformPoint(_wheelMount[i]);
                if (terrain != null) at.y = Ground(at.x, at.z) + _wheelRadius;

                _wheels[i].SetPositionAndRotation(at,
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

        /// <summary>
        /// Gives the core the solid world.
        ///
        /// Re-checked now and then rather than once: the post office and the
        /// miner arrive from the streamer seconds after the round starts, and
        /// a core that harvested before they landed knows about an empty map.
        /// Cheap, because it only re-uploads when the count actually moves.
        /// </summary>
        void UploadSolids()
        {
            if (Time.unscaledTime - _solidsChecked < 1f && _solidCount >= 0) return;
            _solidsChecked = Time.unscaledTime;

            var boxes = WorldSolids.Gather(transform, out int n);
            if (n == _solidCount) return;
            _solidCount = n;

            if (BlwpCore.SetSolids(boxes, n))
                Debug.Log($"[blwp] {n} solid boxes uploaded");
            else
                Debug.LogWarning("[blwp] the core refused the collision world");
        }

        /// <summary>
        /// The tanks the player can see, every tick.
        ///
        /// Not the core's own army: that one is invisible, and colliding with
        /// it meant the truck drove through everything on screen while being
        /// held perfectly by ghosts.
        /// </summary>
        void UploadArmour()
        {
            var field = Battlefield.Current;
            if (field == null || field.Army == null) return;

            var list = field.Army.Armour;
            int n = Mathf.Min(list.Count, _armour.Length / 2);
            for (int i = 0; i < n; i++)
            {
                _armour[i * 2] = Mathf.RoundToInt(list[i].x * BlwpCore.ONE);
                _armour[i * 2 + 1] = Mathf.RoundToInt(list[i].z * BlwpCore.ONE);
            }
            BlwpCore.SetArmour(_armour, n);
        }

        void Update()
        {
            if (!Driving) return;
            UploadGround();
            UploadSolids();

            // A fixed step, caught up in whole ticks. Rendering interpolates
            // between them; the simulation never sees a partial one.
            UploadArmour();
            _accumulator += Time.deltaTime;
            float step = 1f / Mathf.Max(1, tickHz);
            int guard = 0;
            while (_accumulator >= step && guard++ < 8)
            {
                // Remember where the truck was BEFORE this tick. Without it
                // there is nothing to draw between, and the truck moves in
                // whole ticks - which at any refresh rate that is not an exact
                // multiple of the tick rate means some frames advance it twice
                // and some not at all. That is the stutter: the simulation was
                // smooth all along and the drawing was not.
                _prevX = BlwpCore.Metres(BlwpCore.State[Layout.O_TRUCK + Layout.T_X]);
                _prevZ = BlwpCore.Metres(BlwpCore.State[Layout.O_TRUCK + Layout.T_Z]);
                _prevHeading = BlwpCore.TruckHeading;
                _havePrev = true;

                _accumulator -= step;
                BlwpCore.Step(Throttle(), Steer(), Brake(), Handbrake(), PracticeMode.Input);
            }
            Apply(Mathf.Clamp01(_accumulator / step));
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

        /// <summary>
        /// How the truck lies on four contact points.
        ///
        /// Separate and static so it can be tested without a core: the whole
        /// fault it fixes is invisible from inside the game, because a truck
        /// pinned dead level looks perfectly normal until you notice that a
        /// hill does not tilt it.
        ///
        /// `fl`/`fr`/`rl`/`rr` are ground heights under the four wheels,
        /// `half` is half the wheelbase and `track` half the track width.
        /// </summary>
        public static Quaternion Lie(float heading, float fl, float fr, float rl, float rr,
                                     float half, float track)
        {
            var rot = Quaternion.Euler(0f, heading, 0f);
            Vector3 fwd = rot * Vector3.forward, right = rot * Vector3.right;

            var slopedF = new Vector3(fwd.x, ((fl + fr) - (rl + rr)) / (4f * half), fwd.z).normalized;
            var slopedR = new Vector3(right.x, ((fr + rr) - (fl + rl)) / (4f * track), right.z).normalized;
            return Quaternion.LookRotation(slopedF, Vector3.Cross(slopedF, slopedR));
        }

        /// <summary>
        /// The surface anything STANDS on here - the road deck where there is
        /// one, the bare relief where there is not.
        ///
        /// Not terrain.SampleSurface: the deck is laid ABOVE the relief, so
        /// wheels placed on the terrain sank into the road by exactly the lift
        /// and looked right everywhere else. RoadNetwork carries this exact
        /// warning in its own comment, having been caught by it before.
        ///
        /// The core's physics still reads the bare relief, which is correct -
        /// the deck is a constant lift, so it has the same slope as the ground
        /// beneath it and changes nothing a truck would feel.
        /// </summary>
        float Ground(float x, float z)
        {
            if (roads != null) return roads.SurfaceHeight(x, z);
            return terrain != null ? terrain.SampleSurface(x, z) : 0f;
        }

        /// <summary>
        /// Draws the truck between the last two ticks, lying on the ground.
        ///
        /// `alpha` is how far through the current tick this frame falls.
        /// </summary>
        void Apply(float alpha)
        {
            float x = BlwpCore.Metres(BlwpCore.State[Layout.O_TRUCK + Layout.T_X]);
            float z = BlwpCore.Metres(BlwpCore.State[Layout.O_TRUCK + Layout.T_Z]);
            float heading = BlwpCore.TruckHeading;

            if (_havePrev)
            {
                x = Mathf.Lerp(_prevX, x, alpha);
                z = Mathf.Lerp(_prevZ, z, alpha);
                heading = Mathf.LerpAngle(_prevHeading, heading, alpha);
            }

            // The truck lies on its own four contact points, which is what the
            // WheelColliders did for free and what was lost when the core took
            // over: the body was pinned dead level, so a descent looked exactly
            // like flat ground however steep it was.
            var rot = Quaternion.Euler(0f, heading, 0f);
            Vector3 fwd = rot * Vector3.forward, right = rot * Vector3.right;

            float half = 2.0f, track = 1.15f;      // the axles, from Bootstrap
            float fl = Ground(x + fwd.x * half - right.x * track, z + fwd.z * half - right.z * track);
            float fr = Ground(x + fwd.x * half + right.x * track, z + fwd.z * half + right.z * track);
            float rl = Ground(x - fwd.x * half - right.x * track, z - fwd.z * half - right.z * track);
            float rr = Ground(x - fwd.x * half + right.x * track, z - fwd.z * half + right.z * track);

            var lie = Lie(heading, fl, fr, rl, rr, half, track);

            // Eased, because the relief is sampled per frame and a truck on
            // springs does not snap to every pebble.
            _lie = Quaternion.Slerp(_lie, lie, 1f - Mathf.Exp(-8f * Time.deltaTime));

            float ride = (fl + fr + rl + rr) * 0.25f + _bodyAboveGround;
            LastSurface = (fl + fr + rl + rr) * 0.25f;
            LastGrade = ((fl + fr) - (rl + rr)) / (4f * half);
            transform.SetPositionAndRotation(new Vector3(x, ride, z), _lie);

            if (_rb != null) _rb.position = transform.position;
            PoseWheels();
        }
    }
}
