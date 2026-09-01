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
            Debug.Log("[blwp] core is driving");
        }

        void OnDisable()
        {
            if (Driving && _rb != null) _rb.isKinematic = _wasKinematic;
            Driving = false;
        }

        void Update()
        {
            if (!Driving) return;

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
        }
    }
}
