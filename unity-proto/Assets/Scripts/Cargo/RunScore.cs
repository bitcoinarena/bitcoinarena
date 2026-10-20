// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// The run score, as specified in multiplayer_p2p.md section 18A.
///
/// This is here so the balance can be FELT before any of the multiplayer
/// machinery exists. The interesting part of section 18A is not the payout
/// plumbing, it is the claim that exposure has to be MULTIPLICATIVE: a run
/// that never goes near the fighting has to score near zero, or the cautious
/// player free-rides on everyone else's losses.
///
/// That claim is testable in single player today. Drive the map edge with a
/// full bed and watch the score stay in the low tens; drive the seam and watch
/// it reach four figures. If those two feel the same, the formula is wrong and
/// the spec is wrong with it.
///
///     score = 1000 * E * T * C
///
/// The score itself is deliberately NOT sats. Sats are the stake in the P2P
/// model, not the reward - the reward is a rank-weighted share of other
/// players' failures, which single player cannot show. Showing a score keeps
/// the HUD honest about that.
/// </summary>
public class RunScore : MonoBehaviour
{
    public Transform courier;
    public Battlefield field;
    public CargoBay bay;
    public TruckHealth health;
    public DeliveryGate gate;

    [Tooltip("How far from the frontline still counts as exposed, in metres. " +
             "Only used as a fallback when no army is in the scene.")]
    public float corridorHalfWidth = 46f;

    [Tooltip("A tank this close is pointing at you.")]
    public float armourRange = 46f;

    [Tooltip("Threat points for maximum danger: one per tank in range, 0.18 " +
             "per rifleman. Measured on the built map, the seam runs 7-13 and " +
             "the run-in to the gate about 2, so 10 keeps the scale readable " +
             "instead of saturating everywhere - at 5 almost the whole map " +
             "scored 1.00 and the number carried no information at all.")]
    public float threatForFull = 10f;

    // `exposureReference` is gone, and its tooltip with it. It was 190 - the
    // value a13 replaced with 320 in the core - and it was being multiplied
    // into a number that was already in the core's own units.

    [Tooltip("Par time for the run, in seconds. Faster than this scores above 1.")]
    public float referenceSeconds = 65f;

    [Tooltip("No exposure is earned within this distance of the spawn point, " +
             "however close the frontline drifts. The apron is safe ground.")]
    public float spawnFreeRadius = 22f;

    public TruckController truck;

    /// <summary>
    /// True when the truck is further down the map than it has ever been this
    /// run. Only then does exposure accrue.
    /// </summary>
    public bool MakingProgress { get; private set; }

    /// <summary>
    /// THE CORE IS THE AUTHORITY, AND THERE IS NO LONGER A SECOND ONE.
    ///
    /// This used to gate between the core and a C# formula that scored the run
    /// on its own. On the deploy path the C# half never ran - but in the
    /// editor the core is a stub, so it ALWAYS ran there, and four PlayMode
    /// tests were measuring Unity's arithmetic and calling it the score. The
    /// rules they carried - an empty bed collapses a built score, the apron
    /// banks nothing, a wreck banks nothing, the seam pays more than the quiet
    /// lane for the same ground - now live in `packages/nextblock/test`, where the
    /// core actually runs, each with a mutant that kills it.
    ///
    /// With no core answering these read zero, and that is the honest answer:
    /// no core, no score.
    /// </summary>
    static bool FromCore => Arena.ArenaCore.Available;

    /// <summary>E in the spec: 0..1, danger integrated over ground made good.</summary>
    ///
    /// Taken from the core when the core is driving. Two implementations of
    /// section 18A were running side by side - this one in C# and the core's
    /// own - and they were never going to agree: they integrate different
    /// danger, over different positions, at different rates. Whichever one the
    /// HUD happened to read was the score the player saw, and it was not the
    /// one the round would eventually be settled on.
    //
    // AND AS THE CORE'S FACTOR, NOT ITS METRES (2026-09-26): this was Clamp01 of the exposure in METRES - the fault the
    // arrival card had at 18:29 - so the HUD's DANGER meter read x1.00 past the first metre while the core's E was, on
    // the live run of round 14bff641, 0.31721. E is the exposure word over the 320 m reference on the core's 1e-5 grid.
    public float Exposure => CoreScoreFactors.Exposure(Arena.ArenaCore.ExposureWord);

