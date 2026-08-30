using UnityEngine;

/// <summary>
/// Every sound in the game, synthesised at runtime.
///
/// No audio files: nothing to download, nothing added to the payload, and
/// nothing that can be missing from a build. A truck engine is a stack of
/// harmonics over a fundamental that tracks the crankshaft, an impact is a
/// noise burst with a fast decay, and an explosion is the same burst dropped
/// an octave and given a tail. That is close enough to carry the scene, and it
/// costs 200 kB of generated samples instead of megabytes of assets.
///
/// Browsers refuse to start audio before the user has touched the page, so
/// nothing is heard until the first click or key - which in this game is the
/// first package being picked up.
/// </summary>
public class GameAudio : MonoBehaviour
{
    public const int Rate = 44100;

    [Header("Levels")]
    public float engineVolume = 0.30f;
    public float effectVolume = 0.55f;

    public TruckController truck;

    /// <summary>One-shots fired since start. Public so a test can see them.</summary>
    public int Fired { get; private set; }

    AudioSource _engine, _tyres, _shots, _war, _rotor;
    AudioClip _impact, _explosion, _chime, _blip, _thud;
    AudioClip _cannon, _rifle, _ricochet, _boom;
    Rigidbody _body;
    float _rpm;

    void Awake()
    {
        _engine = Make("Engine", loop: true);
        _engine.clip = EngineClip();
        _engine.volume = 0f;
        _engine.Play();

        _tyres = Make("Tyres", loop: true);
        _tyres.clip = NoiseClip(1f, 0.65f);
        _tyres.volume = 0f;
        _tyres.Play();

        _shots = Make("Effects", loop: false);

        // The battle gets its own voice so a burst of rifle fire cannot cut off
        // the truck's own impact - one source stealing from the other is what
        // makes a firefight sound thin.
        _war = Make("War", loop: false);

        _rotor = Make("Rotor", loop: true);
        _rotor.clip = RotorClip();
        _rotor.volume = 0f;
        _rotor.Play();

        _impact = Burst("impact", 0.35f, 9f, 900f);
        _explosion = Burst("explosion", 1.6f, 2.4f, 220f);
        _thud = Burst("thud", 0.25f, 14f, 320f);
        _chime = Chime();
        _blip = Blip();

        _cannon = Burst("cannon", 1.1f, 4.5f, 420f);
        _rifle = Burst("rifle", 0.16f, 26f, 3800f);
        _ricochet = Burst("ricochet", 0.20f, 20f, 2600f);
        _boom = Burst("boom", 2.0f, 1.9f, 160f);
    }

    AudioSource Make(string name, bool loop)
    {
        var go = new GameObject(name);
        go.transform.SetParent(transform, false);
        var src = go.AddComponent<AudioSource>();
        src.loop = loop;
        src.playOnAwake = false;
        src.spatialBlend = 0f;          // the player is the camera, not a point in the world
        return src;
    }

    /* ------------------------------------------------------------ the engine */

    void Update()
    {
        if (truck == null) return;
        if (_body == null) _body = truck.GetComponent<Rigidbody>();
        if (_body == null) return;

        float speed = _body.linearVelocity.magnitude;
        float throttle = Mathf.Abs(DriveInput.Throttle);

        // Revs chase the road speed but never fall to nothing, and they lift
        // with the throttle even when the truck is not yet moving - which is
        // what makes pulling away sound like effort rather than like a switch.
        float wanted = Mathf.Clamp01(speed / 22f) * 0.75f + throttle * 0.35f;
        _rpm = Mathf.Lerp(_rpm, Mathf.Clamp01(wanted), 1f - Mathf.Exp(-3.5f * Time.deltaTime));

        _engine.pitch = Mathf.Lerp(0.55f, 2.15f, _rpm);
        _engine.volume = engineVolume * Mathf.Lerp(0.45f, 1f, _rpm);

        // Tyre noise is the sideways slip, so it comes up in a corner and on
        // the handbrake rather than simply with speed.
        float slip = Mathf.Clamp01(truck.Slip / 6f) * Mathf.Clamp01(speed / 6f);
        _tyres.pitch = Mathf.Lerp(0.8f, 1.5f, slip);
        _tyres.volume = Mathf.Lerp(_tyres.volume, effectVolume * 0.5f * slip,
                                   1f - Mathf.Exp(-8f * Time.deltaTime));
    }

    /* ----------------------------------------------------------- the one-shots */

    void Shot(AudioClip clip, float volume, float pitch)
    {
        if (clip == null || _shots == null) return;
        _shots.pitch = pitch;
        _shots.PlayOneShot(clip, Mathf.Clamp01(volume * effectVolume));
        Fired++;
    }

