using UnityEngine;

/// <summary>
/// Damage, destruction and respawn for the player's truck.
///
/// The truck is a neutral supply van in the middle of a firefight, so both
/// sides shoot at it once it comes close - the same rule the three.js version
/// used. Ramming armour writes it off outright: a van against a main battle
/// tank is not a contest.
///
/// Destruction reuses what the tanks already do - the same explosion and the
/// same burning hull - rather than growing a second wreck system beside it.
/// </summary>
[RequireComponent(typeof(Rigidbody))]
public class TruckHealth : MonoBehaviour
{
    [Header("Condition")]
    public float maxHealth = 100f;

    [Tooltip("Incoming damage is divided by this. The van is soft but not paper.")]
    public float armour = 1.5f;

    [Header("Destruction")]
    [Tooltip("Seconds burning before it is back on the apron.")]
    public float respawnSeconds = 5f;

    [Tooltip("Impact speed against armour at or above which the truck is " +
             "written off. Below it the crash only costs condition, so that " +
             "nudging a hull while parked is not instantly fatal.")]
    public float crashSpeed = 4f;

    [Header("Spawn protection")]
    [Tooltip("How far the truck has to get from the spawn before it can be " +
             "hurt. Without this a truck destroyed on the apron respawns into " +
             "whatever killed it and dies again on a loop.")]
    public float safeRadius = 8f;

    [Header("Wiring")]
    public TruckController truck;
    public CombatFx fx;

    [Tooltip("Optional. Gets thrown about on impacts, so a collision reads " +
             "as one instead of as the game not having noticed.")]
    public ChaseCamera chase;

    [Tooltip("Optional. Impacts and the explosion.")]
    public GameAudio audio;

    /// <summary>Condition remaining, 0..maxHealth.</summary>
    public float Health { get; private set; } = -1f;

    /// <summary>Condition as 0..1, for a bar.</summary>
    public float Fraction => maxHealth > 0f ? Mathf.Clamp01(Health / maxHealth) : 0f;

    public bool IsDestroyed => _burningFor >= 0f;

    /// <summary>
    /// When the last hit landed, on unscaled time. Drives the screen rim, so
    /// that being shot at cannot be mistaken for the battle going on nearby.
    /// </summary>
    public float LastHitAt { get; private set; } = -99f;

    /// <summary>Seconds until it is back, or 0 when it is not destroyed.</summary>
    public float RespawnIn => IsDestroyed ? Mathf.Max(0f, respawnSeconds - _burningFor) : 0f;

    /// <summary>
    /// True until the truck has driven clear of its spawn. Nothing can hurt it
    /// while it sits on the apron: dying there put it straight back into the
    /// thing that killed it, again and again.
    /// </summary>
    [Tooltip("The loading bay. While it is open the truck cannot be hurt, " +
             "whatever the battle does to it.")]
    public LoadoutPanel loadout;

    /// <summary>
    /// Nothing can hurt the truck while it is still on the apron.
    ///
    /// Distance from spawn is not enough on its own. The loading bay locks the
    /// controls but not the physics, so a tank blundering into the apron could
    /// shove the truck past the safe radius while the player was still reading
    /// the yard - protection then latched off and the run was over before it
    /// began, with no input from the player at all. An open bay therefore holds
    /// protection outright.
    /// </summary>
    public bool IsInvulnerable =>
        Blwp.PracticeMode.On || !_leftSpawn || (loadout != null && loadout.IsOpen);

    /// <summary>Raised when the truck is written off.</summary>
    public System.Action Wrecked;

    /// <summary>Raised when it is back on the apron, in one piece.</summary>
    public System.Action Respawned;

    float _burningFor = -1f;
    float _burnBeat;
    bool _leftSpawn;
    Rigidbody _rb;

    /// <summary>
    /// Deferred rather than done in Awake: Bootstrap assembles the truck in
    /// code, and AddComponent runs Awake before the body and the model exist.
    /// </summary>
    void EnsureInit()
    {
        if (Health >= 0f) return;
        Health = maxHealth;
        _rb = GetComponent<Rigidbody>();
        if (truck == null) truck = GetComponent<TruckController>();
        if (chase == null) chase = FindFirstObjectByType<ChaseCamera>();
        if (audio == null) audio = FindFirstObjectByType<GameAudio>();
    }

    void Start() => EnsureInit();

    /// <summary>Take a hit. Amount is before armour.</summary>
    public void Damage(float amount)
    {
        EnsureInit();
        if (IsDestroyed || IsInvulnerable || amount <= 0f) return;

        Health -= amount / Mathf.Max(0.01f, armour);
        LastHitAt = Time.unscaledTime;
        if (chase != null) chase.Shake(Mathf.Min(0.6f, amount * 0.02f));
        if (fx != null)
            fx.Flash(transform.position + Vector3.up * 1.4f, 1.6f);

        if (Health <= 0f) WriteOff();
    }

