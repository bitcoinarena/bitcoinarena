using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Makes the fighting visible: muzzle flashes, tracers, shell bursts, and
/// bodies that fall rather than vanish.
///
/// Everything is opaque and lives by SCALE rather than alpha. Transparent
/// materials in URP need surface type, blend mode and render queue set
/// correctly, and getting any of it wrong shows up only in the build - which
/// this port has already been bitten by three times. A tracer that shrinks to
/// nothing reads the same and cannot fail that way.
/// </summary>
public class CombatFx : MonoBehaviour
{
    public MempoolTerrain terrain;
    public Material tracerMaterial;
    public Material flashMaterial;
    public Material blastMaterial;
    public Material bullMaterial;
    public Material bearMaterial;

    [Header("Explosions")]
    public Material fireCoreMaterial;
    public Material fireMaterial;
    public Material smokeMaterial;
    public Material debrisMaterial;
    [Tooltip("Pale, for the dust ring. Built from the smoke material it reads as a black disc.")]
    public Material dustMaterial;

    [Header("Flipbook fire")]
    [Tooltip("Particle material carrying a fire flipbook. Null falls back to the sphere fireballs.")]
    public Material fireParticleMaterial;
    [Tooltip("Flipbook grid, e.g. 8x8 for a 64 frame sheet.")]
    public Vector2Int flipbookTiles = new Vector2Int(8, 8);
    [Tooltip("Same flipbook, alpha blended and grey. Null falls back to smoke spheres.")]
    public Material smokeParticleMaterial;
    [Tooltip("Tank model for the burnt-out hull. Falls back to a charred box.")]
    public GameObject wreckPrefab;
    public float wreckWidth = 3.7f;

    [Header("Bodies")]
    [Tooltip("Soldier model for the fallen. Without it a plain box is used.")]
    public GameObject bodyPrefab;
    public float bodyHeight = 1.8f;

    class Piece
    {
        public Transform t;
        public float life, age;
        public Vector3 baseScale;
        public Kind kind;
        public Quaternion fallFrom, fallTo;
        public Vector3 slide, from;
        public bool isModelBody, bull, isWreckModel;
        /// <summary>Held at zero scale until this much of its life has passed.</summary>
        public float delay;
        public Vector3 velocity, spin;
    }

    enum Kind { Tracer, Flash, Blast, Body, Wreck, Fireball, Smoke, Debris, Shockwave }

    /// <summary>Pooled soldier models for the dead, kept per side so the tint holds.</summary>
    readonly Dictionary<bool, Stack<Transform>> _bodyPool = new Dictionary<bool, Stack<Transform>>
    {
        { true, new Stack<Transform>() }, { false, new Stack<Transform>() },
    };

    readonly List<Piece> _live = new List<Piece>();
    readonly Stack<Transform> _cubes = new Stack<Transform>();
    readonly Stack<Transform> _spheres = new Stack<Transform>();
    Mesh _cube, _sphere;

    /// <summary>
    /// Hard ceiling. Thirty rifle shots a second across the field would
    /// otherwise pile up unbounded if anything ever stopped retiring them.
    /// </summary>
    public int maxPieces = 400;

    void Awake()
    {
        _cube = Prim(PrimitiveType.Cube);
        _sphere = Prim(PrimitiveType.Sphere);
    }

    static Mesh Prim(PrimitiveType type)
    {
        var go = GameObject.CreatePrimitive(type);
        var m = go.GetComponent<MeshFilter>().sharedMesh;
        DestroyImmediate(go);
        return m;
    }

    Transform Take(Stack<Transform> pool, Mesh mesh, Material mat)
    {
        Transform t;
        if (pool.Count > 0) t = pool.Pop();
        else
        {
            var go = new GameObject("Fx");
            go.transform.SetParent(transform, false);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var mr = go.AddComponent<MeshRenderer>();
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            t = go.transform;
        }
        t.GetComponent<MeshRenderer>().sharedMaterial = mat;
        t.gameObject.SetActive(true);
        return t;
    }

    void Retire(Piece p)
    {
        p.t.gameObject.SetActive(false);
        if (p.isModelBody) { _bodyPool[p.bull].Push(p.t); return; }
        if (p.isWreckModel) { _wreckPool.Push(p.t); return; }
        var mf = p.t.GetComponent<MeshFilter>();
        if (mf == null) return;                       // a model wrapper, not a primitive
        (mf.sharedMesh == _sphere ? _spheres : _cubes).Push(p.t);
    }

