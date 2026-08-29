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

    [Header("Wiring")]
    public TruckController truck;
    public CombatFx fx;

    /// <summary>Condition remaining, 0..maxHealth.</summary>
    public float Health { get; private set; } = -1f;

    /// <summary>Condition as 0..1, for a bar.</summary>
    public float Fraction => maxHealth > 0f ? Mathf.Clamp01(Health / maxHealth) : 0f;

    public bool IsDestroyed => _burningFor >= 0f;

    /// <summary>Seconds until it is back, or 0 when it is not destroyed.</summary>
    public float RespawnIn => IsDestroyed ? Mathf.Max(0f, respawnSeconds - _burningFor) : 0f;

    /// <summary>Raised when the truck is written off.</summary>
    public System.Action Wrecked;

    /// <summary>Raised when it is back on the apron, in one piece.</summary>
    public System.Action Respawned;

    float _burningFor = -1f;
    Renderer[] _skin;
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
    }

    void Start() => EnsureInit();

    /// <summary>Take a hit. Amount is before armour.</summary>
    public void Damage(float amount)
    {
        EnsureInit();
        if (IsDestroyed || amount <= 0f) return;

        Health -= amount / Mathf.Max(0.01f, armour);
        if (fx != null)
            fx.Flash(transform.position + Vector3.up * 1.4f, 1.6f);

        if (Health <= 0f) WriteOff();
    }

    /// <summary>Destroy it outright, whatever condition it was in.</summary>
    public void WriteOff()
    {
        EnsureInit();
        if (IsDestroyed) return;

        Health = 0f;
        _burningFor = 0f;

        float heading = transform.eulerAngles.y * Mathf.Deg2Rad;
        if (fx != null)
        {
            fx.TankExplosion(transform.position, heading);
            fx.Wreck(transform.position, heading);
        }

        // The burning hull IS the wreck effect, so the truck itself goes away
        // while it burns. Left visible there would be two trucks in the same
        // place, one of them driveable.
        _skin = GetComponentsInChildren<Renderer>(true);
        foreach (var r in _skin) r.enabled = false;

        if (truck != null) truck.enabled = false;
        if (_rb != null)
        {
            _rb.linearVelocity = Vector3.zero;
            _rb.angularVelocity = Vector3.zero;
            _rb.isKinematic = true;          // nothing can shove a wreck about
        }

        Wrecked?.Invoke();
    }

    void Update()
    {
        EnsureInit();
        if (!IsDestroyed) return;

        // UNSCALED: the death sequence puts the world in slow motion, and a
        // wait measured in scaled time would stretch with it - five seconds
        // would take fourteen.
        _burningFor += Time.unscaledDeltaTime;
        if (_burningFor < respawnSeconds) return;

        _burningFor = -1f;
        Health = maxHealth;

        if (_rb != null) _rb.isKinematic = false;
        if (truck != null)
        {
            truck.enabled = true;
            truck.Respawn();
        }
        if (_skin != null) foreach (var r in _skin) if (r != null) r.enabled = true;

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
        if (IsDestroyed) return;
        if (collision.gameObject.layer != ArmyRenderer.UnitLayer) return;

        float impact = collision.relativeVelocity.magnitude;
        if (impact >= crashSpeed) WriteOff();
        else Damage(impact * 6f);       // a slow shunt still costs paint
    }
}
