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
        float _rollRadius = 0.55f;   // the MESH's radius, which is what it rolls on
        Vector3[] _wheelHub = new Vector3[0];   // pivot -> mesh centre, in the wheel's frame
        float[] _wheelR = new float[0];         // the mesh's own radius, in world metres

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
        float _saidSeat = -99f;
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
            Debug.Log("[blwp] core is driving");
        }

        /// <summary>
        /// The bay has shut and the player is let go: a round begins.
        ///
        /// Here rather than at the three endings, because the score card is
        /// read out of the core AFTER a run finishes - `RunScore.Score` asks
        /// `BlwpCore.RunScore()` - and resetting on arrival would blank the
        /// card the player is looking at. Roll-out is the first moment nobody
        /// is still reading the last round.
        ///
        /// The seed is the same one `Start` used, so the same drive produces
        /// the same round: that is the point of the reset, not a side effect
        /// of it.
        /// </summary>
        public void StartRound()
        {
            if (!Driving) return;
            if (!RollOutRestarts(BlwpNet.RoundSeed, seed, out int world))
            {
                // A LIVE ROUND IS ALREADY RUNNING and roll-out is inside it.
                Debug.Log("[blwp] roll-out inside a live round: the core keeps its run");
                return;
            }
            if (!BlwpCore.Restart(world)) return;
            _prevHeading = BlwpCore.TruckHeading;
            Debug.Log("[blwp] round restarted in the core");
        }

        /// <summary>
        /// WHETHER A ROLL-OUT MAY RESTART THE CORE, AND IN WHICH WORLD.
        ///
        /// On the daily it must: one core plays many rounds, `outcome` latches,
        /// and a second round on a state that still holds the first is the
        /// unplayable round this reset was written for. The world is this
        /// component's constant, which is what holds the solo apron on bay 13.
        ///
        /// ON A LIVE ROUND IT MUST NOT, and that is not a preference. The run
        /// began when the page seeded the core, and the client has been
        /// recording every tick since the join - the 16:08 report saw tick 4241
        /// while the truck was still in the bay. A restart in the middle puts
        /// the player's core back at tick zero while the transcript they are
        /// publishing runs straight through, so the committee replaying those
        /// very ticks reaches a different state. MEASURED, 120 ticks with a
        /// roll-out at 60: the page holds afa591f2… and the replay holds
        /// 686abbf1…, and the two trucks are 0.28 m apart already. Every mark
        /// the player signs after it commits to a state nobody else computes,
        /// and every watcher's picture is of the replay rather than of the
        /// truck being driven.
        ///
        /// A pure rule with no core in it, so it can be measured without one.
        /// `roundSeed` is `BlwpNet.RoundSeed`: zero means no round.
        /// </summary>
        public static bool RollOutRestarts(int roundSeed, int dailySeed, out int world)
        {
            world = roundSeed == 0 ? dailySeed : roundSeed;
            return roundSeed == 0;
        }

        /// <summary>
        /// A ROUND THAT CANNOT BE SETTLED IS NOT DRIVEN ON.
        ///
        /// The client ends a run - VOID - when its hold fills and no transcript
        /// from there can be replayed. Nothing in the game was told: the truck
        /// kept driving, the core kept stepping, and the player finished a round
        /// nobody could pay out.
        ///
        /// Its own function because it is a RULE, and rules here are measured.
        /// `BlwpNet` is a stub outside a WebGL player, so nothing in an editor
        /// will ever answer `true` - which is exactly why the rule has to be
        /// readable without one. Unity decides no outcome: the word and the
        /// reason are the client's, and this only says when to stop presenting
        /// a live run.
        /// </summary>
        public static bool ShouldStop(bool driving, bool ended) => driving && ended;

        /// <summary>
        /// Whether the player's inputs still reach the core.
        ///
        /// The same answer from two directions: the game's own lock, and a run
        /// that is over. Steering a round that cannot be settled is the thing
        /// this door is about, so the second is not a convenience.
        /// </summary>
        public static bool LocksControls(bool controlsLocked, bool ended)
            => controlsLocked || ended;

        /// <summary>
        /// Stops stepping and LOCKS the truck, once, saying why.
        ///
        /// Not the handover `OnDisable` does. That one gives the truck back to
        /// the player, which is right when a component is disabled and wrong
        /// when a round can no longer be settled - and it was what this did at
        /// first, so the core stopped and the player drove on under PhysX.
        /// Nothing is scored and no outcome is chosen: the reason is repeated,
        /// not decided.
        /// </summary>
        public void StopDriving(string why)
        {
            if (!Driving) return;
            HandBack(lockControls: true);
            Debug.Log($"[blwp] the core stopped driving: {why}");
        }

        /// <summary>
        /// Gives the truck back to the physics controller, and says whether the
        /// player may drive it afterwards.
        ///
        /// ONE HANDOVER, because there were two. `StopDriving` and `OnDisable`
        /// each wrote the same three lines, which is how they drift - and the
        /// first version of the stop proved it: it handed the truck back
        /// EXACTLY as `OnDisable` does, so the core stopped stepping and the
        /// player carried on driving the round under PhysX. The core stopping
        /// was never the point; the player not driving a round that cannot be
        /// settled was.
        ///
        /// `controlsLocked` is the lock the rest of the game already uses -
        /// `LoadoutPanel` at the bay, `SplashScreen` at the title - and it is
        /// the handbrake rather than merely no throttle, so a truck on a slope
        /// stands still instead of rolling into the war unmanned. Disabling the
        /// component in the ordinary way does NOT lock it: that is a handover,
        /// not an ending.
        /// </summary>
        public void HandBack(bool lockControls)
        {
            if (_rb != null) _rb.isKinematic = _wasKinematic;
            if (_truck != null)
            {
                _truck.externallyDriven = false;
                if (lockControls) _truck.controlsLocked = true;
            }
            Driving = false;
        }

        void OnDisable()
        {
            if (Driving) HandBack(lockControls: false);
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

            // THE WHEEL'S OWN SIZE AND ITS OWN CENTRE.
            //
            // A wheel was seated one COLLIDER radius above the ground - 0.550 m
            // - while the streamed mesh reaches 0.728 m from its pivot. The
            // difference is 0.178 m and that is exactly how far the tyre was
            // measured inside the road, standing still, with the core and the
            // drawn terrain agreeing to a millimetre and no crater lag at all.
            //
            // It varies with angle, from 0.523 m to 0.728 m, because the mesh's
            // bounds are not centred on the pivot: the wheel turns about a
            // point that is not its middle, so it swings through the ground.
            // Both are fixed by the same two numbers, taken from the renderer
            // rather than from a collider that describes something else.
            _wheelHub = new Vector3[t.Count];
            _wheelR = new float[t.Count];
            for (int i = 0; i < t.Count; i++)
            {
                var r = t[i].GetComponentInChildren<Renderer>();
                if (r == null) { _wheelR[i] = _wheelRadius; continue; }
                var lb = r.localBounds;
                Vector3 world = r.transform.TransformPoint(lb.center) - t[i].position;
                _wheelHub[i] = Quaternion.Inverse(t[i].rotation) * world;
                float ry = r.transform.TransformVector(new Vector3(0f, lb.extents.y, 0f)).magnitude;
                float rz = r.transform.TransformVector(new Vector3(0f, 0f, lb.extents.z)).magnitude;
                _wheelR[i] = Mathf.Max(ry, rz);
            }

            if (_wheelMount.Length > 0)
            {
                float meanY = 0f;
                foreach (var m in _wheelMount) meanY += m.y;
                meanY /= _wheelMount.Length;
                // the body rides on the same radius the wheels do
                float mean = 0f;
                foreach (var r in _wheelR) mean += r;
                if (_wheelR.Length > 0) mean /= _wheelR.Length; else mean = _wheelRadius;
                _bodyAboveGround = mean - meanY;

                // AND THE WHEEL ROLLS ON THE SIZE IT IS DRAWN AS.
                //
                // The spin was advanced on the COLLIDER's radius while every
                // seating line used the mesh's, which is the same leftover
                // 3bd4208 took out of the seating and left in the rolling:
                // 0.550 m against 0.523 m, so the tyre turned 5.2% slower than
                // the ground it stands on and slipped for the whole drive.
                _rollRadius = mean;
            }
        }

        /// <summary>
        /// The radius the wheels are SEATED on, and the meshes being seated.
        ///
        /// Read-only, and here so the seating can be measured rather than
        /// looked at: a wheel is placed one radius above the ground, so if the
        /// radius is not the mesh's own the mesh sinks or floats by exactly
        /// the difference and nothing in the game says so.
        /// </summary>
        public float WheelRadius => _wheelRadius;
        public float RollRadius => _rollRadius;
        public System.Collections.Generic.IReadOnlyList<Transform> Wheels => _wheels;
        public float BodyAboveGround => _bodyAboveGround;

        /// <summary>
        /// WHERE ONE WHEEL ACTUALLY ENDED UP, in numbers a rotation cannot fake.
        ///
        /// `Renderer.bounds` is axis-aligned in WORLD space, so a spinning
        /// wheel reports a taller box every frame without one vertex having
        /// moved, and `ground - bounds.min.y` - the number the browser probe
        /// called `sunk` - grows with it. Measured on the daily: standing at
        /// the depot the box half-height is 0.523 m and the bury is 0.000; the
        /// moment the wheel turns the half-height runs 0.539..0.763 m and the
        /// bury runs 0.016..0.240 m, matching `half-height - 0.523` to within
        /// a millimetre on all thirteen driving samples while the mesh's own
        /// local extents never moved off 0.415, 0.680, 0.680.
        ///
        /// So `Box` is kept, because it is what a screenshot of the old probe
        /// shows, and `Tyre` is the reading that means something: the mesh's
        /// CENTRE against the height it is seated at. The wheel is a disc
        /// whose two cross-axle extents are equal, so its distance from centre
        /// to rim is the same at every spin angle - which makes `Tyre` the
        /// only one of the two that answers "is the tyre in the road".
        /// </summary>
        public struct WheelSeating
        {
            public float Ground;      // the surface under this wheel
            public float Radius;      // the mesh's own radius, in world metres
            public float CentreY;     // where the mesh's middle actually is
            public float BoxBottomY;  // the world-aligned box's lowest face

            /// <summary>Metres of tyre under the road. Rotation-proof.</summary>
            public float Tyre => Ground + Radius - CentreY;

            /// <summary>What the world-aligned box claims. Inflates when turning.</summary>
            public float Box => Ground - BoxBottomY;
        }

        /// <summary>Reads wheel `i` after a `PoseWheels`. False if it has none.</summary>
        public bool SeatingOf(int i, out WheelSeating seating)
        {
            seating = default;
            if (_wheels == null || i < 0 || i >= _wheels.Length || _wheels[i] == null) return false;

            var rs = _wheels[i].GetComponentsInChildren<Renderer>();
            if (rs.Length == 0) return false;
            var b = rs[0].bounds;
            for (int k = 1; k < rs.Length; k++) b.Encapsulate(rs[k].bounds);

            var at = transform.TransformPoint(_wheelMount[i]);
            seating.Ground = Ground(at.x, at.z);
            seating.Radius = i < _wheelR.Length ? _wheelR[i] : _wheelRadius;
            seating.CentreY = b.center.y;
            seating.BoxBottomY = b.min.y;
            return true;
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
        float _nextSeatingSay;

        /// <summary>
        /// Puts the wheel meshes where the core's drive says they are.
        ///
        /// The steer angle, the road speed and the frame time are handed in
        /// rather than read here, so the seating can be run - unchanged - in
        /// an editor where `BlwpCore` is a stub and would answer nothing but
        /// zero. The Update call site passes the core's own three numbers.
        /// </summary>
        public void PoseWheels(float steer, float speed, float dt)
        {
            // Bootstrap swaps the placeholder truck for the streamed model
            // after Start and hands the axles a different set of wheels, so
            // the list collected once at startup goes stale. Cheap to notice,
            // and invisible if it is missed - the old wheels simply keep being
            // posed while the new ones sit wherever they were instantiated.
            if (WheelsWentStale()) { CollectWheels(); _nextSeatingSay = 0f; }
            if (_wheels == null || _wheels.Length == 0) return;

            // Once per frame, not once per wheel: advancing it inside the loop
            // left every wheel on a slightly different angle.
            _spin += speed / _rollRadius * Mathf.Rad2Deg * dt;
            if (_spin > 360f || _spin < -360f) _spin %= 360f;

            for (int i = 0; i < _wheels.Length; i++)
            {
                if (_wheels[i] == null) continue;
                var turn = Quaternion.Euler(0f, _wheelSteers[i] ? steer : 0f, 0f);

                // Each wheel meets the ground under ITSELF. Hanging them off
                // the body's plane leaves one corner buried and the opposite
                // one in the air the moment the truck is across a slope.
                var at = transform.TransformPoint(_wheelMount[i]);
                var spin = transform.rotation * turn * _wheelBase[i]
                         * Quaternion.Euler(_spin, 0f, 0f);

                // The MESH's centre goes one MESH radius above the ground, and
                // the pivot is placed wherever that requires. Seating the pivot
                // instead put the tyre 0.178 m into the road.
                float radius = i < _wheelR.Length ? _wheelR[i] : _wheelRadius;
                Vector3 hub = i < _wheelHub.Length ? spin * _wheelHub[i] : Vector3.zero;
                if (terrain != null) at.y = Ground(at.x, at.z) + radius;
                _wheels[i].SetPositionAndRotation(at - hub, spin);

                // WHERE THE WHEEL ACTUALLY ENDED UP, once per set of wheels.
                // A wheel is seated one `_wheelRadius` above the ground, and
                // that radius comes off a WheelCollider - so if the streamed
                // mesh is a different size the mesh sinks or floats by exactly
                // the difference, and nothing in the game says so because the
                // body is seated off the same number and looks right. The
                // editor cannot see this: the wheels are streamed, so they
                // only exist in a player.
                // Behind the DEBUG toggle now that the letter is closed. It
                // is the instrument that produced the finding and a future
                // re-measurement wants it, but a shipping build should not be
                // writing a console line every two seconds forever.
                if (GameSettings.Debug && Time.time > _nextSeatingSay && i == 0)
                {
                    var rs = _wheels[i].GetComponentsInChildren<Renderer>();
                    if (rs.Length > 0)
                    {
                        var b = rs[0].bounds;
                        for (int k = 1; k < rs.Length; k++) b.Encapsulate(rs[k].bounds);
                        float g = Ground(at.x, at.z);
                        // FOUR ANSWERS FOR ONE PLACE. The wheels float 2 cm
                        // over `Ground`, so if they still look buried then
                        // what is DRAWN under them is not what they stand on.
                        // These are the candidates: the core's surface, the
                        // terrain mesh's own idea of it, and the road deck on
                        // top. Whichever disagrees is the one in the picture.
                        // THE MESH'S OWN BOX, not its world one. `bounds` is
                        // axis-aligned in WORLD space, so a rotated wheel
                        // reports a bigger box without a vertex having moved.
                        // `localBounds` cannot change with rotation at all, and
                        // unlike `mesh.vertices` it does not need Read/Write on
                        // the import - measured: the vertex scan came back as
                        // float.MaxValue in a player, because the streamed model
                        // is not readable at runtime.
                        var lb = rs[0].localBounds;
                        var e = lb.extents;
                        string axle = e.x <= e.y && e.x <= e.z ? "X"
                                    : e.y <= e.z ? "Y" : "Z";
                        float localR = Mathf.Max(e.x, Mathf.Max(e.y, e.z));

                        float core = BlwpCore.HasSurface
                            ? BlwpCore.SurfaceAt(at.x, at.z) : float.NaN;
                        float drawn = terrain != null
                            ? terrain.SampleSurface(at.x, at.z) : float.NaN;
                        float deck = roads != null ? roads.Lift(at.x, at.z) : 0f;
                        float wear = roads != null ? roads.WearAt(at.x, at.z) : 0f;
                        Debug.Log($"[wheel] {_wheels[i].name}: visual radius "
                                  + $"{b.extents.y:F3} m, seated on {(i < _wheelR.Length ? _wheelR[i] : _wheelRadius):F3} m, "
                                  + $"bottom {b.min.y:F3}, ground {g:F3}, "
                                  + $"box sunk {g - b.min.y:F3} m, tyre sunk "
                                  + $"{(SeatingOf(i, out var seat) ? seat.Tyre : float.NaN):F3} m "
                                  + $"| core {core:F3}, "
                                  + $"terrain {drawn:F3}, deck lift {deck:F3}, "
                                  + $"ribbon wear {wear:F3}, core-terrain {core - drawn:F3}, "
                                  + $"lane {(roads != null && roads.Model != null && roads.Model.LaneAt(at.x, at.z, 8.6f).HasValue ? roads.Model.LaneAt(at.x, at.z, 8.6f).Value.ToString() : "none")} "
                                  + $"| local extents {e.x:F3},{e.y:F3},{e.z:F3} "
                                  + $"-> axle {axle}, local radius {localR:F3}, "
                                  + $"moving {BlwpCore.TruckSpeed:F1} m/s "
                                  // THE TWO CRATER COUNTS. `restart` carries
                                  // craters into the next round one round
                                  // older, and the mesh reveals one only after
                                  // `craterRevealDelay`. If the core is holding
                                  // more holes than the terrain has drawn, the
                                  // truck is standing in one that is not there
                                  // to look at - which is the shape of "after
                                  // round one or two, in the depot".
                                  + $"| craters core {BlwpCore.CraterCount}, "
                                  + $"drawn {(terrain != null ? terrain.DrawnCraters.Count : -1)}");
                    }
                }
            }
            if (Time.time > _nextSeatingSay) _nextSeatingSay = Time.time + 2f;
        }

        /// <summary>
        /// Gives the core the relief the game is drawing.
        ///
        /// Re-sent when the terrain rebuilds, because the ground comes from a
        /// live fetch and changes under us: a core still holding the flat
        /// placeholder from before the first fetch would drive a hillside as
        /// though it were a table, which is exactly the bug this exists to fix.
        /// </summary>
        // UploadGround IS GONE. It sent `MempoolTerrain.HeightGrid` into the
        // core every second, and the core felt those hills while every
        // committee replaying the drive stepped a flat table. The relief is the
        // round's now, made by the core from its seed, and this side draws it.

        // UploadSolids IS GONE. It gathered every BoxCollider in the scene
        // once a second and sent the lot, so the world the core resolved
        // against changed as models streamed in and no replay had any of it.



        void Update()
        {
            if (ShouldStop(Driving, BlwpNet.Ended)) { StopDriving(BlwpNet.Ending()); return; }
            if (!Driving) return;

            // A fixed step, caught up in whole ticks. Rendering interpolates
            // between them; the simulation never sees a partial one.
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
        bool Locked => LocksControls(_truck != null && _truck.controlsLocked, BlwpNet.Ended);

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
        /// one, the bare surface where there is not.
        ///
        /// THE SURFACE COMES FROM THE CORE. `surfaceAt` is the one function that
        /// says what the ground is, and it is the relief LESS the craters.
        /// Unity's terrain is the relief alone: `MempoolTerrain` draws the hills
        /// the round started with and has never heard of a strike, so a truck
        /// seated on `SampleSurface` stood on a lid over its own hole and hovered
        /// by the crater's full depth - 6.00 m at the deepest.
        ///
        /// THE LIFT STAYS HERE. The deck is laid above the ground by a constant
        /// the core does not simulate, so it is added on top of whatever the
        /// surface is rather than folded into it. Wheels placed on the bare
        /// surface sank into the road by exactly that lift; RoadNetwork carries
        /// the same warning, having been caught by it before.
        ///
        /// Unity's terrain remains the fallback for the Editor, where there is
        /// no core at all, and for the frames before the relief is uploaded.
        /// </summary>
        /// <summary>The axles, from Bootstrap. One copy, because two drift.</summary>
        public const float HalfWheelbase = 2.0f;
        public const float HalfTrack = 1.15f;

        /// <summary>
        /// The four points a truck of this shape stands on at a pose.
        /// </summary>
        public void Contacts(float x, float z, float headingDegrees,
                             out float fl, out float fr, out float rl, out float rr)
        {
            var rot = Quaternion.Euler(0f, headingDegrees, 0f);
            Vector3 fwd = rot * Vector3.forward, right = rot * Vector3.right;
            fl = Ground(x + fwd.x * HalfWheelbase - right.x * HalfTrack,
                        z + fwd.z * HalfWheelbase - right.z * HalfTrack);
            fr = Ground(x + fwd.x * HalfWheelbase + right.x * HalfTrack,
                        z + fwd.z * HalfWheelbase + right.z * HalfTrack);
            rl = Ground(x - fwd.x * HalfWheelbase - right.x * HalfTrack,
                        z - fwd.z * HalfWheelbase - right.z * HalfTrack);
            rr = Ground(x - fwd.x * HalfWheelbase + right.x * HalfTrack,
                        z - fwd.z * HalfWheelbase + right.z * HalfTrack);
        }

        /// <summary>
        /// HOW HIGH A TRUCK OF THIS SHAPE SITS AT A POSE, AND THERE IS ONE RULE.
        ///
        /// `Apply` fits the body across its four contact points; the ghosts were
        /// seated on a SINGLE sample under their centre, which is the same
        /// number only on flat ground. Measured in PlayMode at one pose on this
        /// map: the local truck stood at y 6.840 and a ghost handed the local
        /// truck's own x, z and heading stood at 7.422 - 0.58 m apart, drawn
        /// from the same ground in the same frame. A picture of a truck that
        /// floats above the truck it pictures is a second seating rule, and two
        /// rules for one thing is how they drift.
        /// </summary>
        public float RideAt(float x, float z, float headingDegrees)
        {
            Contacts(x, z, headingDegrees, out float fl, out float fr, out float rl, out float rr);
            return (fl + fr + rl + rr) * 0.25f + _bodyAboveGround;
        }

        public float Ground(float x, float z)
        {
            if (roads != null) return roads.SurfaceHeight(x, z);
            if (BlwpCore.HasSurface) return BlwpCore.SurfaceAt(x, z);
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
            Contacts(x, z, heading, out float fl, out float fr, out float rl, out float rr);
            var lie = Lie(heading, fl, fr, rl, rr, HalfWheelbase, HalfTrack);

            // Eased, because the relief is sampled per frame and a truck on
            // springs does not snap to every pebble.
            _lie = Quaternion.Slerp(_lie, lie, 1f - Mathf.Exp(-8f * Time.deltaTime));

            float ride = (fl + fr + rl + rr) * 0.25f + _bodyAboveGround;
            LastSurface = (fl + fr + rl + rr) * 0.25f;
            LastGrade = ((fl + fr) - (rl + rr)) / (4f * HalfWheelbase);
            transform.SetPositionAndRotation(new Vector3(x, ride, z), _lie);

            // THE TRUCK'S OWN LOWEST POINT against the ground it stands on,
            // late in a run as well as early. `ride` is a plane fit plus a
            // body offset, so a model whose origin is not its base sinks -
            // the fault that put the dust skirt 23 m down and the mushroom's
            // stem 26 m down earlier in this letter. Read off the renderers,
            // not off the offset that was asked for.
            if (Time.time - _saidSeat > 4f)
            {
                _saidSeat = Time.time;
                var rs = GetComponentsInChildren<Renderer>();
                if (rs.Length > 0)
                {
                    var bb = rs[0].bounds;
                    for (int k = 1; k < rs.Length; k++) bb.Encapsulate(rs[k].bounds);
                    Debug.Log($"[seat] truck at tick {BlwpCore.Tick}: bottom "
                              + $"{(bb.min.y - LastSurface):+0.00;-0.00} m vs the ground, "
                              + $"ride {ride:F2}, surface {LastSurface:F2}, "
                              + $"body offset {_bodyAboveGround:F2}");
                }
            }

            if (_rb != null) _rb.position = transform.position;
            PoseWheels(BlwpCore.TruckSteerDegrees, BlwpCore.TruckSpeed, Time.deltaTime);
        }
    }
}
