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
        public const bool Compiled = false;
#endif

        /// <summary>Q16.16: one metre, one second, one full turn of heading.</summary>
        public const int ONE = 65536;

        /// <summary>True once a core has been started and is answering.</summary>
        public static bool Available { get; private set; }

        static int[] _state = new int[Layout.O_UNITS + Layout.MAX_UNITS * Layout.U_WORDS];

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
    }
}
