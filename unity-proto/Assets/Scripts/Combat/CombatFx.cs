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

    [Tooltip("Optional. Wrecks and bodies rest on the road deck where there " +
             "is one, not on the ground it is laid over.")]
    public RoadNetwork roads;
    [Tooltip("Told where wrecks stand, so units walk round them rather than through.")]
    public Army army;
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
        /// <summary>Set when the body is being thrown by the physics engine.</summary>
        public Rigidbody body;
        /// <summary>Countdown to the next puff of flame from a burning wreck.</summary>
        public float burnAt;
        /// <summary>
        /// How high above the ground this body came to rest. The terrain is
        /// rebuilt from live mempool data, so a body pinned at the absolute
        /// height it died at is buried by the next fee update - the same thing
        /// wrecks are re-seated for. Held as an OFFSET rather than re-seated
        /// flat, so a body that settled half on its side is not teleported.
        /// NaN until he has come to rest.
        /// </summary>
        public float restOffset = float.NaN;
        /// <summary>Index into Army.Wrecks, or -1. Released when the hull fades.</summary>
        public int wreckIndex = -1;
        /// <summary>Held at zero scale until this much of its life has passed.</summary>
        public float delay;
        public Vector3 velocity, spin;
    }

    enum Kind { Tracer, Flash, Blast, Body, Wreck, Fireball, Smoke, Debris, Shockwave }

    /// <summary>
    /// Corpses collide with the ground and nothing else. They must not shove
    /// the truck that hit them, nor knock the living about.
    /// </summary>
    public const int CorpseLayer = 9;

    /// <summary>
    /// The player's vehicle, on its own layer.
    ///
    /// Corpses already ignore the units, but the truck sat on the default layer
    /// with the terrain - so a 75 kg body appearing inside it was resolved by
    /// throwing the truck into the air. It has to be excluded by name, not by
    /// being lumped in with the ground it drives on.
    /// </summary>
    public const int CourierLayer = 10;

    /// <summary>Pooled soldier models for the dead, kept per side so the tint holds.</summary>
    readonly Dictionary<bool, Stack<Transform>> _bodyPool = new Dictionary<bool, Stack<Transform>>
    {
        { true, new Stack<Transform>() }, { false, new Stack<Transform>() },
    };

    readonly List<Piece> _live = new List<Piece>();

    /// <summary>Effects currently alive. Public so a test can see that
    /// something was actually spawned rather than trusting the call.</summary>
    public int LiveCount => _live.Count;
    readonly Stack<Transform> _cubes = new Stack<Transform>();
    readonly Stack<Transform> _spheres = new Stack<Transform>();
    Mesh _cube, _sphere;

    /// <summary>
    /// Hard ceiling. Thirty rifle shots a second across the field would
    /// otherwise pile up unbounded if anything ever stopped retiring them.
    /// </summary>
    public int maxPieces = 400;

    bool _layersSet;

    /// <summary>
    /// Kept out of Awake: edit-mode tests never run it, so a rule set only
    /// there is a rule the tests cannot see and the build silently depends on.
    /// </summary>
    void EnsureLayers()
    {
        if (_layersSet) return;
        _layersSet = true;
        Physics.IgnoreLayerCollision(CorpseLayer, CorpseLayer, true);
        Physics.IgnoreLayerCollision(CorpseLayer, ArmyRenderer.UnitLayer, true);
        Physics.IgnoreLayerCollision(CorpseLayer, CourierLayer, true);
    }

    void Awake()
    {
        EnsureLayers();
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

    static PhysicsMaterial _corpseFriction;

    /// <summary>
    /// Grippy and dead. Without it a body slides and rolls down every slope it
    /// lands on - the default material is far too slippery for something that
    /// is meant to stay where it fell.
    /// </summary>
    static PhysicsMaterial CorpseFriction()
    {
        if (_corpseFriction != null) return _corpseFriction;
        _corpseFriction = new PhysicsMaterial("Corpse")
        {
            dynamicFriction = 0.95f,
            staticFriction = 0.95f,
            bounciness = 0f,
            frictionCombine = PhysicsMaterialCombine.Maximum,
            bounceCombine = PhysicsMaterialCombine.Minimum,
        };
        return _corpseFriction;
    }

    static void SetLayer(GameObject go, int layer)
    {
        go.layer = layer;
        foreach (Transform c in go.transform) SetLayer(c.gameObject, layer);
    }

    void Add(Piece p)
    {
        TotalSpawned++;
        _live.Add(p);
    }

    void Retire(Piece p)
    {
        // the ground is free again once the hull has gone
        if (p.wreckIndex >= 0 && army != null && p.wreckIndex < army.Wrecks.Count)
            army.Wrecks[p.wreckIndex] = new Vector3(0f, 0f, 0f);

        // park the body before pooling, or it carries its last tumble into the
        // next man who dies
        if (p.body != null)
        {
            p.body.linearVelocity = Vector3.zero;
            p.body.angularVelocity = Vector3.zero;
            p.body.isKinematic = true;
        }
        p.t.gameObject.SetActive(false);
        if (p.isModelBody) { _bodyPool[p.bull].Push(p.t); return; }
        if (p.isWreckModel) { _wreckPool.Push(p.t); return; }
        var mf = p.t.GetComponent<MeshFilter>();
        if (mf == null) return;                       // a model wrapper, not a primitive
        (mf.sharedMesh == _sphere ? _spheres : _cubes).Push(p.t);
    }

    float Ground(float x, float z) =>
        roads != null ? roads.SurfaceHeight(x, z)
                      : (terrain != null ? terrain.SampleSurface(x, z) : 0f);

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
        Add(new Piece { t = t, life = life, baseScale = scale, kind = Kind.Tracer });
    }

    public void Flash(Vector3 at, float size)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_spheres, _sphere, flashMaterial);
        t.SetPositionAndRotation(at, Quaternion.identity);
        var scale = Vector3.one * size;
        t.localScale = scale;
        Add(new Piece { t = t, life = 0.09f, baseScale = scale, kind = Kind.Flash });
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
        EnsureLayers();

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

        // Someone ridden down is THROWN, not slid along a curve. A scripted
        // slide is what made it look like an object being dragged rather than a
        // man being hit: the arc is identical every time, it ignores the ground
        // it crosses, and it cannot bounce or roll to a stop.
        Rigidbody rb = null;
        if (thrown)
        {
            rb = t.GetComponent<Rigidbody>();
            if (rb == null)
            {
                // A BOX, not a capsule. A capsule is a barrel on its side: it
                // rolls, and on a slope it rolls for tens of metres, which is
                // what made a run-over look like a dropped log.
                var col = t.gameObject.AddComponent<BoxCollider>();
                col.size = new Vector3(0.55f, 1.7f, 0.4f);
                col.center = new Vector3(0f, 0.85f, 0f);
                col.material = CorpseFriction();

                rb = t.gameObject.AddComponent<Rigidbody>();
                rb.mass = 75f;
                rb.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;
                // A body is not a ball. Heavy angular damping is what stops it
                // spinning on and on once it is down.
                rb.angularDamping = 6f;
                rb.linearDamping = 0.4f;
                SetLayer(t.gameObject, CorpseLayer);
            }
            rb.isKinematic = false;
            rb.linearVelocity = new Vector3(knock.x, 0f, knock.y) * Random.Range(5f, 8f)
                              + Vector3.up * Random.Range(3f, 4.5f);
            // over once or twice, not a cartwheel down the field
            rb.angularVelocity = new Vector3(
                Random.Range(-5f, 5f), Random.Range(-2f, 2f), Random.Range(-5f, 5f));
        }

        Add(new Piece
        {
            t = t, life = thrown ? 9f : 5f, baseScale = scale, kind = Kind.Body,
            isModelBody = model, bull = bull, body = rb,
            fallFrom = upright, fallTo = flat,
            from = at,
        });
    }

    /// <summary>
    /// The moment of the hit: a short spray thrown along the line of travel.
    /// Without it a man simply changes from standing to lying, and the blow
    /// itself - the thing that killed him - is invisible.
    /// </summary>
    void Impact(Vector3 at, Vector2 knock)
    {
        for (int i = 0; i < 6; i++)
        {
            var v = new Vector3(knock.x, 0f, knock.y) * Random.Range(3f, 8f)
                  + new Vector3(Random.Range(-2f, 2f), Random.Range(2f, 5f), Random.Range(-2f, 2f));
            Debris(at, v, Random.Range(0.06f, 0.12f));
        }
    }

    readonly Dictionary<Material, Material> _corpseMaterials = new Dictionary<Material, Material>();

    /// <summary>A URP material carrying the model's own texture, dimmed.</summary>
    Material CorpseMaterial(Material source, Color shade)
    {
        if (source != null && _corpseMaterials.TryGetValue(source, out var hit)) return hit;

        var shader = Shader.Find("Universal Render Pipeline/Lit");
        if (shader == null) return source;
        var m = new Material(shader);
        Texture tex = source == null ? null
            : source.HasProperty("_BaseMap") ? source.GetTexture("_BaseMap")
            : source.HasProperty("_MainTex") ? source.GetTexture("_MainTex")
            : null;
        if (tex != null) m.SetTexture("_BaseMap", tex);
        m.SetColor("_BaseColor", shade);
        m.SetFloat("_Smoothness", 0.1f);          // dirt does not shine
        if (source != null) _corpseMaterials[source] = m;
        return m;
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

        // Keep the model's own texture, darkened.
        //
        // Replacing it with the flat team material made a body BRIGHTER the
        // moment it died - the one thing a corpse should not do. The tint is
        // multiplied in and pulled well down, so he reads as the man he was,
        // face down in the dirt.
        var tint = bull ? bullMaterial : bearMaterial;
        Color shade = tint != null ? tint.GetColor("_BaseColor") : Color.white;
        shade = new Color(shade.r * 0.5f, shade.g * 0.5f, shade.b * 0.5f, 1f);
        foreach (var r in body.GetComponentsInChildren<Renderer>(true))
        {
            var mats = new Material[r.sharedMaterials.Length];
            for (int i = 0; i < mats.Length; i++) mats[i] = CorpseMaterial(r.sharedMaterials[i], shade);
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

    bool SmokeBurst(Vector3 at, int count, float lifetime = 0f)
    {
        var ps = SmokeSystem();
        if (ps == null) return false;
        var p = new ParticleSystem.EmitParams { position = at, applyShapeToPosition = true };
        if (lifetime > 0f)
        {
            p.startLifetime = lifetime;
            p.velocity = new Vector3(Random.Range(-0.5f, 0.5f), Random.Range(1.4f, 2.4f), Random.Range(-0.5f, 0.5f));
        }
        ps.Emit(p, count);
        return true;
    }

    /// <summary>Fire the flipbook burst at a point. Returns false if there is no material for it.</summary>
    /// <param name="lifetime">
    /// Seconds per particle, which is also how long the flipbook takes to play.
    /// A detonation wants half a second; a hull burning for twenty wants three,
    /// or the same sheet races through and reads as a strobe rather than a fire.
    /// </param>
    bool FlipbookBurst(Vector3 at, int count, float lifetime = 0f)
    {
        var ps = FireSystem();
        if (ps == null) return false;
        var p = new ParticleSystem.EmitParams { position = at, applyShapeToPosition = true };
        if (lifetime > 0f)
        {
            p.startLifetime = lifetime;
            p.startSize = Random.Range(2f, 4f);
            p.velocity = new Vector3(Random.Range(-0.4f, 0.4f), Random.Range(0.7f, 1.6f), Random.Range(-0.4f, 0.4f));
        }
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

        // Splinters, not crates. At up to 0.8 across in near-black these read
        // across the field as black rectangles flying about - which is what
        // they were reported as. Small enough to be debris, and light enough to
        // catch the sun rather than silhouette against it.
        for (int i = 0; i < 10; i++)
        {
            float a = Random.Range(0f, Mathf.PI * 2f);
            var v = new Vector3(Mathf.Sin(a), 0f, Mathf.Cos(a)) * Random.Range(6f, 16f);
            v.y = Random.Range(7f, 15f);
            Debris(at + Vector3.up * 1.4f, v, Random.Range(0.12f, 0.3f));
        }

        // and sparks, which is what actually reads at a distance
        for (int i = 0; i < 14; i++)
        {
            float a = Random.Range(0f, Mathf.PI * 2f);
            var v = new Vector3(Mathf.Sin(a), 0f, Mathf.Cos(a)) * Random.Range(9f, 22f);
            v.y = Random.Range(6f, 18f);
            Spark(at + Vector3.up * 1.6f, v);
        }

        Shockwave(at);
        WreckModel(at, heading);
    }

    /// <summary>
    /// The blast only, with no hull left behind.
    ///
    /// TankExplosion finishes by dropping a wreck model, and that model is the
    /// tank. Used for the player's truck it turned the truck into a tank the
    /// moment it died. The truck keeps its own body and burns where it stands,
    /// so it needs the bang without the tank.
    /// </summary>
    public void VehicleExplosion(Vector3 at)
    {
        if (!FlipbookBurst(at + Vector3.up * 1.4f, 10))
        {
            Fireball(at + Vector3.up * 1.1f, 4.5f, fireCoreMaterial, 0f, 0.22f);
            for (int i = 0; i < 4; i++)
                Fireball(at + Vector3.up * Random.Range(0.6f, 2.6f), Random.Range(2f, 3.4f),
                         fireMaterial, Random.Range(0.02f, 0.16f), 0.4f);
        }
        for (int i = 0; i < 10; i++)
        {
            float a = Random.Range(0f, Mathf.PI * 2f);
            var v = new Vector3(Mathf.Sin(a), 0f, Mathf.Cos(a)) * Random.Range(7f, 17f);
            v.y = Random.Range(5f, 14f);
            Spark(at + Vector3.up * 1.4f, v);
        }
        Shockwave(at);
    }

    /// <summary>
    /// One beat of a burning hull. Public so something that is NOT a wreck
    /// piece - the player's truck, which stays put and keeps its own model -
    /// burns with exactly the same fire rather than a second imitation of it.
    /// </summary>
    public void BurnBeat(Vector3 at, float vigour)
    {
        var seat = at + Vector3.up * 1.4f;
        var jitter = new Vector3(Random.Range(-0.9f, 0.9f), 0f, Random.Range(-1.3f, 1.3f));

        // Slow. A hull burns for a long time; the same flipbook at explosion
        // speed reads as a strobe on a wreck.
        if (vigour > 0.02f && !FlipbookBurst(seat + jitter, 1, Random.Range(2.4f, 4f)))
            Fireball(seat + jitter, Mathf.Lerp(0.6f, 2.8f, vigour), fireMaterial, 0f, 1.4f);

        if (!SmokeBurst(seat + Vector3.up * 1.4f, 1, Random.Range(4f, 7f)))
            Smoke(seat + Vector3.up * 1.4f, Mathf.Lerp(1.5f, 3.5f, vigour), 0f);
    }

    void Fireball(Vector3 at, float size, Material mat, float delay, float life)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_spheres, _sphere, mat ?? blastMaterial);
        t.SetPositionAndRotation(at, Random.rotation);
        t.localScale = Vector3.zero;
        Add(new Piece
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
        Add(new Piece
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
        Add(new Piece
        {
            t = t, life = Random.Range(1.4f, 2.4f), baseScale = scale, kind = Kind.Debris,
            from = at, velocity = velocity,
            spin = new Vector3(Random.Range(-720f, 720f), Random.Range(-720f, 720f), Random.Range(-720f, 720f)),
        });
    }

    /// <summary>
    /// A spark: small, bright and short-lived. Debris tells you something broke;
    /// sparks are what actually carry an explosion across a distance.
    /// </summary>
    void Spark(Vector3 at, Vector3 velocity)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_cubes, _cube, fireCoreMaterial ?? tracerMaterial);
        t.SetPositionAndRotation(at, Random.rotation);
        var scale = new Vector3(0.08f, 0.08f, Random.Range(0.4f, 0.9f));
        t.localScale = scale;
        Add(new Piece
        {
            t = t, life = Random.Range(0.5f, 1.0f), baseScale = scale, kind = Kind.Debris,
            from = at, velocity = velocity,
            spin = new Vector3(Random.Range(-200f, 200f), Random.Range(-200f, 200f), 0f),
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
        Add(new Piece
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
        GiveWreckASolidBody(t.gameObject);
        t.localScale = Vector3.one;
        var piece = new Piece
        {
            t = t, life = 25f, baseScale = Vector3.one, kind = Kind.Wreck, isWreckModel = true,
            burnAt = 0.2f, wreckIndex = ClaimWreckSlot(at),
        };
        Add(piece);
    }

    readonly Stack<Transform> _wreckPool = new Stack<Transform>();

    /// <summary>
    /// Tell the army a hull is standing here. Physics stops the truck, but the
    /// units are moved by logic and would walk straight through otherwise.
    /// </summary>
    int ClaimWreckSlot(Vector3 at)
    {
        if (army == null) return -1;
        army.Wrecks.Add(new Vector3(at.x, at.z, 4.2f));
        return army.Wrecks.Count - 1;
    }

    /// <summary>
    /// Wrecks block. A burnt-out hull that everything drives through is a
    /// picture lying on the ground, and it removes the one interesting thing a
    /// destroyed tank leaves behind: an obstacle in the middle of the field.
    /// </summary>
    static void GiveWreckASolidBody(GameObject go)
    {
        // Marked, because it is the only way to tell a burnt-out hull from a
        // live tank at a collision: both are solid and both sit on the unit
        // layer. Driving into a wreck must not be fatal.
        if (go.GetComponent<BurntOutHull>() == null) go.AddComponent<BurntOutHull>();
        if (go.GetComponent<BoxCollider>() != null) return;
        var box = go.AddComponent<BoxCollider>();
        box.size = new Vector3(3.6f, 2.2f, 7f);
        box.center = new Vector3(0f, 1.1f, 0f);
        var rb = go.AddComponent<Rigidbody>();
        rb.isKinematic = true;
        rb.useGravity = false;
        SetLayer(go, ArmyRenderer.UnitLayer);
    }

    /// <summary>A burning hull, left where it died.</summary>
    public void Wreck(Vector3 at, float heading)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_cubes, _cube, debrisMaterial ?? blastMaterial);
        var scale = new Vector3(3.4f, 1.2f, 6.2f);
        t.localScale = scale;
        t.SetPositionAndRotation(at, Quaternion.Euler(0f, heading * Mathf.Rad2Deg, 0f));
        GiveWreckASolidBody(t.gameObject);
        // Same life and same burn as the model wreck. They used to differ - 8
        // seconds and no fire against 40 and burning - so the fallback path
        // quietly behaved like a different feature.
        Add(new Piece
        {
            t = t, life = 25f, baseScale = scale, kind = Kind.Wreck, burnAt = 0.2f,
            wreckIndex = ClaimWreckSlot(at),
        });
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
                    if (p.body != null)
                    {
                        // The engine owns the throw - but once he has come to
                        // rest, take him back. Left dynamic he keeps creeping
                        // down whatever slope he landed on, and a body that
                        // slides away on its own is worse than one that never
                        // moved.
                        if (!p.body.isKinematic && p.age > 0.6f
                            && p.body.linearVelocity.sqrMagnitude < 0.35f
                            && p.body.angularVelocity.sqrMagnitude < 0.6f)
                        {
                            p.body.isKinematic = true;
                            var rp = p.t.position;
                            p.restOffset = rp.y - Ground(rp.x, rp.z);
                        }
                        // once he is kinematic nothing holds him on the ground
                        // any more, so carry him with it
                        if (p.body.isKinematic && !float.IsNaN(p.restOffset))
                        {
                            var bp = p.t.position;
                            p.t.position = new Vector3(
                                bp.x, Ground(bp.x, bp.z) + p.restOffset, bp.z);
                        }
                        if (k > 0.88f)
                            p.t.localScale = p.baseScale * Mathf.Lerp(1f, 0f, (k - 0.88f) / 0.12f);
                        break;
                    }
                    // shot where he stood: fold over, then sink away - and ride
                    // the ground while he does it
                    if (float.IsNaN(p.restOffset))
                    {
                        var sp0 = p.t.position;
                        p.restOffset = sp0.y - Ground(sp0.x, sp0.z);
                    }
                    var sp = p.t.position;
                    p.t.position = new Vector3(sp.x, Ground(sp.x, sp.z) + p.restOffset, sp.z);
                    p.t.rotation = Quaternion.Slerp(p.fallFrom, p.fallTo, Mathf.Clamp01(p.age / 0.55f));
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

                    // It burns. A hull that stops smoking the instant the
                    // fireball clears reads as scenery dropped on the field
                    // rather than as something that was just destroyed - and
                    // the fire is what tells you which wrecks are fresh.
                    // Burns STEADILY. Rolling a die every half second for
                    // whether there is fire at all is what made it flicker on
                    // and off; a fire that stops and restarts is not a fire.
                    // It emits on a short, fixed beat and fades by making each
                    // puff smaller, not by skipping them.
                    p.burnAt -= dt;
                    if (p.burnAt <= 0f)
                    {
                        p.burnAt = 0.12f;
                        BurnBeat(p.t.position, Mathf.Clamp01(1f - k * 1.15f));
                    }

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

    /// <summary>
    /// Every piece ever created. Exposed because the live count cannot show
    /// cadence: while things are retiring at the rate they are spawned it does
    /// not move, so it cannot tell a steady fire from a stopped one.
    /// </summary>
    public int TotalSpawned { get; private set; }

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
            // a hit you can see, so a casualty is not just a model changing state
            if (knock.sqrMagnitude > 0.01f)
                Impact(new Vector3(u.x, Ground(u.x, u.z) + 1f, u.z), knock);
            // a model body stands on the ground; the proxy box is centred
            float lift = bodyPrefab != null ? 0f : 0.9f;
            Body(new Vector3(u.x, Ground(u.x, u.z) + lift, u.z), u.heading,
                 u.side == Army.Side.Bull, knock);
        };

        army.Destroyed += v => TankExplosion(new Vector3(v.x, Ground(v.x, v.z), v.z), v.heading);

        // A bomb is not a tank going up. Everything is bigger and there is more
        // of it, because the whole point of a gunship is that it outweighs
        // anything on the ground.
        army.Bombed += at =>
        {
            var p = new Vector3(at.x, Ground(at.x, at.y), at.y);
            if (!FlipbookBurst(p + Vector3.up * 3f, 26, 1.1f))
            {
                Fireball(p + Vector3.up * 2f, 11f, fireCoreMaterial, 0f, 0.3f);
                for (int i = 0; i < 8; i++)
                    Fireball(p + new Vector3(Random.Range(-5f, 5f), Random.Range(1f, 7f), Random.Range(-5f, 5f)),
                             Random.Range(7f, 13f), fireMaterial, i * 0.05f, Random.Range(0.6f, 1f));
            }
            if (!SmokeBurst(p + Vector3.up * 5f, 16, Random.Range(5f, 9f)))
                for (int i = 0; i < 10; i++)
                    Smoke(p + new Vector3(Random.Range(-3f, 3f), Random.Range(2f, 6f), Random.Range(-3f, 3f)),
                          Random.Range(6f, 10f), i * 0.1f);

            for (int i = 0; i < 22; i++)
            {
                float a = Random.Range(0f, Mathf.PI * 2f);
                var v = new Vector3(Mathf.Sin(a), 0f, Mathf.Cos(a)) * Random.Range(10f, 26f);
                v.y = Random.Range(10f, 24f);
                if (i % 2 == 0) Spark(p + Vector3.up * 2f, v);
                else Debris(p + Vector3.up * 2f, v, Random.Range(0.15f, 0.4f));
            }
            Shockwave(p);
        };
    }
}