    /// <summary>Destroy it outright, whatever condition it was in.</summary>
    public void WriteOff()
    {
        EnsureInit();
        if (IsDestroyed || IsInvulnerable) return;

        Health = 0f;
        _burningFor = 0f;

        // The blast only. TankExplosion finishes by dropping a wreck model,
        // and that model is the tank - which turned the player's truck into a
        // tank the moment it died. The truck IS its own wreck: it stays where
        // it is, keeps its own body and burns there.
        if (fx != null) fx.VehicleExplosion(transform.position);
        if (chase != null) chase.Shake(2.2f);
        if (audio != null) audio.Explosion();

        if (truck != null) truck.enabled = false;
        if (_rb != null)
        {
            _rb.linearVelocity = Vector3.zero;
            _rb.angularVelocity = Vector3.zero;
            _rb.isKinematic = true;          // nothing can shove a wreck about
        }

        Wrecked?.Invoke();
    }

    float _smokeAt;

    void Update()
    {
        // Armour impacts come from the core now.
        //
        // OnCollisionEnter below still exists and still holds the rule, but it
        // cannot fire: the truck's Rigidbody is kinematic and the core writes
        // its transform, so PhysX resolves nothing and reports nothing. The
        // core notices the crash; the rule that decides what it costs stays
        // exactly where it was.
        float rammed = Blwp.BlwpCore.TakeImpact();
        if (rammed > 0.5f && !IsDestroyed && !IsInvulnerable)
        {
            if (chase != null) chase.Shake(Mathf.Min(1.2f, rammed * 0.09f));
            if (audio != null) audio.Impact(rammed);
            if (rammed >= crashSpeed) WriteOff();
            else Damage(rammed * 6f);
        }

        EnsureInit();

        // hand the condition to the controller, and smoke when it is bad
        if (truck != null) truck.condition = IsDestroyed ? 1f : Fraction;

        if (!IsDestroyed && fx != null && Fraction < 0.35f)
        {
            _smokeAt -= Time.deltaTime;
            if (_smokeAt <= 0f)
            {
                // faster the worse it is, so a dying truck is visible from behind
                _smokeAt = Mathf.Lerp(0.10f, 0.45f, Fraction / 0.35f);
                fx.BurnBeat(transform.position, Mathf.Clamp01(0.55f - Fraction));
            }
        }

        // Cleared once, on the way out. Checked as a distance rather than as a
        // "has moved at all" so that being nudged on the apron does not arm the
        // damage model while the truck is still standing in the traffic.
        // Being shoved off the apron with the bay open must not count as
        // leaving it: the player has not driven anywhere yet.
        if (loadout != null && loadout.IsOpen) _leftSpawn = false;
        else if (!_leftSpawn && truck != null &&
                 Vector3.Distance(transform.position, truck.spawnPosition) > safeRadius)
            _leftSpawn = true;

        if (!IsDestroyed) return;

        // UNSCALED: the death sequence puts the world in slow motion, and a
        // wait measured in scaled time would stretch with it - five seconds
        // would take fourteen.
        _burningFor += Time.unscaledDeltaTime;

        // burns where it stands, on the same beat and with the same fire as a
        // wrecked tank
        _burnBeat -= Time.unscaledDeltaTime;
        if (_burnBeat <= 0f && fx != null)
        {
            _burnBeat = 0.12f;
            float left = respawnSeconds > 0f ? _burningFor / respawnSeconds : 1f;
            fx.BurnBeat(transform.position, Mathf.Clamp01(1f - left * 0.55f));
        }

        if (_burningFor < respawnSeconds) return;

        _burningFor = -1f;
        Health = maxHealth;
        _leftSpawn = false;              // protected again until it drives off

        if (_rb != null) _rb.isKinematic = false;
        if (truck != null)
        {
            truck.enabled = true;
            truck.Respawn();
        }

        Respawned?.Invoke();
    }

    /// <summary>
    /// Hitting armour. Tanks and burning hulls both sit on the unit layer and
    /// both are several tonnes of steel; infantry carry no collider at all,
    /// because they are meant to be run over rather than crashed into.
    /// </summary>
    void OnCollisionEnter(Collision collision)
    {
        EnsureInit();
        if (IsDestroyed || IsInvulnerable) return;
        if (collision.gameObject.layer != ArmyRenderer.UnitLayer) return;

        // A burnt-out hull is scenery. Hitting one costs paint however hard it
        // is hit; only a live tank writes the truck off.
        if (collision.collider.GetComponentInParent<BurntOutHull>() != null)
        {
            if (chase != null)
                chase.Shake(Mathf.Min(0.9f, collision.relativeVelocity.magnitude * 0.06f));
            Damage(collision.relativeVelocity.magnitude * 3f);
            return;
        }

        float impact = collision.relativeVelocity.magnitude;
        if (chase != null) chase.Shake(Mathf.Min(1.2f, impact * 0.09f));
        if (audio != null) audio.Impact(impact);
        if (impact >= crashSpeed) WriteOff();
        else Damage(impact * 6f);       // a slow shunt still costs paint
    }
}