    /// <summary>
    /// The instantaneous rate, unnormalised. Zero at the map edge, 1 on the
    /// seam with an empty bed, up to 2 on the seam under five stars. Drawn
    /// live so the player can see WHERE the score comes from, not just that
    /// it arrived.
    /// </summary>
    public float Rate { get; private set; }

    /// <summary>
    /// T in the spec, clamped to [0.25, 1.5].
    ///
    /// The floor used to be 0.5, which was not enough of a stick. Dawdling
    /// could triple the exposure term while only halving this one, so taking
    /// longer was worth doing. The round is timed anyway; this is where that
    /// clock is allowed to bite.
    /// </summary>
    public float TimeFactor =>
        _elapsed <= 0.01f ? 1.5f
                          : Mathf.Clamp(referenceSeconds / _elapsed, 0.25f, 1.5f);

    /// <summary>C in the spec: how full the bed is.</summary>
    public float CargoFactor => bay != null ? Mathf.Clamp01(bay.Fill) : 0f;

    /// <summary>What this run would score if it were delivered right now.</summary>
    public int Projected => Arena.ArenaCore.RunScore();

    /// <summary>Score of the last delivered run, for the breakdown card.</summary>
    public int LastScore { get; private set; }
    public float LastExposure { get; private set; }
    public float LastTime { get; private set; }
    public float LastCargo { get; private set; }

    /// <summary>Best delivered run this session.</summary>
    public int Best { get; private set; }

    /// <summary>Sum of delivered scores. The single player stand-in for a rank.</summary>
    public long Total { get; private set; }

    /// <summary>Seconds since the last delivery, for the breakdown card.</summary>
    public float SinceDelivery { get; private set; } = 999f;

    /// <summary>True once the truck has left the ramp with freight aboard.</summary>
    public bool Running { get; private set; }

    float _exposure, _elapsed;
    float _bestX = float.NegativeInfinity;

    void OnEnable()
    {
        if (gate != null) gate.Delivered += OnDelivered;
        if (health != null) health.Wrecked += Reset;
    }

    void OnDisable()
    {
        if (gate != null) gate.Delivered -= OnDelivered;
        if (health != null) health.Wrecked -= Reset;
    }