    float Ground(float x, float z) => terrain != null ? terrain.SampleSurface(x, z) : 0f;

    /* ------------------------------------------------------------- effects */

    /// <summary>A round in flight: a thin bar from muzzle to impact, briefly.</summary>
    public void Tracer(Vector3 from, Vector3 to, Material mat, float thickness, float life)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_cubes, _cube, mat ?? tracerMaterial);
        Vector3 mid = (from + to) * 0.5f;
        float len = Vector3.Distance(from, to);
        t.SetPositionAndRotation(mid, Quaternion.LookRotation((to - from).normalized, Vector3.up));
        var scale = new Vector3(thickness, thickness, len);
        t.localScale = scale;
        _live.Add(new Piece { t = t, life = life, baseScale = scale, kind = Kind.Tracer });
    }

    public void Flash(Vector3 at, float size)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_spheres, _sphere, flashMaterial);
        t.SetPositionAndRotation(at, Quaternion.identity);
        var scale = Vector3.one * size;
        t.localScale = scale;
        _live.Add(new Piece { t = t, life = 0.09f, baseScale = scale, kind = Kind.Flash });
    }

    /// <summary>
    /// A shell going off.
    ///
    /// The same recipe as a tank brewing up, just small: a flash of flame, a
    /// puff of smoke and a little dirt. It used to be one orange ball, which is
    /// what read across the field as scattered yellow blobs.
    /// </summary>
    public void Blast(Vector3 at, float size)
    {
        if (!FlipbookBurst(at + Vector3.up * 0.5f, 3))
        {
            Fireball(at, size * 1.1f, fireCoreMaterial, 0f, 0.14f);
            Fireball(at + Vector3.up * 0.6f, size * 1.5f, fireMaterial, 0.04f, 0.3f);
        }
        if (!SmokeBurst(at + Vector3.up * 0.8f, 2))
            for (int i = 0; i < 2; i++)
                Smoke(at + Vector3.up * Random.Range(0.5f, 1.5f), size * Random.Range(0.8f, 1.3f), 0.06f * i);
        for (int i = 0; i < 3; i++)
        {
            float a = Random.Range(0f, Mathf.PI * 2f);
            var v = new Vector3(Mathf.Sin(a), 0f, Mathf.Cos(a)) * Random.Range(3f, 7f);
            v.y = Random.Range(4f, 8f);
            Debris(at, v, Random.Range(0.15f, 0.35f));
        }
    }

    /// <summary>
    /// A rifleman going down.
    ///
    /// Uses the actual soldier model where one is available - a falling box is
    /// a placeholder, not a casualty. He keeps whatever pose the animator left
    /// him in, which reads far better than a rig snapping to a T-pose, then
    /// topples and sinks away.
    ///
    /// <paramref name="knock"/> is how he was hit: a bullet folds him where he
    /// stands, a truck throws him along the line it was travelling.
    /// </summary>
    public void Body(Vector3 at, float heading, bool bull, Vector2 knock = default)
    {
        if (_live.Count >= maxPieces) return;

        Transform t;
        Vector3 scale;
        bool model = bodyPrefab != null;
        if (model)
        {
            t = TakeBody(bull);
            scale = Vector3.one;
            t.localScale = scale;
        }
        else
        {
            t = Take(_cubes, _cube, bull ? bullMaterial : bearMaterial);
            scale = new Vector3(0.7f, 1.8f, 0.5f);
            t.localScale = scale;
        }

        // Face the way he FELL, not the way he stood: a man ridden down goes
        // over along the truck's line, not his own.
        bool thrown = knock.sqrMagnitude > 0.01f;
        float faceYaw = thrown ? Mathf.Atan2(knock.x, knock.y) : heading;
        var upright = Quaternion.Euler(0f, faceYaw * Mathf.Rad2Deg, 0f);
        // onto his face, with a little roll so a row of dead is not a row of
        // identical dead
        var flat = upright * Quaternion.Euler(thrown ? 92f : 76f, 0f, Random.Range(-25f, 25f));

        t.SetPositionAndRotation(at, upright);
        _live.Add(new Piece
        {
            t = t, life = thrown ? 7f : 5f, baseScale = scale, kind = Kind.Body,
            isModelBody = model, bull = bull,
            fallFrom = upright, fallTo = flat,
            slide = thrown ? new Vector3(knock.x, 0f, knock.y) * 4.5f : Vector3.zero,
            from = at,
        });
    }

    /// <summary>
    /// A tinted soldier model for the dead, pooled - instantiating a skinned
    /// mesh per casualty is not free, and there is about one a second.
    /// </summary>
    Transform TakeBody(bool bull)
    {
        var pool = _bodyPool[bull];
        if (pool.Count > 0)
        {
            var reused = pool.Pop();
            reused.gameObject.SetActive(true);
            return reused;
        }

        var wrapper = new GameObject("Body");
        wrapper.transform.SetParent(transform, false);
        var body = Instantiate(bodyPrefab, wrapper.transform);

        var renderers = body.GetComponentsInChildren<Renderer>(true);
        if (renderers.Length > 0)
        {
            Bounds B()
            {
                var b = renderers[0].bounds;
                foreach (var r in renderers) b.Encapsulate(r.bounds);
                return b;
            }
            var bounds = B();
            if (bounds.size.y > 0.0001f)
                body.transform.localScale = Vector3.one * (bodyHeight / bounds.size.y);
            bounds = B();
            float sole = wrapper.transform.InverseTransformPoint(
                new Vector3(bounds.center.x, bounds.min.y, bounds.center.z)).y;
            body.transform.localPosition = new Vector3(0f, -sole, 0f);
        }

        var tint = bull ? bullMaterial : bearMaterial;
        foreach (var r in body.GetComponentsInChildren<Renderer>(true))
        {
            var mats = new Material[r.sharedMaterials.Length];
            for (int i = 0; i < mats.Length; i++) mats[i] = tint;
            r.sharedMaterials = mats;
        }
        // the dead hold their last pose rather than jogging on the ground
        foreach (var a in body.GetComponentsInChildren<Animator>(true)) Destroy(a);
        foreach (var c in body.GetComponentsInChildren<Collider>(true)) Destroy(c);
        return wrapper.transform;
    }

    ParticleSystem _fire, _smoke;

    /// <summary>
    /// A pooled particle system playing the pack's fire flipbook.
    ///
    /// Built in code rather than taken from the pack's own prefabs: those are
    /// Visual Effect Graph, which needs compute shaders and therefore does not
    /// run in WebGL at all - it would draw nothing in the build while looking
    /// right in the editor. A classic particle system does run there, and the
    /// artwork that matters is the flipbook, which is just a texture.
    /// </summary>
    ParticleSystem FireSystem()
    {
        if (_fire != null) return _fire;
        if (fireParticleMaterial == null) return null;

        var go = new GameObject("FireParticles");
        go.transform.SetParent(transform, false);
        _fire = go.AddComponent<ParticleSystem>();
        // AddComponent starts it immediately, and a playing system refuses to
        // have its duration set - Unity asserts rather than ignoring it.
        _fire.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);

        var main = _fire.main;
        main.duration = 1f;
        main.loop = false;
        main.playOnAwake = false;
        main.startLifetime = new ParticleSystem.MinMaxCurve(0.5f, 0.95f);
        main.startSpeed = new ParticleSystem.MinMaxCurve(2.5f, 7f);
        main.startSize = new ParticleSystem.MinMaxCurve(4f, 9f);
        main.startRotation = new ParticleSystem.MinMaxCurve(0f, Mathf.PI * 2f);
        main.gravityModifier = -0.12f;                  // fire lifts
        main.maxParticles = 300;
        main.simulationSpace = ParticleSystemSimulationSpace.World;

        var emission = _fire.emission;
        emission.enabled = true;
        emission.rateOverTime = 0f;                     // bursts only

        var shape = _fire.shape;
        shape.enabled = true;
        shape.shapeType = ParticleSystemShapeType.Sphere;
        shape.radius = 1.6f;

        // the flipbook: play the whole sheet once over each particle's life
        var sheet = _fire.textureSheetAnimation;
        sheet.enabled = true;
        sheet.numTilesX = flipbookTiles.x;
        sheet.numTilesY = flipbookTiles.y;
        sheet.animation = ParticleSystemAnimationType.WholeSheet;
        sheet.timeMode = ParticleSystemAnimationTimeMode.Lifetime;
        sheet.frameOverTime = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 0f, 1f, 1f));
        sheet.cycleCount = 1;

        var size = _fire.sizeOverLifetime;
        size.enabled = true;
        size.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.EaseInOut(0f, 0.55f, 1f, 1.35f));

        var renderer = go.GetComponent<ParticleSystemRenderer>();
        renderer.material = fireParticleMaterial;
        renderer.renderMode = ParticleSystemRenderMode.Billboard;
        renderer.alignment = ParticleSystemRenderSpace.View;
        renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        renderer.receiveShadows = false;
        return _fire;
    }

    /// <summary>
    /// Smoke as flipbook particles.
    ///
    /// It used to be opaque spheres at 17% grey, which from above are not
    /// clouds but holes in the field - the black circles that kept getting
    /// reported. A texture with an alpha edge reads as smoke; a solid ball
    /// never will, whatever colour it is.
    /// </summary>
    ParticleSystem SmokeSystem()
    {
        if (_smoke != null) return _smoke;
        if (smokeParticleMaterial == null) return null;

        var go = new GameObject("SmokeParticles");
        go.transform.SetParent(transform, false);
        _smoke = go.AddComponent<ParticleSystem>();
        _smoke.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);

        var main = _smoke.main;
        main.duration = 1f;
        main.loop = false;
        main.playOnAwake = false;
        main.startLifetime = new ParticleSystem.MinMaxCurve(2.2f, 4.5f);
        main.startSpeed = new ParticleSystem.MinMaxCurve(1.2f, 3f);
        main.startSize = new ParticleSystem.MinMaxCurve(5f, 11f);
        main.startRotation = new ParticleSystem.MinMaxCurve(0f, Mathf.PI * 2f);
        main.startColor = new ParticleSystem.MinMaxGradient(
            new Color(0.42f, 0.40f, 0.38f, 0.85f), new Color(0.62f, 0.60f, 0.57f, 0.7f));
        main.gravityModifier = -0.25f;                 // smoke rises
        main.maxParticles = 300;
        main.simulationSpace = ParticleSystemSimulationSpace.World;

        var emission = _smoke.emission;
        emission.enabled = true;
        emission.rateOverTime = 0f;

        var shape = _smoke.shape;
        shape.enabled = true;
        shape.shapeType = ParticleSystemShapeType.Sphere;
        shape.radius = 1.8f;

        var sheet = _smoke.textureSheetAnimation;
        sheet.enabled = true;
        sheet.numTilesX = flipbookTiles.x;
        sheet.numTilesY = flipbookTiles.y;
        sheet.animation = ParticleSystemAnimationType.WholeSheet;
        sheet.timeMode = ParticleSystemAnimationTimeMode.Lifetime;
        sheet.frameOverTime = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 0f, 1f, 1f));
        sheet.cycleCount = 1;

        // swells as it drifts, and thins away instead of vanishing
        var size = _smoke.sizeOverLifetime;
        size.enabled = true;
        size.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 0.5f, 1f, 1.8f));

        var colour = _smoke.colorOverLifetime;
        colour.enabled = true;
        colour.color = new ParticleSystem.MinMaxGradient(new Gradient
        {
            colorKeys = new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
            alphaKeys = new[]
            {
                new GradientAlphaKey(0f, 0f), new GradientAlphaKey(1f, 0.15f),
                new GradientAlphaKey(0f, 1f),
            },
        });

        var renderer = go.GetComponent<ParticleSystemRenderer>();
        renderer.material = smokeParticleMaterial;
        renderer.renderMode = ParticleSystemRenderMode.Billboard;
        renderer.alignment = ParticleSystemRenderSpace.View;
        renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
        renderer.receiveShadows = false;
        return _smoke;
    }

    bool SmokeBurst(Vector3 at, int count)
    {
        var ps = SmokeSystem();
        if (ps == null) return false;
        ps.Emit(new ParticleSystem.EmitParams { position = at, applyShapeToPosition = true }, count);
        return true;
    }

    /// <summary>Fire the flipbook burst at a point. Returns false if there is no material for it.</summary>
    bool FlipbookBurst(Vector3 at, int count)
    {
        var ps = FireSystem();
        if (ps == null) return false;
        var p = new ParticleSystem.EmitParams { position = at, applyShapeToPosition = true };
        ps.Emit(p, count);
        return true;
    }

    /// <summary>
    /// A tank going up.
    ///
    /// Not one sphere. A shell cooking off a hull is a white core, a fireball
    /// that arrives in stages rather than all at once, a smoke column that
    /// outlives the flame, debris on ballistic arcs, and a ring of dust across
    /// the ground - and the burnt-out hull left behind. Any one of those on its
    /// own reads as a placeholder, which is exactly what the single orange
    /// sphere was.
    /// </summary>
    public void TankExplosion(Vector3 at, float heading)
    {
        // Real fire where the flipbook is available; the sphere version stays
        // as the fallback so the scene never depends on an imported pack.
        if (!FlipbookBurst(at + Vector3.up * 1.6f, 14))
        {
            Fireball(at + Vector3.up * 1.2f, 5.5f, fireCoreMaterial, 0f, 0.22f);
            for (int i = 0; i < 5; i++)
            {
                var off = new Vector3(Random.Range(-2.2f, 2.2f), Random.Range(0.4f, 3.4f), Random.Range(-2.2f, 2.2f));
                Fireball(at + off, Random.Range(4f, 7.5f), fireMaterial, i * 0.055f, Random.Range(0.4f, 0.7f));
            }
        }

        // smoke outlives the fire and keeps rising
        if (!SmokeBurst(at + Vector3.up * 2f, 10))
            for (int i = 0; i < 7; i++)
            {
                var off = new Vector3(Random.Range(-1.8f, 1.8f), Random.Range(1f, 3f), Random.Range(-1.8f, 1.8f));
                Smoke(at + off, Random.Range(3.5f, 6.5f), i * 0.12f);
            }

        // torn plate and road wheels thrown clear
        for (int i = 0; i < 12; i++)
        {
            float a = Random.Range(0f, Mathf.PI * 2f);
            var v = new Vector3(Mathf.Sin(a), 0f, Mathf.Cos(a)) * Random.Range(6f, 16f);
            v.y = Random.Range(7f, 15f);
            Debris(at + Vector3.up * 1.4f, v, Random.Range(0.3f, 0.8f));
        }

        Shockwave(at);
        WreckModel(at, heading);
    }

    void Fireball(Vector3 at, float size, Material mat, float delay, float life)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_spheres, _sphere, mat ?? blastMaterial);
        t.SetPositionAndRotation(at, Random.rotation);
        t.localScale = Vector3.zero;
        _live.Add(new Piece
        {
            t = t, life = delay + life, delay = delay,
            baseScale = Vector3.one * size, kind = Kind.Fireball,
        });
    }

    void Smoke(Vector3 at, float size, float delay)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_spheres, _sphere, smokeMaterial ?? blastMaterial);
        t.SetPositionAndRotation(at, Random.rotation);
        t.localScale = Vector3.zero;
        _live.Add(new Piece
        {
            t = t, life = delay + Random.Range(2.4f, 3.8f), delay = delay,
            baseScale = Vector3.one * size, kind = Kind.Smoke, from = at,
            velocity = new Vector3(Random.Range(-0.6f, 0.6f), Random.Range(2.2f, 3.6f), Random.Range(-0.6f, 0.6f)),
        });
    }

    void Debris(Vector3 at, Vector3 velocity, float size)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_cubes, _cube, debrisMaterial ?? blastMaterial);
        t.SetPositionAndRotation(at, Random.rotation);
        var scale = Vector3.one * size;
        t.localScale = scale;
        _live.Add(new Piece
        {
            t = t, life = Random.Range(1.4f, 2.4f), baseScale = scale, kind = Kind.Debris,
            from = at, velocity = velocity,
            spin = new Vector3(Random.Range(-720f, 720f), Random.Range(-720f, 720f), Random.Range(-720f, 720f)),
        });
    }

    /// <summary>
    /// Dust driven out across the ground.
    ///
    /// PALE. Built from the smoke material this was a near-black disc sitting
    /// on the field - which is not a shockwave, it is a hole. Kept low and
    /// thin, so it reads as dust rather than as an object.
    /// </summary>
    void Shockwave(Vector3 at)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_spheres, _sphere, dustMaterial ?? smokeMaterial ?? blastMaterial);
        t.SetPositionAndRotation(at + Vector3.up * 0.15f, Quaternion.identity);
        t.localScale = Vector3.zero;
        _live.Add(new Piece
        {
            t = t, life = 0.7f, baseScale = new Vector3(15f, 0.35f, 15f), kind = Kind.Shockwave,
        });
    }

    /// <summary>The burnt-out hull, using the real model where there is one.</summary>
    void WreckModel(Vector3 at, float heading)
    {
        if (_live.Count >= maxPieces) return;
        if (wreckPrefab == null) { Wreck(at, heading); return; }

        Transform t;
        if (_wreckPool.Count > 0) { t = _wreckPool.Pop(); t.gameObject.SetActive(true); }
        else
        {
            var wrapper = new GameObject("Wreck");
            wrapper.transform.SetParent(transform, false);
            var model = Instantiate(wreckPrefab, wrapper.transform);

            var rs = model.GetComponentsInChildren<Renderer>(true);
            if (rs.Length > 0)
            {
                Bounds B() { var b = rs[0].bounds; foreach (var r in rs) b.Encapsulate(r.bounds); return b; }
                var bounds = B();
                float across = Mathf.Min(bounds.size.x, bounds.size.z);
                if (across > 0.0001f) model.transform.localScale = Vector3.one * (wreckWidth / across);
                bounds = B();
                float sole = wrapper.transform.InverseTransformPoint(
                    new Vector3(bounds.center.x, bounds.min.y, bounds.center.z)).y;
                model.transform.localPosition = new Vector3(0f, -sole, 0f);
            }
            // charred: the same hull, burnt, rather than a differently coloured tank
            foreach (var r in model.GetComponentsInChildren<Renderer>(true))
            {
                var mats = new Material[r.sharedMaterials.Length];
                for (int i = 0; i < mats.Length; i++) mats[i] = debrisMaterial;
                r.sharedMaterials = mats;
            }
            foreach (var a in model.GetComponentsInChildren<Animator>(true)) Destroy(a);
            foreach (var c in model.GetComponentsInChildren<Collider>(true)) Destroy(c);
            t = wrapper.transform;
        }

        // Knocked askew, because a wreck does not sit square - but only
        // slightly: a big tilt lifts one end clear of the ground, which is what
        // made them look like they were standing in the air.
        t.SetPositionAndRotation(at, Quaternion.Euler(
            Random.Range(-3f, 3f), heading * Mathf.Rad2Deg + Random.Range(-18f, 18f), Random.Range(-3f, 3f)));
        t.localScale = Vector3.one;
        _live.Add(new Piece
        {
            t = t, life = 22f, baseScale = Vector3.one, kind = Kind.Wreck, isWreckModel = true,
        });
    }

    readonly Stack<Transform> _wreckPool = new Stack<Transform>();

    /// <summary>A burning hull, left where it died.</summary>
    public void Wreck(Vector3 at, float heading)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_cubes, _cube, blastMaterial);
        var scale = new Vector3(3.4f, 1.2f, 6.2f);
        t.localScale = scale;
        t.SetPositionAndRotation(at, Quaternion.Euler(0f, heading * Mathf.Rad2Deg, 0f));
        _live.Add(new Piece { t = t, life = 8f, baseScale = scale, kind = Kind.Wreck });
    }

    /* --------------------------------------------------------------- clock */

    void Update() => Step(Time.deltaTime);

    /// <summary>Public so a test can advance effects without waiting in real time.</summary>
    public void Step(float dt)
    {
        for (int i = _live.Count - 1; i >= 0; i--)
        {
            var p = _live[i];
            p.age += dt;
            if (p.age < p.delay) continue;                 // not lit yet
            float span = Mathf.Max(0.0001f, p.life - p.delay);
            float k = Mathf.Clamp01((p.age - p.delay) / span);

            switch (p.kind)
            {
                case Kind.Tracer:
                    // thins out rather than fading, so it needs no transparency
                    p.t.localScale = new Vector3(p.baseScale.x * (1f - k), p.baseScale.y * (1f - k), p.baseScale.z);
                    break;
                case Kind.Flash:
                    p.t.localScale = p.baseScale * (1f - k);
                    break;
                case Kind.Blast:
                    float grow = k < 0.35f ? Mathf.Lerp(0.2f, 1f, k / 0.35f) : Mathf.Lerp(1f, 0f, (k - 0.35f) / 0.65f);
                    p.t.localScale = p.baseScale * grow;
                    break;
                case Kind.Body:
                {
                    // topple over the first half second, then sink into the ground
                    p.t.rotation = Quaternion.Slerp(p.fallFrom, p.fallTo, Mathf.Clamp01(p.age / 0.55f));
                    // thrown bodies carry on along the line they were hit,
                    // slowing as they tumble
                    if (p.slide.sqrMagnitude > 0.001f)
                    {
                        float carried = 1f - Mathf.Exp(-3.2f * p.age);
                        p.t.position = p.from + p.slide * carried;
                    }
                    if (k > 0.8f)
                        p.t.localScale = p.baseScale * Mathf.Lerp(1f, 0f, (k - 0.8f) / 0.2f);
                    break;
                }
                case Kind.Wreck:
                {
                    // Re-seat it on the ground every frame. The terrain is
                    // rebuilt from live mempool data, so a hull left at the
                    // height it died at is soon standing in mid-air.
                    var wp = p.t.position;
                    p.t.position = new Vector3(wp.x, Ground(wp.x, wp.z), wp.z);
                    if (k > 0.85f) p.t.localScale = p.baseScale * Mathf.Lerp(1f, 0f, (k - 0.85f) / 0.15f);
                    break;
                }

                case Kind.Fireball:
                    // snaps open, then collapses in on itself
                    p.t.localScale = p.baseScale *
                        (k < 0.22f ? Mathf.Lerp(0.15f, 1f, k / 0.22f)
                                   : Mathf.Lerp(1f, 0f, (k - 0.22f) / 0.78f));
                    break;

                case Kind.Smoke:
                    // rises and swells while it thins away
                    p.t.position = p.from + p.velocity * (p.age - p.delay);
                    p.t.localScale = p.baseScale *
                        (k < 0.3f ? Mathf.Lerp(0.2f, 1f, k / 0.3f)
                                  : Mathf.Lerp(1f, 0.05f, (k - 0.3f) / 0.7f));
                    break;

                case Kind.Debris:
                {
                    // a real arc, so pieces land instead of drifting off
                    float t2 = p.age;
                    var pos = p.from + p.velocity * t2 + Vector3.up * (-9.81f * 0.5f * t2 * t2);
                    float floor = Ground(pos.x, pos.z) + p.baseScale.y * 0.5f;
                    if (pos.y < floor) { pos.y = floor; p.velocity = Vector3.zero; }
                    p.t.position = pos;
                    p.t.Rotate(p.spin * dt, Space.Self);
                    if (k > 0.7f) p.t.localScale = p.baseScale * Mathf.Lerp(1f, 0f, (k - 0.7f) / 0.3f);
                    break;
                }

                case Kind.Shockwave:
                    // flat and spreading: dust driven out, not a ball of fire
                    p.t.localScale = new Vector3(
                        p.baseScale.x * k, p.baseScale.y * (1f - k * 0.7f), p.baseScale.z * k);
                    break;
            }

            if (p.age >= p.life) { Retire(p); _live.RemoveAt(i); }
        }
    }

    public int LivePieces => _live.Count;

    /* ---------------------------------------------------------- army hooks */

    public void Bind(Army army)
    {
        army.Shot += (from, at) =>
        {
            var muzzle = new Vector3(from.x, Ground(from.x, from.z) + 1.5f, from.z);
            var impact = new Vector3(at.x, Ground(at.x, at.y) + 1.0f, at.y);
            Flash(muzzle, 0.5f);
            Tracer(muzzle, impact, tracerMaterial, 0.09f, 0.10f);
        };

        army.Fired += (from, at) =>
        {
            float yaw = from.turretYaw;
            var muzzle = new Vector3(
                from.x + Mathf.Sin(yaw) * 4.6f,
                Ground(from.x, from.z) + 2.1f,
                from.z + Mathf.Cos(yaw) * 4.6f);
            var impact = new Vector3(at.x, Ground(at.x, at.y) + 1.2f, at.y);
            Flash(muzzle, 1.6f);
            Tracer(muzzle, impact, tracerMaterial, 0.3f, 0.16f);
            Blast(impact, 4.5f);
        };

        army.Killed += (u, knock) =>
        {
            // a model body stands on the ground; the proxy box is centred
            float lift = bodyPrefab != null ? 0f : 0.9f;
            Body(new Vector3(u.x, Ground(u.x, u.z) + lift, u.z), u.heading,
                 u.side == Army.Side.Bull, knock);
        };

        army.Destroyed += v => TankExplosion(new Vector3(v.x, Ground(v.x, v.z), v.z), v.heading);
    }
}
