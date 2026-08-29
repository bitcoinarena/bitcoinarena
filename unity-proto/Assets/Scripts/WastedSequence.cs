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
        _bound = true;
    }

    void OnDisable()
    {
        if (_bound && health != null)
        {
            health.Wrecked -= Begin;
            health.Respawned -= End;
            _bound = false;
        }
        Restore();
    }

    bool _bound;

    void Begin() => _running = true;

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

        float dead = health.respawnSeconds - health.RespawnIn;

        // in over the first moment, back out just before he is up again
        float rise = Mathf.Clamp01(dead / Mathf.Max(0.01f, fadeIn));
        float fall = Mathf.Clamp01(health.RespawnIn / Mathf.Max(0.01f, recover));
        Intensity = Mathf.Min(rise, fall);

        float k = Intensity;
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