    void Update()
    {
        SinceDelivery += Time.unscaledDeltaTime;

        // A run is the stretch between leaving the ramp and arriving. Sitting
        // in the loading bay must not bank par time, and being dead must not
        // bank exposure.
        bool live = bay != null && bay.IsLoaded
                    && (health == null || (!health.IsDestroyed && !health.IsInvulnerable));

        if (!live)
        {
            Rate = 0f; Speed = 0f; _havePos = false;
            MakingProgress = false; Running = false;
            return;
        }

        Running = true;
        _elapsed += Time.deltaTime;

        // Measured before the rate, which reads it. The first frame of a run
        // has no previous position, and a respawn teleports - both would show
        // as an enormous speed, so the first sample is discarded.
        var here = courier != null ? courier.position : Vector3.zero;
        bool first = !_havePos;
        Speed = !first && Time.deltaTime > 0f
            ? Vector3.Distance(new Vector3(here.x, 0f, here.z),
                               new Vector3(_lastPos.x, 0f, _lastPos.z)) / Time.deltaTime
            : 0f;
        _lastPos = here;
        _havePos = true;

        // The high-water mark starts wherever the run starts. Left at negative
        // infinity it would score the first frame as infinite progress.
        if (first) { _bestX = here.x; MakingProgress = false; Rate = 0f; return; }

        // Exposure is integrated over GROUND MADE GOOD, not over time, and
        // only past the furthest point this run has reached.
        //
        // As a time integral it paid for presence, so once through the fighting
        // a player could circle in the corridor and keep earning. The round is
        // timed, but the time term alone could not price that out: circling
        // tripled the exposure term while only halving the time one. Against a
        // high-water mark, a lap earns exactly nothing - it covers no new
        // ground - and the clock keeps running while it happens.
        float x = here.x;
        float gained = x - _bestX;
        MakingProgress = gained > 0.0001f;

        if (FromCore)
        {
            // THE RATE COMES OUT OF THE CORE, not out of a second formula.
            //
            // `Exposure` above already reads the core, but `Rate` did not: it
            // called `RateNow`, which walks `army.Armour` and `army.Infantry`
            // - and with no C# army left that fell through to a geometry
            // fallback. So the meter on screen was drawn by a client formula
            // measuring a different danger from the one the round is settled
            // on. The core integrates `exposure += rate * gained`, so the rate
            // IS the exposure it gained per metre of new ground, and that is
            // read back rather than recomputed.
            // NO MULTIPLIER. `ArenaCore.Exposure` is the core's exposure word in
            // its own units - the live daily reads 94.63 of a 320 reference -
            // and this multiplied it by `exposureReference`, a C# constant
            // still carrying 190, the value the core replaced with 320 in a13.
            //
            // Measured on a drive: the core gains 0.255, then 1.386, then
            // 1.700 of exposure per metre - a real gradient inside the 0..2
            // band this meter is documented for. Times 190 that is 48, 263,
            // 323, and the clamp pinned it at 2.00 for the whole run. The
            // bright cap, the "cold" test and the stalled warning were all
            // reading a saturated constant.
            float now = Arena.ArenaCore.Exposure;
            Rate = RateFrom(now, _coreExposure, MakingProgress ? gained : 0f);
            _coreExposure = now;
            if (Rate > 0.0001f) LastLiveRate = Rate;
            if (MakingProgress) _bestX = x;
            return;
        }

        // NO SECOND OPINION. What used to be here integrated a C# threat over
        // C# positions into a C# exposure, and it ran in the editor every
        // time. The core is the only thing that scores a run now; with no core
        // answering, nothing accrues and the HUD says zero.
    }

    /// <summary>
    /// Exposure gained per metre of new ground, clamped to the band the meter
    /// is drawn in. Static and public so the UNITS can be pinned without a
    /// core: this is a difference of two core readings divided by a distance,
    /// and nothing scales it.
    /// </summary>
    public static float RateFrom(float now, float before, float gained) =>
        gained > 0.0001f ? Mathf.Clamp((now - before) / gained, 0f, 2f) : 0f;

    /// <summary>
    /// The last rate the core paid while the truck was gaining ground.
    ///
    /// Kept because "not earning" has two different causes and they need
    /// different advice: out of the corridor, or in it and driving in circles.
    /// The live `Rate` is zero in both, so the HUD used to tell them apart by
    /// calling `RateNow()` - a second C# threat model - and that is exactly
    /// what has been deleted. This is the core's own last warm reading.
    /// </summary>
    public float LastLiveRate { get; private set; }

    /// <summary>Last exposure read out of the core, for the rate above.</summary>
    float _coreExposure;

    // `RateNow()` and its threat model are gone. It walked the C# army - and
    // with no C# army left it fell through to a geometry fallback - to
    // recompute a danger the core already integrates. It multiplied by
    // `bay.Heat`, Unity's own copy of a rule the core owns, which made it a
    // second opinion about the two things this rebuild exists to move.
    // `ThreatAt` below is kept only for the editor gizmo that draws the
    // corridor; nothing scores from it.


