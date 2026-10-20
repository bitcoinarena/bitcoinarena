// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

/// <summary>
/// The death sequence: slow motion, the colour drains out of the world, the
/// camera pulls off the burning truck and circles it, and WASTED comes up over
/// the top.
///
/// All four together are what makes it read as a death rather than as a pause.
/// The text alone over a frozen chase camera looks like the game stopped.
///
/// Everything here runs on UNSCALED time. The whole point is that the world
/// slows down, so anything measured in scaled time - the respawn wait
/// included - would stretch with it and the five seconds would become eight.
/// </summary>
public class WastedSequence : MonoBehaviour
{
    public TruckHealth health;
    public ChaseCamera chase;

    [Tooltip("How far time is slowed while the truck burns.")]
    public float slowMotion = 0.35f;

    [Tooltip("Seconds for the colour to drain and the slowdown to bite.")]
    public float fadeIn = 0.7f;

    [Tooltip("Seconds before the respawn that everything comes back to normal.")]
    public float recover = 0.8f;

    // IN A LIVE ROUND THE BAND HOLDS 3 s, THEN FADES (2026-10-04 15:16: "Remove the WASTED text after a
    // few seconds. Spectate stays"): the band, the slow motion and the grade are up for holdSeconds from the wreck, fade out
    // over fadeOutSeconds, and the sequence ends - the death orbit let go, time back to 1 - so the run-end spectate takes the
    // view and the next round opens on the chase camera. This replaces the 2026-09-27 hold-until-the-lobby in live rounds.
    [Tooltip("Seconds the WASTED band holds in a live round, from the wreck.")]
    public float holdSeconds = 3f;
    [Tooltip("Seconds the band, slow motion and grade take to fade out after the hold, in a live round.")]
    public float fadeOutSeconds = 0.5f;

    /// <summary>True while the live round's band is up or fading: the run-end spectate waits for it.</summary>
    public bool BandUp => _running && _live;
    /// <summary>When the last live-round sequence ended (unscaled seconds), -1 before any: the spectate starts after it.</summary>
    public float LiveEndedAt { get; private set; } = -1f;
    bool _live;
    float _wreckedAt = -1f;

    /// <summary>0..1, how far into the sequence. Drives the WASTED overlay.</summary>
    public float Intensity { get; private set; }

    Volume _volume;
    ColorAdjustments _grade;
    Vignette _vignette;
    bool _running;

    void Awake()
    {
        // Its own volume on top of the scene's, so the normal grade is left
        // exactly as it is and this one is simply mixed in over it.
        var go = new GameObject("Wasted Grade");
        go.transform.SetParent(transform, false);

        var profile = ScriptableObject.CreateInstance<VolumeProfile>();
        _grade = profile.Add<ColorAdjustments>(true);
        _grade.saturation.overrideState = true;
        _grade.postExposure.overrideState = true;
        _grade.contrast.overrideState = true;

        _vignette = profile.Add<Vignette>(true);
        _vignette.intensity.overrideState = true;
        _vignette.smoothness.overrideState = true;
        _vignette.color.overrideState = true;
        _vignette.color.value = Color.black;

        _volume = go.AddComponent<Volume>();
        _volume.isGlobal = true;
        _volume.priority = 100f;          // over the scene grade
        _volume.profile = profile;
        _volume.weight = 0f;
    }

    /// <summary>
    /// Bound in Start, not OnEnable. AddComponent runs Awake and OnEnable
    /// before the caller's next line, so a subscription there would attach to
    /// a health field that is still null - and silently, because unsubscribing
    /// from nothing throws nothing.
    /// </summary>
    void Start()
    {
        // Found here rather than taken from the caller: Bootstrap builds the
        // camera AFTER the truck, so anything assigning it at wiring time gets
        // whatever happens to exist at that line. Start runs once the scene is
        // whole.
        if (chase == null) chase = FindFirstObjectByType<ChaseCamera>();

        if (health == null) return;
        health.Wrecked += Begin;
        health.Respawned += End;
        health.Revived += End;
        _bound = true;
    }

    void OnDisable()
    {
        if (_bound && health != null)
        {
            health.Wrecked -= Begin;
            health.Respawned -= End;
            health.Revived -= End;
            _bound = false;
        }
        Restore();
    }

    bool _bound;

    void Begin()
    {
        _running = true;
        _wreckedAt = Time.unscaledTime;
        _live = !DeliveryGate.BackToTheBay(Arena.ArenaNet.RoundSeed);
        if (_live) Debug.Log($"[arena] wasted: up, the band holds {holdSeconds:0.0} s then fades over {fadeOutSeconds:0.0} s");
    }

    void End()
    {
        _running = false;
        Intensity = 0f;
        Restore();
    }

    void Restore()
    {
        Time.timeScale = 1f;
        if (_volume != null) _volume.weight = 0f;
        if (chase != null) chase.deathOrbit = null;
    }

    void Update()
    {
        if (!_running) { Intensity = 0f; return; }

        // THE LIVE ROUND'S OWN CLOCK: hold, fade, end - nothing respawns there, so the respawn timer says nothing
        if (_live)
        {
            float since = Time.unscaledTime - _wreckedAt;
            bool nextRun = since > 0.5f && Arena.ArenaCore.Available && Arena.ArenaCore.RunState == Arena.Layout.RUN_LIVE;
            if (since >= holdSeconds + fadeOutSeconds || nextRun)
            {
                _running = false; _live = false; Intensity = 0f;
                LiveEndedAt = Time.unscaledTime;
                Restore();
                Debug.Log($"[arena] wasted: gone {since:0.00} s after the wreck{(nextRun ? " (a new run began)" : "")}; time scale {Time.timeScale:0.00}");
                return;
            }
            Apply(LiveIntensity(since, fadeIn, holdSeconds, fadeOutSeconds));
            return;
        }

        float dead = health.respawnSeconds - health.RespawnIn;

        // PRACTICE: in over the first moment, back out just before he is up again (a live round is handled above)
        float rise = Mathf.Clamp01(dead / Mathf.Max(0.01f, fadeIn));
        float fall = Mathf.Clamp01(health.RespawnIn / Mathf.Max(0.01f, recover));
        Apply(Mathf.Min(rise, fall));
    }

    /// <summary>
    /// THE LIVE ROUND'S CURVE, <paramref name="since"/> the wreck in real seconds: up over <paramref name="fadeIn"/>,
    /// full until <paramref name="hold"/>, down to 0 over <paramref name="fadeOut"/>, 0 after.
    /// </summary>
    public static float LiveIntensity(float since, float fadeIn, float hold, float fadeOut)
    {
        if (since < 0f) return 0f;
        float up = Mathf.Clamp01(since / Mathf.Max(0.01f, fadeIn));
        float down = since <= hold ? 1f : Mathf.Clamp01(1f - (since - hold) / Mathf.Max(0.01f, fadeOut));
        return Mathf.Min(up, down);
    }

    void Apply(float k)
    {
        Intensity = k;
        Time.timeScale = Mathf.Lerp(1f, slowMotion, k);

        _volume.weight = k;
        _grade.saturation.value = Mathf.Lerp(0f, -92f, k);   // GTA drains, not quite mono
        _grade.postExposure.value = Mathf.Lerp(0f, -0.75f, k);
        _grade.contrast.value = Mathf.Lerp(0f, 18f, k);
        _vignette.intensity.value = Mathf.Lerp(0f, 0.5f, k);
        _vignette.smoothness.value = 0.7f;

        if (chase != null && chase.deathOrbit == null && health.IsDestroyed)
            chase.deathOrbit = health.transform.position;
    }
}
