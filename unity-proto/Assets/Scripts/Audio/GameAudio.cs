// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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

    /// <summary>
    /// The strike's clip. It is SYNTHESISED in `Detonation()`, not imported, so
    /// the only way to know it is not silence is to read its samples - which is
    /// the first link of the chain from a consumed liquidation to a sound.
    /// </summary>
    public AudioClip StrikeClip => _detonation;

    AudioSource _engine, _tyres, _shots, _war, _rotor, _blast;
    float _overSince = -1f, _overLogAt, _engineGain = 1f;
    // THE ONE-SHOTS ARE MADE WHEN FIRST WANTED, NOT IN AWAKE (measured 2026-10-08 in a named profile of production
    // at 10x CPU as an Android phone: GameAudio.Awake was 151 ms of the 90 -> 100 % block, synthesising every clip sample by
    // sample). Each is made on its first use, and Start makes the rest one a frame from 3 s after the start - the same clips.
    AudioClip _impactC, _explosionC, _chimeC, _blipC, _thudC;
    AudioClip _cannonC, _rifleC, _ricochetC, _boomC, _detonationC, _whistleC;
    AudioClip _impact => _impactC ??= Burst("impact", 0.35f, 9f, 900f);
    AudioClip _explosion => _explosionC ??= Burst("explosion", 1.6f, 2.4f, 220f);
    AudioClip _thud => _thudC ??= Burst("thud", 0.25f, 14f, 320f);
    AudioClip _chime => _chimeC ??= Chime();
    AudioClip _blip => _blipC ??= Blip();
    AudioClip _cannon => _cannonC ??= Burst("cannon", 1.1f, 4.5f, 420f);
    AudioClip _rifle => _rifleC ??= Burst("rifle", 0.16f, 26f, 3800f);
    AudioClip _ricochet => _ricochetC ??= Burst("ricochet", 0.20f, 20f, 2600f);
    AudioClip _boom => _boomC ??= Burst("boom", 2.0f, 1.9f, 160f);
    AudioClip _detonation => _detonationC ??= Detonation();
    AudioClip _whistle => _whistleC ??= Whistle();

    System.Collections.IEnumerator Start()
    {
        yield return new WaitForSecondsRealtime(3f);
        var made = new System.Func<AudioClip>[] { () => _impact, () => _explosion, () => _thud, () => _chime, () => _blip,
            () => _cannon, () => _rifle, () => _ricochet, () => _boom, () => _whistle, () => _detonation };
        foreach (var make in made) { make(); yield return null; }
    }
    AudioSource _drone;
    float _saidDrone = -99f;
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

        // The strike gets a source of its OWN, and it is not tidiness.
        // `pitch` belongs to the AudioSource, not to the one-shot: `Shot` sets
        // it before every PlayOneShot, so a rifle round or a kerb hit landing
        // inside the detonation's 4.5 seconds re-pitched the detonation that
        // was still playing. Nothing in a test could see that - the clip is
        // right, the trigger is right, and the sound bends anyway.
        _blast = Make("Blast", loop: false);

        _rotor = Make("Rotor", loop: true);
        _rotor.clip = RotorClip();
        _rotor.volume = 0f;
        _rotor.Play();

        // THE BOMBER, on its own looping source. the owner, 17:50: no sound for
        // the plane, the bomb drop or the explosion. The detonation existed;
        // these two did not exist at all, so there was nothing to repair -
        // they had to be made.
        _drone = Make("Bomber", loop: true);
        _drone.clip = EngineClip();
        _drone.volume = 0f;
        _drone.pitch = 1.35f;          // higher than the truck's diesel
        _drone.Play();
        // the one-shots: made on first use, or by Start once the scene is running (see their fields)
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

        // THE ROAD SPEED COMES FROM THE CORE. This read
        // `_body.linearVelocity.magnitude`, and the body is kinematic while the
        // core drives - measured in the player build, `kinematic=True` and
        // `linearVelocity=0.00` at speed, so the engine note followed the
        // throttle alone and never the road. `T_WHEEL` is the core's own wheel
        // speed and is what the HUD already reads.
        float speed = Arena.ArenaCore.Available
            ? Arena.ArenaCore.TruckSpeed
            : _body.linearVelocity.magnitude;
        float throttle = Mathf.Abs(DriveInput.Throttle);

        // Revs chase the road speed but never fall to nothing, and they lift
        // with the throttle even when the truck is not yet moving - which is
        // what makes pulling away sound like effort rather than like a switch.
        float wanted = Mathf.Clamp01(speed / 22f) * 0.75f + throttle * 0.35f;
        _rpm = Mathf.Lerp(_rpm, Mathf.Clamp01(wanted), 1f - Mathf.Exp(-3.5f * Time.deltaTime));

        _engine.pitch = Mathf.Lerp(0.55f, 2.15f, _rpm);
        // NO DRIVE SOUND ONCE THE RUN IS OVER (2026-09-27 13:25): the idle floor was still a running engine -
        // measured after a MISSED run's end, rpm 0.00 and volume 0.135 - so the note fades out with the run, in about
        // half a second, and comes back with the next one
        _engineGain = Mathf.MoveTowards(_engineGain, DriveInput.RunOver ? 0f : 1f, Time.unscaledDeltaTime * 2f);
        _engine.volume = engineVolume * Mathf.Lerp(0.45f, 1f, _rpm) * _engineGain;

        // AFTER THE RUN, SAID (2026-09-27 13:25: the drive sound played after WASTED and after a delivery): for
        // twelve seconds after the end, every two, what the keys hold against what the truck is given and the engine
        if (DriveInput.RunOver)
        {
            if (_overSince < 0f) _overSince = Time.unscaledTime;
            if (Time.unscaledTime - _overSince < 12f && Time.unscaledTime >= _overLogAt)
            {
                _overLogAt = Time.unscaledTime + 2f;
                Debug.Log($"[drive] after the end: held throttle {DriveInput.HeldThrottle:F0} steer {DriveInput.HeldSteer:F0}, "
                          + $"given throttle {DriveInput.Throttle:F0} steer {DriveInput.Steer:F0}, "
                          + $"speed {speed:F1}, engine rpm {_rpm:F2} volume {_engine.volume:F3}");
            }
        }
        else _overSince = -1f;

        // Tyre noise is the sideways slip, so it comes up in a corner and on
        // the handbrake rather than simply with speed.
        // THE SIDEWAYS SPEED COMES FROM THE CORE TOO. `truck.Slip` is
        // `|InverseTransformDirection(_rb.linearVelocity).x|`, and the body is
        // kinematic while the core drives - measured in the player build,
        // slip=0.00 at speed, so the tyres were wired and silent. The core
        // works the same projection out every tick to spend its friction
        // circle on; `TruckSlip` reads it back off the published words. One
        // source, not two formulas side by side.
        float across = Arena.ArenaCore.Available ? Arena.ArenaCore.TruckSlip : truck.Slip;
        float slip = Mathf.Clamp01(across / 6f) * Mathf.Clamp01(speed / 6f);
        _tyres.pitch = Mathf.Lerp(0.8f, 1.5f, slip);
        _tyres.volume = Mathf.Lerp(_tyres.volume, effectVolume * 0.5f * slip * _engineGain,
                                   1f - Mathf.Exp(-8f * Time.deltaTime));
    }

    /* ----------------------------------------------------------- the one-shots */

    void Shot(AudioClip clip, float volume, float pitch)
    {
        if (clip == null || _shots == null) return;
        _shots.pitch = pitch;
        float level = Mathf.Clamp01(volume * effectVolume);
        _shots.PlayOneShot(clip, level);
        Fired++;
    }

    /// <summary>
    /// The strike, on its own source. Same recipe as `Shot`, and deliberately
    /// not the same source: this one's pitch is set once per detonation and by
    /// nothing else, so a shot fired during those 4.5 s cannot bend it.
    /// </summary>
    void Blast(AudioClip clip, float volume, float pitch)
    {
        if (clip == null || _blast == null) return;
        _blast.pitch = pitch;
        float level = Mathf.Clamp01(volume * effectVolume);
        _blast.PlayOneShot(clip, level);
        Fired++;
        _detonationsPlayed++;
        int sources = FindObjectsByType<AudioSource>(FindObjectsSortMode.None).Length;
        Debug.Log($"[voice] PlayOneShot detonation #{_detonationsPlayed} " +
                  $"level={level:F3} pitch={_blast.pitch:F3} sources={sources}");
    }

    /// <summary>The pitch the strike's own source is set to. Tests.</summary>
    public float StrikePitch => _blast != null ? _blast.pitch : 0f;

    int _detonationsPlayed;

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

    /// <summary>
    /// The atom bomb: a crack, and then a roll that takes seconds to leave.
    ///
    /// Not `Burst`. Every other explosion here is one filtered noise burst with
    /// an exponential decay, which is right for a tank and wrong for this - a
    /// detonation of this size is heard as a sharp front and then a very low
    /// roll that arrives after it and outlasts it by seconds. So two filters
    /// over the same noise: a fast one for the crack, and a very slow one for
    /// the roll, whose envelope RISES before it falls.
    ///
    /// Synthesised like every other clip in this file, so it costs nothing in
    /// the download and cannot go missing from a bundle.
    /// </summary>
    static AudioClip Detonation()
    {
        const float Seconds = 4.5f;
        int samples = Mathf.RoundToInt(Rate * Seconds);
        var data = new float[samples];
        // IT HAD NOTHING A PHONE CAN MAKE. the owner heard the plane and the
        // bomb and not the blast, and the clip is why: the two filters here
        // were a one-pole at 0.0016 and one at 0.020, which are cutoffs of
        // 11 Hz and 140 Hz. Measured on the synthesised samples, only 5.5% of
        // its energy sat above 200 Hz and 2.3% above 500. A phone speaker
        // rolls off long before that, so a blast built almost entirely of
        // sub-bass is silent on it - while the whistle at 300-1400 Hz and the
        // drone's harmonics at 190-316 Hz came through.
        //
        // The roll and the thump stay, for speakers that can move air. What
        // is added is the part a small speaker can reproduce: a bright snap
        // from the noise's own high end, and a body around 630 Hz under it.
        // Same measurement after: 53% above 200 Hz, 39% above 500, 28% above
        // a kilohertz.
        var rng = new System.Random("detonation".GetHashCode());
        float lo = 0f, mid = 0f, body = 0f, hi = 0f;
        for (int i = 0; i < samples; i++)
        {
            float w = (float)(rng.NextDouble() * 2.0 - 1.0);
            lo = Mathf.Lerp(lo, w, 0.0016f);      // 11 Hz, the roll you feel
            mid = Mathf.Lerp(mid, w, 0.020f);     // 140 Hz, the thump
            body = Mathf.Lerp(body, w, 0.090f);   // 630 Hz, the body of it
            hi = Mathf.Lerp(hi, w, 0.400f);       // 2.8 kHz lowpass, so w - hi
            float t = i / (float)Rate;            // is the crack above it
            float crack = Mathf.Exp(-8f * t);
            float roll = Mathf.Exp(-0.7f * t) * (1f - Mathf.Exp(-11f * t));
            float snap = Mathf.Exp(-26f * t);
            float tail = Mathf.Exp(-3.2f * t);
            data[i] = Mathf.Clamp(mid * 0.6f * crack + lo * 7f * roll
                                  + (w - hi) * 0.9f * snap + body * 2.6f * tail,
                                  -1f, 1f);
        }
        var clip = AudioClip.Create("detonation", samples, 1, Rate, false);
        clip.SetData(data, 0);
        return clip;
    }

    /// <summary>An atom bomb going off. Louder than anything else here.</summary>
    /// <summary>
    /// The strike's voice, and the one place the whole chain can be read.
    ///
    /// `a11`: built and never heard. Everything between a consumed liquidation
    /// and a sound is either upstream of here and already logged - the core's
    /// strike serial, `StrikeTheatre`'s impact line - or it is one of the four
    /// silent gates below. So they are printed at the moment they matter,
    /// rather than being assumed from the inspector: whether the clip exists,
    /// whether the source that would play it exists, what the effects level is,
    /// and whether anything in the scene is listening at all. `Fired` counts
    /// the one-shots that actually went to `PlayOneShot`.
    /// </summary>
    /// <summary>
    /// The aircraft overhead, while it is on its run. Called every frame with
    /// how near it is, 0 to 1, and 0 when there is no bomber.
    /// </summary>
    public void Bomber(float near)
    {
        if (_drone == null) return;
        float want = Mathf.Clamp01(near);
        _drone.volume = Mathf.Lerp(_drone.volume, effectVolume * 0.5f * want * want,
                                   1f - Mathf.Exp(-3f * Time.deltaTime));
        _drone.pitch = Mathf.Lerp(1.15f, 1.5f, want);

        // A LOOP PRINTS NOTHING, which is how the last one got away: a source
        // that exists is not a source that is heard, and counting sources only
        // proved it had been made. This says what the volume actually reached.
        if (want > 0.01f && Time.time - _saidDrone > 1.5f)
        {
            _saidDrone = Time.time;
            Debug.Log($"[voice] bomber drone near {want:F2}, volume {_drone.volume:F3}, "
                      + $"pitch {_drone.pitch:F2}, playing {_drone.isPlaying}");
        }
    }

    /// <summary>The bomb let go: a falling whistle, once.</summary>
    public void BombAway()
    {
        Shot(_whistle, 0.85f, Random.Range(0.97f, 1.05f));
        Debug.Log($"[voice] bomb away fired={Fired} clip={(_whistle != null)}");
    }

    public void Strike()
    {
        Blast(_detonation, 1f, Random.Range(0.94f, 1.02f));
        bool ear = FindFirstObjectByType<AudioListener>() != null;
        Debug.Log($"[voice] strike fired={Fired} clip={(_detonation != null)} " +
                  $"source={(_shots != null)} effectVolume={effectVolume:F2} listener={ear}");
    }

    /// <summary>
    /// A bomb falling: a tone that slides down while it gets louder, with a
    /// breath of air noise over it. Four seconds, which is about the fall.
    /// </summary>
    static AudioClip Whistle()
    {
        int samples = Mathf.RoundToInt(Rate * 4f);
        var data = new float[samples];
        var rng = new System.Random(11);
        float air = 0f, phase = 0f;
        for (int i = 0; i < samples; i++)
        {
            float t = i / (float)samples;
            // 1400 Hz down to 300: the drop is what says "coming down"
            float hz = Mathf.Lerp(1400f, 300f, t * t);
            phase += 2f * Mathf.PI * hz / Rate;
            air = Mathf.Lerp(air, (float)(rng.NextDouble() * 2.0 - 1.0), 0.25f);
            float swell = Mathf.Lerp(0.15f, 1f, t);
            data[i] = Mathf.Clamp((Mathf.Sin(phase) * 0.55f + air * 0.25f) * swell, -1f, 1f);
        }
        var clip = AudioClip.Create("whistle", samples, 1, Rate, false);
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