    /// <summary>
    /// How dangerous this spot actually is: guns in range, not geometry.
    ///
    /// Distance to the frontline was the wrong measure and the finish straight
    /// proved it. The frontline is a curve defined across the whole map, so a
    /// truck on the empty run-in to the gate could sit right on it and be
    /// scored as though it were under fire - one player watched a score go
    /// from 100 to 300 over the last thirty metres, with nothing shooting at
    /// them. Counting what is actually in range cannot do that: no tanks, no
    /// danger, wherever the curve happens to run.
    /// </summary>
    public float ThreatAt(Vector3 p)
    {
        var army = field != null ? field.Army : null;
        if (army == null)
        {
            // No army in the scene at all - fall back to the old geometry so a
            // bare test harness still measures something.
            if (field == null) return 0f;
            float dz = Mathf.Abs(p.z - field.FrontlineZ(p.x));
            return 1f - Mathf.Clamp01(dz / Mathf.Max(1f, corridorHalfWidth));
        }

        float threat = 0f;
        float ar = armourRange * armourRange;
        foreach (var u in army.Armour)
        {
            float dx = u.x - p.x, dz2 = u.z - p.z;
            if (dx * dx + dz2 * dz2 < ar) threat += 1f;
        }

        // Infantry count for less each, but there are many more of them, and
        // driving through a firefight on foot should not read as empty road.
        float ir = Army.RifleRange * Army.RifleRange;
        foreach (var u in army.Infantry)
        {
            float dx = u.x - p.x, dz2 = u.z - p.z;
            if (dx * dx + dz2 * dz2 < ir) threat += 0.18f;
        }

        return Mathf.Clamp01(threat / Mathf.Max(0.01f, threatForFull));
    }

    /// <summary>Unnormalised threat, for tuning threatForFull.</summary>
    public float RawThreatAt(Vector3 p)
    {
        var army = field != null ? field.Army : null;
        if (army == null) return 0f;
        float threat = 0f, ar = armourRange * armourRange;
        foreach (var u in army.Armour)
        {
            float dx = u.x - p.x, dz = u.z - p.z;
            if (dx * dx + dz * dz < ar) threat += 1f;
        }
        float ir = Army.RifleRange * Army.RifleRange;
        foreach (var u in army.Infantry)
        {
            float dx = u.x - p.x, dz = u.z - p.z;
            if (dx * dx + dz * dz < ir) threat += 0.18f;
        }
        return threat;
    }

    /// <summary>
    /// Ground speed in m/s, measured as ground actually covered.
    ///
    /// Not Rigidbody.linearVelocity: the wheel colliders apply brake torque
    /// whenever the throttle is idle, so the body's velocity is zeroed every
    /// physics step and reading it reports a rolling truck as stationary.
    /// Distance between frames is what "hauling freight through a battle"
    /// actually means, and it does not care how the motion was produced.
    /// </summary>
    public float Speed { get; private set; }

    Vector3 _lastPos;
    bool _havePos;

    void OnDelivered(long _)
    {
        // THE CARD'S THREE FACTORS ARE THE CORE'S (the owner's playtest 2026-09-25 18:29: DELIVERED at tick 4596, SCORE +137,
        // and the card read "load 0.85 x danger 1.00 x speed 1.50 x 1000" - 1275). Those were Unity's own meters: danger
        // was Clamp01 of the raw exposure METRES (anything past 1 m printed 1.00), speed Unity's wall-clock cap, load
        // Unity's bed. The score is the core's (Projected), so its factors are read from the same words at the same moment
        // and formed as scoreOf forms them: E = exposure / 320 m, T = 1800 / ticks, C = the core's cargo word.
        if (Arena.ArenaCore.Available)
        {
            LastExposure = CoreScoreFactors.Exposure(Arena.ArenaCore.ExposureWord);
            LastTime = CoreScoreFactors.Time(Arena.ArenaCore.ElapsedTicks);
            LastCargo = CoreScoreFactors.Cargo(Arena.ArenaCore.CargoWord);
        }
        else
        {
            LastExposure = Exposure;
            LastTime = TimeFactor;
            LastCargo = CargoFactor;
        }
        // THE SCORE IS THE CORE'S OWN WORD (the arrival card, 2026-09-25: "S on the card is the S_DELIVERED integer
        // as-is"): measured, S_EXPOSURE, S_ELAPSED, S_CARGO and S_DELIVERED do not move after DELIVERED (72 runs, 600 ticks
        // each, throttle, idle and steering), so the words read here are the delivery tick's.
        LastScore = Arena.ArenaCore.Available ? Arena.ArenaCore.DeliveredScore : Projected;
        Total += LastScore;
        if (LastScore > Best) Best = LastScore;
        SinceDelivery = 0f;
        Reset();
    }