    /// <summary>Metal on metal. Strength is roughly the impact speed.</summary>
    public void Impact(float strength) =>
        Shot(_impact, Mathf.Clamp01(0.25f + strength * 0.08f),
             Random.Range(0.85f, 1.15f) * Mathf.Lerp(1.25f, 0.8f, Mathf.Clamp01(strength / 12f)));

    public void Explosion() => Shot(_explosion, 1f, Random.Range(0.85f, 1.1f));

    /// <summary>Something soft under the wheels.</summary>
    public void Thud() => Shot(_thud, 0.7f, Random.Range(0.9f, 1.2f));

    /// <summary>Freight delivered.</summary>
    public void Delivered() => Shot(_chime, 0.9f, 1f);

    /// <summary>A package picked up or put back.</summary>
    public void Pickup(bool taken) => Shot(_blip, 0.5f, taken ? 1.25f : 0.85f);

    /* ------------------------------------------------------------- the battle */

    /// <summary>
    /// Where the player is, for working out how loud the war is. Set by the
    /// battlefield; without it everything is heard as if it happened here.
    /// </summary>
    public Transform ear;

    /// <summary>
    /// How loud something at this point should be.
    ///
    /// Nothing is spatialised - the listener is the camera, which moves - so
    /// distance is applied by hand. A rifle two hundred metres up the field
    /// must not be as loud as one beside the cab, or the battle turns into a
    /// wall of noise with no sense of where anything is.
    /// </summary>
    float Carry(Vector2 at, float range)
    {
        if (ear == null) return 0.6f;
        var p = ear.position;
        float d = Vector2.Distance(at, new Vector2(p.x, p.z));
        return Mathf.Clamp01(1f - d / range);
    }

    void War(AudioClip clip, float volume, float pitch)
    {
        if (clip == null || _war == null || volume <= 0.01f) return;
        _war.pitch = pitch;
        _war.PlayOneShot(clip, Mathf.Clamp01(volume * effectVolume));
        Fired++;
    }

    /// <summary>A tank's main gun.</summary>
    public void Cannon(Vector2 at)
    {
        float carry = Carry(at, 190f);
        War(_cannon, carry * carry * 0.95f, Random.Range(0.82f, 1.05f));
    }

    /// <summary>A rifle. Deliberately quiet: there are a hundred of them.</summary>
    public void Rifle(Vector2 at)
    {
        float carry = Carry(at, 90f);
        War(_rifle, carry * carry * 0.30f, Random.Range(0.85f, 1.3f));
    }

    /// <summary>Something was hit - a round finding metal or a man.</summary>
    public void Hit(Vector2 at)
    {
        float carry = Carry(at, 110f);
        War(_ricochet, carry * carry * 0.45f, Random.Range(0.8f, 1.4f));
    }

    /// <summary>Something was destroyed: a tank, a bomb, the truck.</summary>
    public void Destroyed(Vector2 at)
    {
        float carry = Carry(at, 260f);
        War(_boom, Mathf.Max(0.15f, carry * carry), Random.Range(0.8f, 1.05f));
    }

    /// <summary>
    /// Rotors overhead. Called every frame with the nearest helicopter, or
    /// nothing when the sky is clear.
    /// </summary>
    public void Rotors(Vector2? at)
    {
        if (_rotor == null) return;
        float wanted = at.HasValue ? Carry(at.Value, 150f) : 0f;
        _rotor.volume = Mathf.Lerp(_rotor.volume, effectVolume * 0.55f * wanted * wanted,
                                   1f - Mathf.Exp(-2.5f * Time.deltaTime));
        _rotor.pitch = Mathf.Lerp(0.85f, 1.1f, wanted);
    }

    /* --------------------------------------------------------- the synthesis */

    /// <summary>
    /// A diesel: a low fundamental with its harmonics, roughened with a little
    /// noise. The loop is a whole number of periods long, or it clicks.
    /// </summary>
    static AudioClip EngineClip()
    {
        const float fundamental = 55f;
        const int periods = 55;                        // exactly one second
        int samples = Mathf.RoundToInt(Rate * periods / fundamental);
        var data = new float[samples];

        var rng = new System.Random(7);
        float rough = 0f;
        for (int i = 0; i < samples; i++)
        {
            float t = i / (float)Rate;
            float v = Mathf.Sin(2f * Mathf.PI * fundamental * t) * 0.55f
                    + Mathf.Sin(2f * Mathf.PI * fundamental * 2f * t) * 0.28f
                    + Mathf.Sin(2f * Mathf.PI * fundamental * 3f * t) * 0.16f
                    + Mathf.Sin(2f * Mathf.PI * fundamental * 5f * t) * 0.08f;

            // a slow-moving rasp, low-passed so it is texture and not hiss
            rough = Mathf.Lerp(rough, (float)(rng.NextDouble() * 2.0 - 1.0), 0.06f);
            data[i] = Mathf.Clamp(v * 0.55f + rough * 0.22f, -1f, 1f);
        }

        var clip = AudioClip.Create("engine", samples, 1, Rate, false);
        clip.SetData(data, 0);
        return clip;
    }

