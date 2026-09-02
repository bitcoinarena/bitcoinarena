using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Blwp
{
    /// <summary>
    /// The deterministic core, as Unity sees it.
    ///
    /// In a WebGL build these calls cross into the JavaScript core through
    /// Assets/Plugins/WebGL/blwp.jslib. Everywhere else - the editor, play mode
    /// tests, a standalone build - there is no JavaScript, so the calls are
    /// stubbed and <see cref="Available"/> is false.
    ///
    /// That asymmetry is deliberate and is the reason this class exists at all.
    /// The alternative is a second C# implementation of the simulation, which
    /// would be a second implementation to keep in step, and the entire point
    /// of the core is that there is exactly one.
    /// </summary>
    public static class BlwpCore
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern int BlwpInit(int seed);
        [DllImport("__Internal")] private static extern int BlwpStep(int throttle, int steer, int brake, int handbrake, int practice);
        [DllImport("__Internal")] private static extern int BlwpReadState(IntPtr ptr, int wordCount);
        [DllImport("__Internal")] private static extern int BlwpStateHash(IntPtr ptr, int cap);
        [DllImport("__Internal")] private static extern int BlwpRunScore();
        [DllImport("__Internal")] private static extern int BlwpStateWords();
        [DllImport("__Internal")] private static extern int BlwpQueryParam(IntPtr name, IntPtr outp, int cap);
        [DllImport("__Internal")] private static extern int BlwpSetGround(IntPtr h, int cols, int rows);
        [DllImport("__Internal")] private static extern int BlwpSetSolids(IntPtr b, int count);
        [DllImport("__Internal")] private static extern int BlwpTeleport(int x, int z, int heading);
        [DllImport("__Internal")] private static extern int BlwpTakeImpact();
        public const bool Compiled = true;
#else
        private static int BlwpInit(int seed) => 0;
        private static int BlwpStep(int t, int s, int b, int h, int p) => 0;
        private static int BlwpReadState(IntPtr ptr, int wordCount) => 0;
        private static int BlwpStateHash(IntPtr ptr, int cap) => 0;
        private static int BlwpRunScore() => 0;
        private static int BlwpStateWords() => 0;
        private static int BlwpQueryParam(IntPtr n, IntPtr o, int cap) => 0;
        private static int BlwpSetGround(IntPtr h, int c, int r) => 0;
        private static int BlwpSetSolids(IntPtr b, int n) => 0;
        private static int BlwpTeleport(int x, int z, int h) => 0;
        private static int BlwpTakeImpact() => 0;
        public const bool Compiled = false;
#endif

        /// <summary>Q16.16: one metre, one second, one full turn of heading.</summary>
        public const int ONE = 65536;

        /// <summary>True once a core has been started and is answering.</summary>
        public static bool Available { get; private set; }

        /// <summary>
        /// The WHOLE state, `Layout.WORDS`, and not a formula that stops at
        /// the units.
        ///
        /// This was `O_UNITS + MAX_UNITS * U_WORDS`, which is 2073 - exactly
        /// `O_ARMY`, so the buffer ended where the replacement clocks, the air
        /// and the squads begin, and came up 108 words short of the core's
        /// 2181. `Init`'s own guard caught it and refused, which means
        /// `Available` was false in every browser build: the truck fell back
        /// to PhysX and nothing of M1 ever ran on a screen. No editor test
        /// could see it - `BlwpCore` is stubbed outside WebGL - and it took a
        /// headless browser against a real build to find.
        /// </summary>
        static int[] _state = new int[Layout.WORDS];

        /// <summary>The last state read, in words. Read-only by contract.</summary>
        public static int[] State => _state;

        public static bool Init(int seed)
        {
            Available = BlwpInit(seed) == 1;
            if (Available)
            {
                int words = BlwpStateWords();
                if (words > 0 && words != _state.Length)
                {
                    // The layout is generated from state.js, so a mismatch means
                    // the bundle and this build came from different commits -
                    // which would show up as a truck rendering from whatever
                    // word happens to sit where x used to be.
                    Debug.LogError($"[blwp] core reports {words} state words, this build expects " +
                                   $"{_state.Length}. Regenerate BlwpLayout.cs and rebuild the bundle.");
                    Available = false;
                }
            }
            return Available;
        }

        public static void Step(int throttle, int steer, int brake, int handbrake, int practice)
        {
            if (!Available) return;
            BlwpStep(throttle, steer, brake, handbrake, practice);
            Pull();
        }

        /// <summary>Set for any tick the run spent shielded. Part of the hash.</summary>
        public static bool WasPractice => _state[Layout.O_SCORE + Layout.S_PRACTICE] != 0;

        static void Pull()
        {
            var handle = GCHandle.Alloc(_state, GCHandleType.Pinned);
            try { BlwpReadState(handle.AddrOfPinnedObject(), _state.Length); }
            finally { handle.Free(); }
        }

        public static int RunScore() => Available ? BlwpRunScore() : 0;

        /// <summary>
        /// Hands the core the ground the game is drawing, in Q16.16 metres.
        ///
        /// Round setup, uploaded once: the core needs the slope under the
        /// truck to make a climb cost anything, and it must be THIS ground
        /// rather than ground of its own, or it would feel hills that are not
        /// on the screen.
        /// </summary>
        public static bool SetGround(int[] heights, int cols, int rows)
        {
            if (!Available || heights == null || heights.Length < cols * rows) return false;
            var pin = GCHandle.Alloc(heights, GCHandleType.Pinned);
            try { return BlwpSetGround(pin.AddrOfPinnedObject(), cols, rows) != 0; }
            finally { pin.Free(); }
        }

        /// <summary>
        /// The tanks the player can see, for this tick.
        ///
        /// The core simulates an army of its own, and for a while the truck
        /// was being kept out of THOSE - which are invisible. The tanks on
        /// screen belong to Unity's Battlefield, so the truck drove straight
        /// through everything visible while colliding perfectly with ghosts.
        /// Until the army itself moves into the core, its positions are input.

        /// <summary>
        /// Puts the truck back where it started, stationary.
        ///
        /// It has to go through the core because the core OWNS the position:
        /// TruckController.Respawn set the Transform and the Rigidbody and the
        /// core overwrote both on the very next frame, so a missed block left
        /// the player standing at the miner, unable to load anything, with the
        /// bay eighty metres away.
        /// </summary>
        public static bool Teleport(Vector3 at, float headingDegrees)
        {
            if (!Available) return false;
            int h = Mathf.RoundToInt(Mathf.Repeat(headingDegrees, 360f) * 65536f / 360f) & 0xFFFF;
            return BlwpTeleport(Mathf.RoundToInt(at.x * ONE),
                                Mathf.RoundToInt(at.z * ONE), h) != 0;
        }

        /// <summary>
        /// The hardest armour impact since this was last called, m/s.
        ///
        /// Reading clears it, so one crash is applied once. PhysX raised
        /// OnCollisionEnter for this and the body is kinematic now, so nothing
        /// fires - which is why a truck could be driven into a tank at speed
        /// and come away unmarked.
        /// </summary>
        public static float TakeImpact() => Available ? BlwpTakeImpact() / (float)ONE : 0f;

        /// <summary>The truck's velocity, in metres a second.</summary>
        public static Vector3 Velocity => new Vector3(
            Metres(_state[Layout.O_TRUCK + Layout.T_VX]), 0f,
            Metres(_state[Layout.O_TRUCK + Layout.T_VZ]));

        /// <summary>
        /// Hands the core the boxes the truck must not drive through.
        ///
        /// Six words each: centre x and z, half extents x and z, and the
        /// vertical span - the last so a doorway lintel is something to drive
        /// under rather than a wall across the door.
        /// </summary>
        public static bool SetSolids(int[] boxes, int count)
        {
            if (!Available || boxes == null || boxes.Length < count * 6) return false;
            var pin = GCHandle.Alloc(boxes, GCHandleType.Pinned);
            try { return BlwpSetSolids(pin.AddrOfPinnedObject(), count) != 0; }
            finally { pin.Free(); }
        }

        /// <summary>
        /// A query parameter from the page URL, or null outside a browser.
        ///
        /// Deliberately not gated on Available: settings have to be readable
        /// before a core exists, and in the editor there is no page at all -
        /// which is a null, not an error.
        /// </summary>
        public static string QueryParam(string name)
        {
            if (!Compiled) return null;
            var nameBytes = System.Text.Encoding.ASCII.GetBytes(name + "\0");
            var outBytes = new byte[256];
            var nh = GCHandle.Alloc(nameBytes, GCHandleType.Pinned);
            var oh = GCHandle.Alloc(outBytes, GCHandleType.Pinned);
            try
            {
                int n = BlwpQueryParam(nh.AddrOfPinnedObject(), oh.AddrOfPinnedObject(), outBytes.Length);
                return n > 0 ? System.Text.Encoding.ASCII.GetString(outBytes, 0, n) : null;
            }
            finally { nh.Free(); oh.Free(); }
        }

        public static string StateHash()
        {
            if (!Available) return null;
            var bytes = new byte[65];
            var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                int n = BlwpStateHash(handle.AddrOfPinnedObject(), bytes.Length);
                return n > 0 ? System.Text.Encoding.ASCII.GetString(bytes, 0, n) : null;
            }
            finally { handle.Free(); }
        }

        // ---- typed reads, so nothing outside this file indexes by word ------

        public static float Metres(int word) => word / (float)ONE;

        /// <summary>Heading in DEGREES. The core keeps turns; Unity wants degrees.</summary>
        public static float Degrees(int turns) => (turns & 0xFFFF) * 360f / 65536f;

        public static Vector3 TruckPosition(float y) => new Vector3(
            Metres(_state[Layout.O_TRUCK + Layout.T_X]), y,
            Metres(_state[Layout.O_TRUCK + Layout.T_Z]));

        public static float TruckHeading => Degrees(_state[Layout.O_TRUCK + Layout.T_HEADING]);

        /// <summary>
        /// Front wheel angle in degrees, signed.
        ///
        /// Not Degrees(): that masks to 16 bits because a heading wraps, and a
        /// steer angle does not - it goes negative, and masking turns a small
        /// left lock into 328 degrees of right.
        /// </summary>
        public static float TruckSteerDegrees =>
            _state[Layout.O_TRUCK + Layout.T_STEER] * 360f / 65536f;
        public static float TruckHealth => Metres(_state[Layout.O_TRUCK + Layout.T_HP]);
        public static float TruckSpeed => Metres(_state[Layout.O_TRUCK + Layout.T_WHEEL]);
        public static int Tick => _state[Layout.O_TICK];
        public static int RunState => _state[Layout.O_SCORE + Layout.S_STATE];
        public static float Exposure => Metres(_state[Layout.O_SCORE + Layout.S_EXPOSURE]);

        public static Vector3 UnitPosition(int i, float y)
        {
            int b = Layout.UnitBase(i);
            return new Vector3(Metres(_state[b + Layout.U_X]), y, Metres(_state[b + Layout.U_Z]));
        }

        public static float UnitHealth(int i) => Metres(_state[Layout.UnitBase(i) + Layout.U_HP]);

        /// <summary>
        /// The rest of what a drawer needs to put a unit on the screen.
        ///
        /// Every one of these reads the SAME buffer the simulation writes, and
        /// every constant behind them - `UNITS`, `ARMOUR_MASK`, the field
        /// offsets - comes out of the generated `Layout`. Nothing here restates
        /// a rule: `(i &amp; ARMOUR_MASK) == 0` is the core's own expression,
        /// mirrored rather than retyped, because two descriptions of one buffer
        /// do not throw when they disagree - the tank simply renders as a man.
        ///
        /// `UnitAlive` is `U_STATE`, not `U_HP`. The core is of two minds about
        /// which one means alive - the firing code guards on hit points while
        /// `reinforce` and the crowding scan skip on the state word - and a
        /// drawer wants the one that says "this slot is occupied".
        /// </summary>
        public static int UnitSide(int i) => _state[Layout.UnitBase(i) + Layout.U_SIDE];

        public static bool UnitAlive(int i) => _state[Layout.UnitBase(i) + Layout.U_STATE] != 0;

        public static bool UnitIsArmour(int i) => (i & Layout.ARMOUR_MASK) == 0;

        public static float UnitHeading(int i) =>
            Degrees(_state[Layout.UnitBase(i) + Layout.U_HEADING]);

        /// <summary>
        /// The air, on the same terms. Bombs map word for word; a helicopter
        /// does not, and the difference is named rather than papered over: the
        /// core carries `H_DIR`, the way it is flying, and has no yaw and no
        /// bank. Those are the renderer's own - a gunship faces along the
        /// corridor it is crossing and banks for the look of it - so they are
        /// derived on this side and no simulation is invented to supply them.
        /// </summary>
        public static bool HeliAlive(int i) => _state[Layout.HeliBase(i) + Layout.H_STATE] != 0;

        public static int HeliSide(int i) => _state[Layout.HeliBase(i) + Layout.H_SIDE];

        public static int HeliDir(int i) => _state[Layout.HeliBase(i) + Layout.H_DIR];

        public static Vector3 HeliPosition(int i)
        {
            int b = Layout.HeliBase(i);
            return new Vector3(Metres(_state[b + Layout.H_X]),
                               Metres(_state[b + Layout.H_Y]),
                               Metres(_state[b + Layout.H_Z]));
        }

        public static bool BombAlive(int i) => _state[Layout.BombBase(i) + Layout.B_STATE] != 0;

        public static Vector3 BombPosition(int i)
        {
            int b = Layout.BombBase(i);
            return new Vector3(Metres(_state[b + Layout.B_X]),
                               Metres(_state[b + Layout.B_Y]),
                               Metres(_state[b + Layout.B_Z]));
        }

        public static Vector3 BombVelocity(int i)
        {
            int b = Layout.BombBase(i);
            return new Vector3(Metres(_state[b + Layout.B_VX]),
                               Metres(_state[b + Layout.B_VY]),
                               Metres(_state[b + Layout.B_VZ]));
        }
    }
}