    /// <summary>A wreck banks nothing. The stake is gone, and so is the run.</summary>
    public void Reset()
    {
        _exposure = 0f;
        _elapsed = 0f;
        Rate = 0f;
        Speed = 0f;
        _havePos = false;
        MakingProgress = false;
        _bestX = float.NegativeInfinity;   // set on the first live frame
        Running = false;
    }
}

/// <summary>
/// THE CORE'S SCORE FACTORS, formed from its three score words exactly as packages/nextblock/src/rules/score.js's scoreOf forms
/// them - so their product, times 1000, is the core's score (to its rounding). Read by the arrival card; nothing here
/// scores. The constants are the core's, and packages/nextblock/test/arrival-card-factors.test.js fails if they drift.
/// </summary>
public static class CoreScoreFactors
{
    public const float ExposureReferenceMetres = 320f;   // score.js EXPOSURE_REFERENCE
    public const int ReferenceTicks = 1800;               // score.js REFERENCE_TICKS. T = 1 at 30 s.
    public const int TicksMin = 1200;                     // score.js T_TICKS_MIN. T stays 1.5 until 20 s, then sinks.
    public const int TicksMax = 7200;                     // score.js T_TICKS_MAX (T = 0.25 at 120 s)
    const float One = 65536f;                             // Q16.16

    // THE FACTORS ON THE CORE'S GRID (2026-09-25: "Their product is the score, so the core's score is that product"):
    // score.js forms each factor as an integer count of 1e-5 - exposure5, time5, cargo5 - rounded once, half up, and the
    // score as their product in 1e-5 points. These are the same integer rules, so the card prints the core's factors
    // exactly and does not round a factor of its own; nothing here scores.
    public const int FactorScale = 100000;               // score.js FACTOR_SCALE
    public const int ScoreScale = 100000;                // score.js SCORE_SCALE: the score is kept in 1e-5 points
    const long ReferenceWord = 320L * 65536;
    static long DivRound(long n, long d) => (2 * n + d) / (2 * d);          // n, d >= 0: score.js divRoundInt

    /// <summary>E, as score.js exposure5: the exposure word held to the 320 m reference, over it, in 1e-5.</summary>
    public static int Exposure5(int exposureWord) => (int)DivRound(System.Math.Min(System.Math.Max(exposureWord, 0L), ReferenceWord) * FactorScale, ReferenceWord);
    /// <summary>T, as score.js time5: 1800 over the elapsed ticks held to 1200..7200, in 1e-5.</summary>
    public static int Time5(int elapsedTicks) => (int)DivRound((long)ReferenceTicks * FactorScale, Mathf.Clamp(elapsedTicks, TicksMin, TicksMax));
    /// <summary>C, as score.js cargo5: the core's cargo word held to 0..ONE, over ONE, in 1e-5.</summary>
    public static int Cargo5(int cargoWord) => (int)DivRound(System.Math.Min(System.Math.Max(cargoWord, 0L), 65536L) * FactorScale, 65536L);

    /// <summary>E: the exposure word in metres over the 320 m reference, held to 0..1, on the core's 1e-5 grid.</summary>
    public static float Exposure(int exposureWord) => Exposure5(exposureWord) / (float)FactorScale;

    /// <summary>T: 1800 over the elapsed ticks, the ticks held to 1200..7200 (so T to 1.5..0.25), on the 1e-5 grid.</summary>
    public static float Time(int elapsedTicks) => Time5(elapsedTicks) / (float)FactorScale;

    /// <summary>C: the core's cargo word, held to 0..1, on the 1e-5 grid.</summary>
    public static float Cargo(int cargoWord) => Cargo5(cargoWord) / (float)FactorScale;

    /// <summary>A score in points as the core keeps it (1e-5 points), printed to its five decimals: 13715869 is "137.15869".</summary>
    public static string Points(long scoreUnits) =>
        (scoreUnits / (decimal)ScoreScale).ToString("#,0.00000", System.Globalization.CultureInfo.InvariantCulture);
}