    /// <summary>Filtered noise, for tyres. Loops cleanly by cross-fading its ends.</summary>
    static AudioClip NoiseClip(float seconds, float smoothing)
    {
        int samples = Mathf.RoundToInt(Rate * seconds);
        var data = new float[samples];
        var rng = new System.Random(11);
        float v = 0f;
        for (int i = 0; i < samples; i++)
        {
            v = Mathf.Lerp(v, (float)(rng.NextDouble() * 2.0 - 1.0), 1f - smoothing);
            data[i] = v;
        }
        // fade the tail into the head so the loop has no seam
        int fade = Mathf.Min(2000, samples / 4);
        for (int i = 0; i < fade; i++)
        {
            float k = i / (float)fade;
            data[i] = Mathf.Lerp(data[samples - fade + i], data[i], k);
        }

        var clip = AudioClip.Create("noise", samples, 1, Rate, false);
        clip.SetData(data, 0);
        return clip;
    }

    /// <summary>A noise burst with an exponential decay and a low-pass.</summary>
    static AudioClip Burst(string name, float seconds, float decay, float cutoff)
    {
        int samples = Mathf.RoundToInt(Rate * seconds);
        var data = new float[samples];
        var rng = new System.Random(name.GetHashCode());
        float k = Mathf.Clamp01(cutoff / (Rate * 0.5f));
        float v = 0f;
        for (int i = 0; i < samples; i++)
        {
            v = Mathf.Lerp(v, (float)(rng.NextDouble() * 2.0 - 1.0), k);
            float t = i / (float)Rate;
            data[i] = v * Mathf.Exp(-decay * t);
        }
        var clip = AudioClip.Create(name, samples, 1, Rate, false);
        clip.SetData(data, 0);
        return clip;
    }

    /// <summary>Two notes, for an arrival.</summary>
    static AudioClip Chime()
    {
        int samples = Rate;                            // one second
        var data = new float[samples];
        for (int i = 0; i < samples; i++)
        {
            float t = i / (float)Rate;
            float a = Mathf.Sin(2f * Mathf.PI * 660f * t) * Mathf.Exp(-5f * t);
            float b = t > 0.11f
                ? Mathf.Sin(2f * Mathf.PI * 990f * (t - 0.11f)) * Mathf.Exp(-4f * (t - 0.11f))
                : 0f;
            data[i] = (a + b) * 0.4f;
        }
        var clip = AudioClip.Create("chime", samples, 1, Rate, false);
        clip.SetData(data, 0);
        return clip;
    }

    /// <summary>
    /// A rotor: a low thump repeating at blade rate, over a wash of air.
    /// </summary>
    static AudioClip RotorClip()
    {
        const float beats = 11f;                       // blade passes a second
        int samples = Rate;                            // one second, so it loops
        var data = new float[samples];
        var rng = new System.Random(23);
        float air = 0f;
        for (int i = 0; i < samples; i++)
        {
            float t = i / (float)Rate;
            float phase = Mathf.Repeat(t * beats, 1f);
            float thump = Mathf.Exp(-14f * phase) * Mathf.Sin(2f * Mathf.PI * 46f * t);
            air = Mathf.Lerp(air, (float)(rng.NextDouble() * 2.0 - 1.0), 0.25f);
            data[i] = Mathf.Clamp(thump * 0.7f + air * 0.18f, -1f, 1f);
        }
        var clip = AudioClip.Create("rotor", samples, 1, Rate, false);
        clip.SetData(data, 0);
        return clip;
    }

    /// <summary>A short click, for picking freight up.</summary>
    static AudioClip Blip()
    {
        int samples = Rate / 8;
        var data = new float[samples];
        for (int i = 0; i < samples; i++)
        {
            float t = i / (float)Rate;
            data[i] = Mathf.Sin(2f * Mathf.PI * 880f * t) * Mathf.Exp(-28f * t) * 0.5f;
        }
        var clip = AudioClip.Create("blip", samples, 1, Rate, false);
        clip.SetData(data, 0);
        return clip;
    }
}
