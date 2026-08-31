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
             "Beyond this the run earns nothing at all.")]
    public float corridorHalfWidth = 46f;

    [Tooltip("Seam-seconds for a full exposure score. A run spent entirely on " +
             "the frontline at zero heat reaches E = 1 after this long.")]
    public float exposureReference = 34f;

    [Tooltip("Par time for the run, in seconds. Faster than this scores above 1.")]
    public float referenceSeconds = 65f;

    [Tooltip("No exposure is earned within this distance of the spawn point, " +
             "however close the frontline drifts. The apron is safe ground.")]
    public float spawnFreeRadius = 22f;

    [Tooltip("Below this speed in m/s the run earns no exposure. Sitting in " +
             "the corridor is not the same as hauling freight through it.")]
    public float minSpeed = 2.5f;

    public TruckController truck;

    /// <summary>E in the spec: 0..1, how much of the corridor this run has eaten.</summary>
    public float Exposure => Mathf.Clamp01(_exposure / Mathf.Max(0.01f, exposureReference));

    /// <summary>
    /// The instantaneous rate, unnormalised. Zero at the map edge, 1 on the
    /// seam with an empty bed, up to 2 on the seam under five stars. Drawn
    /// live so the player can see WHERE the score comes from, not just that
    /// it arrived.
    /// </summary>
    public float Rate { get; private set; }

    /// <summary>T in the spec, clamped to [0.5, 1.5].</summary>
    public float TimeFactor =>
        _elapsed <= 0.01f ? 1.5f
                          : Mathf.Clamp(referenceSeconds / _elapsed, 0.5f, 1.5f);

    /// <summary>C in the spec: how full the bed is.</summary>
    public float CargoFactor => bay != null ? Mathf.Clamp01(bay.Fill) : 0f;

    /// <summary>What this run would score if it were delivered right now.</summary>
    public int Projected =>
        Mathf.RoundToInt(1000f * Exposure * TimeFactor * CargoFactor);

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

        if (!live) { Rate = 0f; Speed = 0f; _havePos = false; Running = false; return; }

        Running = true;
        _elapsed += Time.deltaTime;

        // Measured before the rate, which reads it. The first frame of a run
        // has no previous position, and a respawn teleports - both would show
        // as an enormous speed, so the first sample is discarded.
        var here = courier != null ? courier.position : Vector3.zero;
        Speed = _havePos && Time.deltaTime > 0f
            ? Vector3.Distance(new Vector3(here.x, 0f, here.z),
                               new Vector3(_lastPos.x, 0f, _lastPos.z)) / Time.deltaTime
            : 0f;
        _lastPos = here;
        _havePos = true;

        Rate = RateNow();
        _exposure += Rate * Time.deltaTime;
    }

    /// <summary>
    /// proximity * (1 + heat), straight out of section 18A.3.
    ///
    /// Heat multiplies rather than adds for the same reason exposure does in
    /// the score: a valuable load driven around the outside must not collect a
    /// risk bonus it never actually ran.
    /// </summary>
    public float RateNow()
    {
        if (courier == null || field == null) return 0f;
        var p = courier.position;

        // The apron earns nothing, whatever the tape does.
        //
        // The frontline moves with the price and sometimes drifts within a few
        // dozen metres of the spawn point. Standing there, freshly loaded and
        // still protected, then paid exposure for doing precisely nothing -
        // and once protection lifted it kept paying, because proximity does
        // not care whether you drove anywhere.
        if (truck != null &&
            Vector3.Distance(p, truck.spawnPosition) < spawnFreeRadius) return 0f;

        // Nor does parking in the corridor count. The score is for hauling
        // freight through a battle, not for idling in one: without this, the
        // best play is to stop on the seam and wait, which is neither driving
        // nor interesting.
        if (Speed < minSpeed) return 0f;

        float dz = Mathf.Abs(p.z - field.FrontlineZ(p.x));
        float proximity = 1f - Mathf.Clamp01(dz / Mathf.Max(1f, corridorHalfWidth));
        float heat = bay != null ? bay.Heat : 0f;
        return proximity * (1f + heat);
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
        LastExposure = Exposure;
        LastTime = TimeFactor;
        LastCargo = CargoFactor;
        LastScore = Projected;
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
        Running = false;
    }
}
