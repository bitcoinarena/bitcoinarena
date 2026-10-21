// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
        Arena.PracticeMode.On || !_leftSpawn || (loadout != null && loadout.IsOpen);

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

    /// <summary>
    /// The condition the CORE says the truck is in.
    ///
    /// This class used to compute it: `Health -= amount / armour`, fed from
    /// `Field.Army.CourierHit` at `Bootstrap.cs:194`. That was a second
    /// simulation of the same thing - the core was already taking the hit off
    /// its own `T_HP` and nothing read it back - and M1 says damage comes FROM
    /// the core. So the arithmetic is gone, the armour divisor with it, and it
    /// lives in `sim.js` where the shell already lands. There is one pool now.
    ///
    /// `armour` and `maxHealth` stay as FIELDS because the view still needs a
    /// full-scale to draw a fraction against, and because the core's own
    /// divisor is written against the same 1.5. Neither is used to work out
    /// what a hit costs any more.
    ///
    /// The host calls this every frame with `ArenaCore.TruckHealth` and
    /// `ArenaCore.RunState`. A test stands in for the core and calls it too -
    /// that is stubbing the view's INPUT, not giving the view a second pool.
    /// </summary>
    public void ApplySnapshot(float health, bool wrecked)
    {
        EnsureInit();
        Health = Mathf.Clamp(health, 0f, maxHealth);
        if (Health < maxHealth) LastHitAt = Time.unscaledTime;

        // The core's word, applied ONCE per write-off.
        //
        // `outcome` latches: RUN_WRECKED holds for every tick after the truck
        // died, not just the one it died on. `IsDestroyed` is the burn timer,
        // not the condition, so it lets go when the wreck has finished burning
        // - and a level read here then exploded the truck again, and again,
        // every time the respawn cleared the timer. The `IsInvulnerable` guard
        // below used to hide that by refusing the write-off outright while the
        // truck was back on the apron. That guard is gone, so the edge is
        // stated instead of relied upon.
        //
        // The flag clears when the core says live again, which happens in one
        // place: `restart`, at roll-out. Nothing in C# clears it, and nothing
        // in C# refuses the wreck.
        if (!wrecked) { _wroteOff = false; return; }
        if (_wroteOff) return;
        _wroteOff = true;
        WriteOff();
    }

    /// <summary>Whether the core's current RUN_WRECKED has already been shown.</summary>
    bool _wroteOff;

    /// <summary>
    /// Show the truck as written off.
    ///
    /// NO `IsInvulnerable` HERE. It used to return early on it, which made
    /// this a C# veto over one of M1's four outcomes: measured in a browser
    /// with the same injection - run 0 -> 2 and `T_HP` 100 -> 0 forced in the
    /// core, nothing else touched - the road showed WASTED and the apron with
    /// the bay open showed an intact truck driving on. Two engines, one
    /// disagreeing with the other about whether the run was over.
    ///
    /// Invulnerability is a rule about where damage HAPPENS, and that belongs
    /// in the core, which already holds it: a truck parked in the bay takes
    /// zero damage over thirty seconds on three seeds because the army never
    /// reaches it, and practice withholds courier fire in `sim.js`. Applying
    /// it a second time here, after the core has already decided, is not
    /// protection - it is a second gate.
    /// </summary>
    public void WriteOff()
    {
        EnsureInit();
        if (IsDestroyed) return;

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
        // OnCollisionEnter used to sit below and hold the rule; it could not
        // fire, because the truck's Rigidbody is kinematic and the core writes
        // its transform, so PhysX resolved nothing and reported nothing.
        // The crash is FELT here and costed nowhere. `TakeImpact` is the core's
        // own impact word, so the shake and the bang are a reading of core
        // state and stay; deciding what the crash costs was client arithmetic
        // and has gone with the rest of it.
        //
        // THE CORE HAS NO CRASH DAMAGE YET. `T_HP` is written at spawn and
        // reduced by courier fire and by nothing else, so until that rule
        // exists a crash costs condition nowhere. It is a listed gap, not an
        // oversight, and it is not fixed here by leaving a second pool behind.
        // THE SNAPSHOT. Condition and the wrecked flag are read straight off
        // the core every frame; this class decides neither. When there is no
        // core answering - the editor, PlayMode, a standalone build, where
        // `ArenaCore` is stubbed - nothing is read and the value stays as it
        // was last set, which is how a test stands in for the core through
        // `ApplySnapshot`. Stubbing the view's input, not a second pool.
        if (Arena.ArenaCore.Available)
            ApplySnapshot(Arena.ArenaCore.TruckHealth,
                          Arena.ArenaCore.RunState == 2);      // RUN_WRECKED

        float rammed = Arena.ArenaCore.TakeImpact();
        if (rammed > 0.5f && !IsDestroyed && !IsInvulnerable)
        {
            if (chase != null) chase.Shake(Mathf.Min(1.2f, rammed * 0.09f));
            if (audio != null) audio.Impact(rammed);
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

        // INSIDE A LIVE ROUND THE WRECK IS THE END, AND IT STAYS ONE (2026-09-27 13:25: "After WASTED the truck
        // comes back ... the cargo panel is up, and WASD steers it"). Nothing is reset here: no health, no truck, no
        // `Respawned` - that opened the cargo panel and ended WASTED over a run the core had called WRECKED. The wreck
        // burns on under WASTED until the lobby; PLAY brings the truck back for the next round (`Revive`).
        if (!DeliveryGate.BackToTheBay(Arena.ArenaNet.RoundSeed)) { _burningFor = respawnSeconds; return; }

        ClearWreck();
        if (truck != null) truck.Respawn();
        Respawned?.Invoke();
    }

    /// <summary>
    /// THE NEXT ROUND'S TRUCK (2026-09-27 13:25): a wreck held under WASTED is put right when PLAY starts the next
    /// round - behind the lobby, not in front of the player - and WASTED goes with it. No cargo panel is opened here;
    /// PLAY opens it.
    /// </summary>
    public void Revive()
    {
        if (!IsDestroyed) return;
        ClearWreck();
        Revived?.Invoke();
    }

    /// <summary>Fired by `Revive`: the wreck is gone, no respawn at the bay.</summary>
    public System.Action Revived;

    void ClearWreck()
    {
        _burningFor = -1f;
        Health = maxHealth;
        _leftSpawn = false;              // protected again until it drives off

        // Kinematic stays kinematic while the core drives. `CoreDrivenTruck`
        // makes the body kinematic once, in Start, and writes the transform
        // from core state every frame; handing it back to PhysX here was a
        // PhysX-era line, and it meant that after the first write-off the
        // truck was a dynamic body being teleported sixty times a second for
        // the rest of the session. Without a core, PhysX drives and gets it
        // back, which is the editor's correct behaviour rather than a
        // degraded one.
        if (_rb != null) _rb.isKinematic = Arena.ArenaCore.Available;
        // INSIDE A LIVE ROUND THE WRECK IS THE END OF THE RUN (2026-09-15): the page finishes it off the core's
        // WRECKED and the lobby comes back; a respawn would teleport the core's truck, a write in no transcript. The
        // next round's core starts it afresh.
        if (truck != null) truck.enabled = true;
    }

    /// <summary>
    /// GONE, and the file's own comment above said why before it went: the
    /// truck's Rigidbody is kinematic and the core writes its transform, so
    /// PhysX resolves nothing and this could not fire. It was also the last
    /// place a PhysX quantity touched condition - it costed a crash from
    /// `collision.relativeVelocity` - which is exactly the shape M1 removes.
    /// </summary>
}
