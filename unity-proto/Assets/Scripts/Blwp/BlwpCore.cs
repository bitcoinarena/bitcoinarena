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
        [DllImport("__Internal")] private static extern int BlwpFrontlineZ(int x);
        [DllImport("__Internal")] private static extern int BlwpSurfaceAt(int x, int z);
        [DllImport("__Internal")] private static extern int BlwpLiquidation(int size);
        [DllImport("__Internal")] private static extern int BlwpRunScore();
        [DllImport("__Internal")] private static extern int BlwpStateWords();
        [DllImport("__Internal")] private static extern int BlwpQueryParam(IntPtr name, IntPtr outp, int cap);
        [DllImport("__Internal")] private static extern int BlwpRestart(int seed);
        [DllImport("__Internal")] private static extern int BlwpTeleport(int x, int z, int heading);
        [DllImport("__Internal")] private static extern int BlwpTakeImpact();
        [DllImport("__Internal")] private static extern int BlwpSubmitLoad(int feeSats, int btcHundredths);
        public const bool Compiled = true;
#else
        private static int BlwpInit(int seed) => 0;
        private static int BlwpStep(int t, int s, int b, int h, int p) => 0;
        private static int BlwpReadState(IntPtr ptr, int wordCount) => 0;
        private static int BlwpStateHash(IntPtr ptr, int cap) => 0;
        private static int BlwpFrontlineZ(int x) => 0;
        private static int BlwpSurfaceAt(int x, int z) => 0;
        private static int BlwpLiquidation(int size) => 0;
        private static int BlwpRunScore() => 0;
        private static int BlwpStateWords() => 0;
        private static int BlwpQueryParam(IntPtr n, IntPtr o, int cap) => 0;
        private static int BlwpRestart(int seed) => 0;
        private static int BlwpTeleport(int x, int z, int h) => 0;
        private static int BlwpTakeImpact() => 0;
        private static int BlwpSubmitLoad(int f, int b) => 0;
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
            // A fresh core is a flat one until somebody uploads the relief.
            HasRelief = false;
            Available = BlwpInit(seed) == 1;
            // A CORE ALWAYS HAS A RELIEF NOW. `HasRelief` used to mean "a host
            // has uploaded one" and was false until it did; `init` makes the
            // round's own, so the surface is worth asking about the moment the
            // core is up - which is what the truck and the terrain draw from.
            if (Available) HasRelief = true;
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

        /// <summary>
        /// Starts a new round in the core.
        ///
        /// `Init` runs once, in Start. Every ending - delivered, written off,
        /// block missed - went through `TruckController.Respawn`, which moves
        /// the truck and clears its momentum and touches no score word at all,
        /// and `outcome` latches: once a run leaves RUN_LIVE nothing brings it
        /// back. Read out of a live browser, round two began with twelve of
        /// thirty words still holding round one, `S_STATE` 0 -> 1 among them,
        /// and RUN_LIVE gates damage, danger, delivery and score. The second
        /// round of a session was unplayable and looked perfectly normal.
        ///
        /// The reset is the core's own `init`, reached the same way the first
        /// one was. Nothing here writes a state word: a host that clears
        /// `S_STATE` and `T_HP` itself is simulating, and would have to keep
        /// its own list of everything a round dirties.
        /// </summary>
        public static bool Restart(int seed)
        {
            if (!Available) return false;
            return BlwpRestart(seed) == 1;
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

        // SetGround IS GONE. It was the host's door - Unity uploaded the relief
        // it was drawing and the core felt those hills, while every committee
        // replaying the same drive stepped a flat table. Letter 36: the relief
        // is the round's, generated by the core from its seed, so there is
        // nothing to upload and no way for a page to put its player in a world
        // no committee can reproduce.


        /// <summary>True once the core has actually taken the relief.</summary>
        public static bool HasRelief { get; private set; }

        /// <summary>
        /// True when <see cref="SurfaceAt"/> is worth asking: a core is
        /// answering, and it always holds the round's hills once it is.
        ///
        /// Both halves matter. In the Editor there is no core at all and the
        /// terrain is the only answer there is; in a browser build the core
        /// starts flat and only learns the hills when the first upload lands,
        /// so between Start and that upload it would put everything at sea
        /// level. Whoever draws the ground asks this before believing it.
        /// </summary>
        public static bool HasSurface => Available && HasRelief;

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

        /// <summary>
        /// WHAT WENT ON THE BED, handed to the core at roll-out.
        ///
        /// This was `SetHeat(float)` and it sent the ANSWER: `CargoBay.Heat`
        /// worked the wanted level out in floats on this side and wrote it in.
        /// Two faults in one call. The rule was in two places - the core has
        /// carried the same rule in integers since the port, with no caller -
        /// and a host write is in no batch, no mark and no transcript, so the
        /// page's core carried 57229 while every replay of the same transcript
        /// carried 0.
        ///
        /// The LOAD crosses now: the sats aboard and hundredths of a BTC, two
        /// integers this side honestly knows. The core decides what they cost
        /// and the bridge publishes them, so a committee replaying the run -
        /// and every ghost drawn off one - is hunted exactly as the player was.
        /// </summary>
        public static bool SubmitLoad(long feeSats, int btcHundredths)
        {
            if (!Available) return false;
            // Clamped in whole integers, not through a float: a bed cannot
            // carry a negative fee, and int.MaxValue does not survive a round
            // trip through `float`. The core caps it at 20,000 sats anyway -
            // this only keeps the word from wrapping on the way there.
            long fee = feeSats < 0L ? 0L
                     : (feeSats > int.MaxValue ? int.MaxValue : feeSats);
            return BlwpSubmitLoad((int)fee, btcHundredths < 0 ? 0 : btcHundredths) == 1;
        }

        /// <summary>
        /// How hard the war is hunting this load, 0..1, READ BACK from the
        /// core rather than remembered on this side.
        ///
        /// The stars are drawn from this. Unity hands over the LOAD at roll-out
        /// and never the wanted level, so the picture reads the same word the
        /// shooting reads - otherwise the overlay is a second opinion about the
        /// thing it is reporting, and the two drift the first time one of the
        /// rules changes.
        /// </summary>
        public static float Heat => Metres(_state[Layout.O_SCORE + Layout.S_HEAT]);

        /// <summary>The truck's velocity, in metres a second.</summary>
        public static Vector3 Velocity => new Vector3(
            Metres(_state[Layout.O_TRUCK + Layout.T_VX]), 0f,
            Metres(_state[Layout.O_TRUCK + Layout.T_VZ]));

        // SetSolids IS GONE. The map's collision boxes are the core's, made
        // from the map's own geometry and the relief it generated, so a host
        // that could replace them would put its player among walls no
        // committee has.


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

        /// <summary>
        /// Where the front line runs at a world x, in metres.
        ///
        /// The core smooths the price tape before laying it across the map;
        /// `PriceHistory.FrontlineZ` does not, and cannot be made to without a
        /// second copy of the rule that would drift. Measured over five tapes,
        /// the smoothed line and the raw one are 22.04 m apart on average and
        /// 49.14 m at worst - at x=68 the core has the front at -8.3 m and the
        /// raw function at -57.4. So whoever DRAWS the front asks the core.
        /// </summary>
        /// <summary>
        /// Queues a liquidation for the core's next tick. `usd` is the dollar
        /// value of the forced order, as `MarketFeed.Liquidation.UsdValue`
        /// carries it.
        ///
        /// UNITS. The core takes MILLIONS of dollars in Q16.16, because a
        /// liquidation is worth six to nine figures and dollars in Q16.16
        /// overflow a signed word at $32,768. In millions the same word holds
        /// $32 billion at a resolution of $15.26. The conversion is done in
        /// `double` on purpose: a float loses the low digits of a nine-figure
        /// number before the scaling ever happens.
        ///
        /// The live feed and the simulation clock both call this, and that is
        /// the whole reason they cannot drift: the core sees one input, not
        /// two sources.
        /// </summary>
        public static bool Liquidation(double usd)
        {
            if (!Available || !(usd > 0)) return false;
            return BlwpLiquidation(Scale(usd)) != 0;
        }

        /// <summary>
        /// The size AS THE CORE WILL SEE IT: millions of USD in Q16.16, floored
        /// at one step and clamped at `LIQ_MAX`.
        ///
        /// Its own function because two things have to agree on it. The core
        /// compares scaled words when it decides which pending liquidation to
        /// keep; anything that mirrors that decision has to compare the same
        /// words, or the two disagree inside one step. One step is $15.26:
        /// $5,000,000 and $5,000,005 are the SAME size to the core, which then
        /// keeps the first of them, while a comparison in raw dollars would
        /// keep the second - the crater sized by one liquidation and the skin
        /// belonging to the other, which is the whole fault a10 is about.
        /// Everything under $15.26 is one step as well, so a $5 and a $10
        /// forced order are a tie and not an ordering.
        ///
        /// It is also the only part of the bridge that can be read back outside
        /// a WebGL player: `Liquidation` itself goes through a stub there.
        /// </summary>
        public static int Scale(double usd)
        {
            if (!(usd > 0)) return 0;
            double scaled = System.Math.Round(usd / 1e6 * ONE);
            if (scaled < 1) scaled = 1;                 // $15 or less still lands
            if (scaled > Layout.LIQ_MAX) scaled = Layout.LIQ_MAX;
            return (int)scaled;
        }

        /// <summary>The liquidation the core consumed on its last tick, in millions of USD.</summary>
        public static float LastLiquidation =>
            _state[Layout.O_LIQ + Layout.L_LAST] / (float)ONE;

        /// <summary>How many liquidation craters are open.</summary>
        public static int CraterCount
        {
            get
            {
                int n = 0;
                for (int i = 0; i < Layout.MAX_CRATERS; i++)
                {
                    int b = Layout.O_CRATERS + i * Layout.C_WORDS;
                    if (_state[b + Layout.C_R] > 0 && _state[b + Layout.C_ROUNDS] > 0) n++;
                }
                return n;
            }
        }

        /// <summary>Crater `i` of the open ones, in metres. -1 radius if there is none.</summary>
        public static bool CraterAt(int nth, float y, out Vector3 where, out float radius)
        {
            int n = 0;
            for (int i = 0; i < Layout.MAX_CRATERS; i++)
            {
                int b = Layout.O_CRATERS + i * Layout.C_WORDS;
                if (_state[b + Layout.C_R] <= 0 || _state[b + Layout.C_ROUNDS] <= 0) continue;
                if (n++ != nth) continue;
                where = new Vector3(Metres(_state[b + Layout.C_X]), y, Metres(_state[b + Layout.C_Z]));
                radius = Metres(_state[b + Layout.C_R]);
                return true;
            }
            where = Vector3.zero; radius = 0f;
            return false;
        }

        /// <summary>
        /// Is this point inside an open crater - the question the warning asks.
        ///
        /// A distance against the core's OWN radius, which is the same test the
        /// core makes before it applies a dose. It is not a second bowl: the
        /// falloff, the rate and the dose all stay in `packages/core`, and
        /// nothing here computes damage. The renderer is asking where the hole
        /// is, not how much it hurts.
        /// </summary>
        public static bool Irradiated(float x, float z)
        {
            for (int i = 0; i < Layout.MAX_CRATERS; i++)
            {
                int b = Layout.O_CRATERS + i * Layout.C_WORDS;
                float r = Metres(_state[b + Layout.C_R]);
                if (r <= 0f || _state[b + Layout.C_ROUNDS] <= 0) continue;
                float dx = x - Metres(_state[b + Layout.C_X]);
                float dz = z - Metres(_state[b + Layout.C_Z]);
                if (dx * dx + dz * dz < r * r) return true;
            }
            return false;
        }

        /// <summary>True while a liquidation strike is armed this tick.</summary>
        public static bool StrikeArmed => _state[Layout.O_STRIKE + Layout.K_STATE] != 0;

        /// <summary>Where the strike landed, in metres. Only meaningful while armed.</summary>
        public static Vector3 StrikeAt(float y) => new Vector3(
            Metres(_state[Layout.O_STRIKE + Layout.K_X]), y,
            Metres(_state[Layout.O_STRIKE + Layout.K_Z]));

        /// <summary>The load that armed it, in millions of USD.</summary>
        public static float StrikeLoad => Metres(_state[Layout.O_STRIKE + Layout.K_LOAD]);

        /// <summary>How many strikes the core has made this run.</summary>
        public static int StrikeCount => _state[Layout.O_STRIKE + Layout.K_SERIAL];

        /// <summary>How many liquidations the core has accepted this run.</summary>
        public static int LiquidationCount => _state[Layout.O_LIQ + Layout.L_SERIAL];

        public static float FrontlineZ(float x) =>
            Available ? BlwpFrontlineZ(Mathf.RoundToInt(x * ONE)) / (float)ONE : 0f;

        /// <summary>
        /// The surface at a world point, in metres: the relief the host handed
        /// over, LESS what the craters have taken out of it.
        ///
        /// The core already answers this for its own physics - `surfaceAt` in
        /// sim.js is the one place that says what the ground is - and this is
        /// that same function read back, not a second copy of it. Unity's
        /// terrain cannot be made to agree: `MempoolTerrain` draws the relief
        /// as it was before the strike and has never heard of a crater, so a
        /// truck resting on `SampleSurface` hovered over its own hole by the
        /// crater's full depth, measured at up to 6.00 m.
        ///
        /// This is the BARE surface. A road deck is laid a constant lift above
        /// it, and that lift belongs to whoever draws the deck - see
        /// `RoadNetwork.Lift`. Folding it in here would make the core the
        /// author of a thing it does not simulate.
        /// </summary>
        public static float SurfaceAt(float x, float z) =>
            Available ? BlwpSurfaceAt(Mathf.RoundToInt(x * ONE),
                                      Mathf.RoundToInt(z * ONE)) / (float)ONE : 0f;

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

        /// <summary>
        /// How fast the truck is moving SIDEWAYS, in m/s across its own nose.
        ///
        /// The core already works this out every tick and does not keep it.
        /// `rules/vehicle.js:147-152` decomposes the velocity into the chassis
        /// frame to spend the friction circle on it:
        ///
        ///     const fx = sin(v.heading), fz = cos(v.heading);
        ///     const rx = fz, rz = neg(fx);            // right-hand normal
        ///     let across = add(mulFast(v.vx, rx), mulFast(v.vz, rz));
        ///
        /// so this is that projection, taken from the words the core does
        /// publish - `T_VX`, `T_VZ` and `T_HEADING` - rather than a sketch of
        /// what sideways ought to mean. The axes are the file's: right is
        /// (cos h, -sin h), NOT (sin h, cos h) rotated the other way, and
        /// getting that backwards would report a corner as a straight line.
        ///
        /// It reads the velocity AFTER the step, so the lateral grip has
        /// already been spent on it - the slip the truck actually ends the
        /// tick with, which is the same instant PhysX's `linearVelocity` was
        /// read at. A speed, in m/s. Not a distance, not a per-tick step.
        /// </summary>
        public static float TruckSlip
        {
            get
            {
                float h = TruckHeading * Mathf.Deg2Rad;
                float vx = Metres(_state[Layout.O_TRUCK + Layout.T_VX]);
                float vz = Metres(_state[Layout.O_TRUCK + Layout.T_VZ]);
                return Mathf.Abs(vx * Mathf.Cos(h) - vz * Mathf.Sin(h));
            }
        }
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

        /// <summary>
        /// The unit's reload counter, in ticks, whichever word holds it.
        ///
        /// A tank's lives in `U_TARGET` and a rifleman's in `U_COOLDOWN` -
        /// the words are shared, because a rifleman has no reload to keep and
        /// a tank has no squad. Both count DOWN, so a rise is a shot: 84 to
        /// 191 ticks for a tank, 150 to 269 for a rifleman, against the 24 to
        /// 65 a rifleman sets when he looks and finds nobody.
        /// </summary>
        public static int UnitReloadClock(int i) => UnitIsArmour(i)
            ? _state[Layout.UnitBase(i) + Layout.U_TARGET]
            : _state[Layout.UnitBase(i) + Layout.U_COOLDOWN];

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
