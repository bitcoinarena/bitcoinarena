// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
        /// wrecks are set down again for. Held as an OFFSET rather than set down again
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

    /// <summary>
    /// A liquidation WIPES its radius. Everything burnt still standing inside
    /// the hole goes, and its slot in `Army.Wrecks` with it, so the ground the
    /// blast just opened is not furnished with the last battle.
    ///
    /// WHAT MARKS A WRECK HERE IS `BurntOutHull`, not the wreck slot. The
    /// first cut keyed on `wreckIndex >= 0` and wiped nothing at all on the
    /// running build: `ClaimWreckSlot` returns -1 when `army` is null, and
    /// `army` is never assigned anywhere - the C# Army is retired, which is
    /// what the eleven red PlayMode tests are about. Every hull therefore
    /// carries index -1 and that filter threw them all away.
    ///
    /// `Retire` still releases the slot when there is one, so this stays
    /// correct if `Army.Wrecks` is ever live again. The core has no word for a
    /// wreck: `army.js` says so where it pushes LIVE units out of a crater,
    /// "the WRECKS stay out". So there is no core list to wipe and none is
    /// invented here; live units are the core's business and are not touched.
    ///
    /// Returns how many went, so the caller can say it rather than assume it.
    /// </summary>
    public int ClearWrecksIn(Vector3 at, float radius)
    {
        int gone = 0;
        float r2 = radius * radius;
        for (int i = _live.Count - 1; i >= 0; i--)
        {
            var p = _live[i];
            if (p.t == null || p.t.GetComponent<BurntOutHull>() == null) continue;
            var q = p.t.position;
            float dx = q.x - at.x, dz = q.z - at.z;
            if (dx * dx + dz * dz > r2) continue;
            Retire(p);
            _live.RemoveAt(i);
            gone++;
        }
        return gone;
    }

    float Ground(float x, float z) =>
        roads != null ? roads.SurfaceHeight(x, z)
                      : (Arena.ArenaCore.HasSurface ? Arena.ArenaCore.SurfaceAt(x, z)
                                                  : (terrain != null ? terrain.SampleSurface(x, z) : 0f));

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
        StillBody(body);
        return wrapper.transform;
    }

    // THE DEAD ARE NOT SKINNED: WebGL skins on the CPU, every visible SkinnedMeshRenderer, every frame - and a
    // body never moves. In a named profile of the 7 s after 100 % (Pixel 7a profile, 10x CPU) Unity's skinned-mesh update was
    // 590-629 ms, DeformSkinnedMesh 438-501 ms. A body is the raw soldier prefab with no controller, so each holds the same
    // stored pose: that pose is baked once per mesh, and a body draws it as an ordinary mesh with its own materials.
    readonly Dictionary<Mesh, Mesh> _stillPose = new Dictionary<Mesh, Mesh>();
    void StillBody(GameObject body)
    {
        foreach (var smr in body.GetComponentsInChildren<SkinnedMeshRenderer>(true))
        {
            if (smr.sharedMesh == null) continue;
            if (!_stillPose.TryGetValue(smr.sharedMesh, out var still))
            {
                still = new Mesh { name = smr.sharedMesh.name + " (still)" };
                smr.BakeMesh(still);
                still.RecalculateBounds();
                _stillPose[smr.sharedMesh] = still;
            }
            var go = smr.gameObject;
            var mats = smr.sharedMaterials;
            var cast = smr.shadowCastingMode; bool receive = smr.receiveShadows; bool on = smr.enabled;
            DestroyImmediate(smr);
            go.AddComponent<MeshFilter>().sharedMesh = still;
            var mr = go.AddComponent<MeshRenderer>();
            mr.sharedMaterials = mats; mr.shadowCastingMode = cast; mr.receiveShadows = receive; mr.enabled = on;
        }
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
        var resting = at + Vector3.up * 1.4f;
        var jitter = new Vector3(Random.Range(-0.9f, 0.9f), 0f, Random.Range(-1.3f, 1.3f));

        // Slow. A hull burns for a long time; the same flipbook at explosion
        // speed reads as a strobe on a wreck.
        if (vigour > 0.02f && !FlipbookBurst(resting + jitter, 1, Random.Range(2.4f, 4f)))
            Fireball(resting + jitter, Mathf.Lerp(0.6f, 2.8f, vigour), fireMaterial, 0f, 1.4f);

        if (!SmokeBurst(resting + Vector3.up * 1.4f, 1, Random.Range(4f, 7f)))
            Smoke(resting + Vector3.up * 1.4f, Mathf.Lerp(1.5f, 3.5f, vigour), 0f);
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
        // ONE SIZE ABOVE THE BLAST POINT, not centred on it (2026-09-16 12:38, "black cube through
        // the road"). The blast point is on the road, so a chunk centred there started half inside it and
        // below its own resting height - measured on this rule, most chunks "landed" on their first frame,
        // right at the centre of the blast.
        var start = at + Vector3.up * size;
        t.SetPositionAndRotation(start, Random.rotation);
        var scale = Vector3.one * size;
        t.localScale = scale;
        Add(new Piece
        {
            t = t, life = Random.Range(1.4f, 2.4f), baseScale = scale, kind = Kind.Debris,
            from = start, velocity = velocity,
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
            t = t, life = 30f, baseScale = Vector3.one, kind = Kind.Wreck, isWreckModel = true,
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
            t = t, life = 30f, baseScale = scale, kind = Kind.Wreck, burnAt = 0.2f,
            wreckIndex = ClaimWreckSlot(at),
        });
    }

    /* --------------------------------------------------------------- clock */

    void Update()
    {
        if (Arena.ArenaCore.Available) PollCore();
        Step(Time.deltaTime);
    }

    // ---- what the core did this tick ------------------------------------
    //
    // The five things `Bind` drew hung on `Army.Shot`, `.Fired`, `.Killed`,
    // `.Destroyed` and `.Bombed` - events of a C# army that is never built.
    // Measured in the player build before this: `army=null`, `pieces=0` for a
    // whole drive, and `combat=0` sounds asked for.
    //
    // The core raises no events either, but it does not have to: every one of
    // those five is a state transition in the buffer Unity already polls, and
    // one frame of memory is enough to read them. The core steps once per
    // Unity frame, so nothing is missed.
    //
    //   a tank fired      `U_TARGET` - the armour's reload counter - goes UP.
    //                     It only ever counts down otherwise, so any rise is a
    //                     shot. 84 to 191 ticks, `FIRE_RELOAD_MIN/SPAN`.
    //   a rifleman fired  `U_COOLDOWN` rises to 150 or more. The reload band
    //                     is 150-269 and the "looked and found nobody" band is
    //                     24-65, so the two are disjoint and a look draws no
    //                     muzzle flash.
    //   somebody was hit  `U_HP` fell while still alive.
    //   somebody died     `U_STATE` went 1 to 0.
    //   a bomb went off   `B_STATE` went 1 to 0.
    //
    // NOTHING HERE DECIDES ANYTHING. No roll, no damage, no range test that
    // costs anybody anything: the core has already fired, hit and killed, and
    // this reads what it did. The target is picked the way `pickTarget` and
    // `pickRifleTarget` pick it - nearest enemy of the same arm inside 46 m
    // and 26 m - because the tracer has to end somewhere, and re-running the
    // core's own rule on the core's own state is not a second opinion. A slot
    // that changed alive-state this frame is skipped, so a spawn's staggered
    // reload cannot read as a shot.
    int[] _wasAlive, _wasClock;
    float[] _wasHp;
    bool[] _wasBomb;

    void PollCore()
    {
        int n = Arena.Layout.UNITS;
        if (_wasAlive == null || _wasAlive.Length != n)
        {
            _wasAlive = new int[n]; _wasClock = new int[n]; _wasHp = new float[n];
            for (int i = 0; i < n; i++)
            {
                _wasAlive[i] = Arena.ArenaCore.UnitAlive(i) ? 1 : 0;
                _wasClock[i] = Arena.ArenaCore.UnitReloadClock(i);
                _wasHp[i] = Arena.ArenaCore.UnitHealth(i);
            }
            return;                       // first frame is the baseline, not an event
        }

        if (audio == null) audio = FindFirstObjectByType<GameAudio>();

        for (int i = 0; i < n; i++)
        {
            bool alive = Arena.ArenaCore.UnitAlive(i);
            int clock = Arena.ArenaCore.UnitReloadClock(i);
            float hp = Arena.ArenaCore.UnitHealth(i);
            bool armour = Arena.ArenaCore.UnitIsArmour(i);
            bool wasAlive = _wasAlive[i] != 0;

            if (wasAlive && !alive)
            {
                var at = LastSeen(i);
                if (armour)
                {
                    TankExplosion(new Vector3(at.x, Ground(at.x, at.z), at.z),
                                  Arena.ArenaCore.UnitHeading(i) * Mathf.Deg2Rad);
                    if (audio != null) audio.Destroyed(new Vector2(at.x, at.z));
                }
                else
                {
                    DrawCorpse(at.x, at.z, Arena.ArenaCore.UnitHeading(i) * Mathf.Deg2Rad,
                               Arena.ArenaCore.UnitSide(i) < 0, Vector2.zero);
                    if (audio != null) audio.Hit(new Vector2(at.x, at.z));
                }
            }
            else if (alive && wasAlive)
            {
                var at = Arena.ArenaCore.UnitPosition(i, 0f);

                if (hp < _wasHp[i] - 0.001f)
                {
                    Impact(new Vector3(at.x, Ground(at.x, at.z) + 1f, at.z), Vector2.zero);
                    if (audio != null) audio.Hit(new Vector2(at.x, at.z));
                }

                // the reload counter rising is the shot; a rifleman's "look"
                // clock is far below the reload band and draws nothing
                bool fired = clock > _wasClock[i] && (armour || clock >= RifleReloadFloor);
                if (fired) Muzzle(i, at, armour);
            }

            _wasAlive[i] = alive ? 1 : 0;
            _wasClock[i] = clock;
            _wasHp[i] = hp;
        }

        int bombs = Arena.Layout.MAX_BOMBS;
        if (_wasBomb == null || _wasBomb.Length != bombs)
        {
            _wasBomb = new bool[bombs];
            for (int b = 0; b < bombs; b++) _wasBomb[b] = Arena.ArenaCore.BombAlive(b);
        }
        else
        {
            for (int b = 0; b < bombs; b++)
            {
                bool live = Arena.ArenaCore.BombAlive(b);
                if (_wasBomb[b] && !live)
                {
                    var at = Arena.ArenaCore.BombPosition(b);
                    // the same burst `army.Bombed` drew, at the slot's last place
                    DrawBombBurst(new Vector3(at.x, Ground(at.x, at.z), at.z));
                    if (audio != null) audio.Destroyed(new Vector2(at.x, at.z));
                }
                _wasBomb[b] = live;
            }
        }
    }

    /// <summary>The reload band a rifleman's clock is set to when he shoots.</summary>
    const int RifleReloadFloor = 150;

    /// <summary>
    /// Where a unit was before it died. `UnitPosition` still reads its last
    /// coordinates - the core does not clear them - so this is the corpse's
    /// place rather than the origin.
    /// </summary>
    Vector3 LastSeen(int i) => Arena.ArenaCore.UnitPosition(i, 0f);

    /// <summary>
    /// The courier's own reach against each arm, in metres: `COURIER_RANGE` for
    /// a tank and `RIFLE_RANGE` for a rifleman, both from `rules/army.js`.
    /// </summary>
    public const float CourierReachForArmour = 34f;
    public const float CourierReachForRifle = 26f;

    /// <summary>
    /// Whether this shot went at the truck rather than at the enemy the unit
    /// had picked - the core's rule, in the core's own terms.
    ///
    /// `sim.js` takes the courier only when it is inside the reach for that
    /// arm AND nearer than the foe, and only once a foe has been found at all:
    /// a unit with nobody in range does not fire at the truck standing beside
    /// it. Squared distances throughout, so nothing here takes a root the core
    /// does not take either.
    ///
    /// Static and public because it is a rule with edges - reach, nearer, no
    /// foe - and a rule with edges is worth pinning without a scene.
    /// </summary>
    public static bool ShotGoesAtTheCourier(bool armour, float toTruckSq,
                                            bool foundFoe, float foeSq)
    {
        if (!foundFoe) return false;
        float reach = armour ? CourierReachForArmour : CourierReachForRifle;
        return toTruckSq < reach * reach && toTruckSq < foeSq;
    }

    /// <summary>
    /// Muzzle flash and tracer, ending at whoever the core would have shot at.
    /// </summary>
    void Muzzle(int i, Vector3 at, bool armour)
    {
        float range = armour ? 46f : 26f;
        int side = Arena.ArenaCore.UnitSide(i);
        float bestD2 = range * range; float tx = 0f, tz = 0f; bool found = false;
        for (int j = 0; j < Arena.Layout.UNITS; j++)
        {
            if (j == i || !Arena.ArenaCore.UnitAlive(j)) continue;
            if (Arena.ArenaCore.UnitIsArmour(j) != armour) continue;
            if (Arena.ArenaCore.UnitSide(j) == side) continue;
            var o = Arena.ArenaCore.UnitPosition(j, 0f);
            float d2 = (o.x - at.x) * (o.x - at.x) + (o.z - at.z) * (o.z - at.z);
            if (d2 < bestD2) { bestD2 = d2; tx = o.x; tz = o.z; found = true; }
        }
        // AND THE COURIER, WHICH IS WHERE THE DAMAGE ACTUALLY WENT.
        //
        // Measured before this was written: both engines put 100% of a parked
        // truck's damage on tank shells and write it off in twelve to twenty
        // seconds. The picture said otherwise, because the search above only
        // ever considers other UNITS - it skips the dead, the wrong arm and
        // its own side, and the truck is not in the list at all - so the shell
        // the core spent on the player was drawn going at some other tank.
        // Hit hard, repeatedly, and never shown a barrel pointed at him.
        //
        // The old C# army skipped the truck here too, so this is not a leftover
        // being copied. It is the core's own rule, `sim.js` at the armour and
        // rifle firing sites: the courier outranks the enemy the unit had
        // picked when it is inside the courier reach AND nearer than that
        // enemy. Nothing is decided here - the core has already spent the
        // shell - this only points the barrel where it went.
        var truck = Arena.ArenaCore.TruckPosition(0f);
        float dtx = truck.x - at.x, dtz = truck.z - at.z;
        float toTruck2 = dtx * dtx + dtz * dtz;
        if (ShotGoesAtTheCourier(armour, toTruck2, found, bestD2))
        {
            tx = truck.x; tz = truck.z; bestD2 = toTruck2;
        }

        // The core picks its target BEFORE the step and this reads the state
        // after it, so now and then the man it shot has moved out of reach.
        // The round still left the barrel: it goes down the unit's heading.
        float yaw = found ? Mathf.Atan2(tx - at.x, tz - at.z)
                          : Arena.ArenaCore.UnitHeading(i) * Mathf.Deg2Rad;
        float reach = found ? Mathf.Sqrt(bestD2) : range;
        float lift = armour ? 2.1f : 1.5f;
        float out_ = armour ? 4.6f : 0f;      // `Bind` put the rifle's flash on the man

        var muzzle = new Vector3(at.x + Mathf.Sin(yaw) * out_, Ground(at.x, at.z) + lift,
                                 at.z + Mathf.Cos(yaw) * out_);
        var impact = new Vector3(at.x + Mathf.Sin(yaw) * reach, 0f, at.z + Mathf.Cos(yaw) * reach);
        impact.y = Ground(impact.x, impact.z) + (armour ? 1.2f : 1.0f);

        if (armour) DrawTankShot(muzzle, impact); else DrawRifleShot(muzzle, impact);
        if (audio == null) return;
        if (armour) audio.Cannon(new Vector2(at.x, at.z));
        else audio.Rifle(new Vector2(at.x, at.z));
    }

    /// <summary>The sound and the light of a shot, and nothing that decides one.</summary>
    public GameAudio audio;

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
                    // Set down again it on the ground every frame. The terrain is
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

                    // IT STANDS, THEN IT GOES. the owner, 17:53 on the phone:
                    // a wreck must not shrink before it disappears. It used to
                    // scale to nothing over the last 15% of its life, so a
                    // burnt-out tank became a toy tank and then a speck - which
                    // reads as the model failing rather than as wreckage being
                    // cleared. It keeps its size for the whole of it and is
                    // simply removed at the end.
                    //
                    // 30 s, not 25 and not 70. the owner asked for them to stand
                    // longer. 70 s left 32 parts burning after a minute, and
                    // 45 s still failed `EverythingClearsEventually` and
                    // `EffectsRetireInsteadOfPilingUp`, which step 35 seconds
                    // and require the field empty. That window is the ceiling
                    // and it is not a threshold to move to fit a wish, so the
                    // life goes to 30 s - longer than it was, inside every
                    // assertion. If wrecks should stand longer than 35 s the
                    // test horizon is the thing to discuss, not to edit.
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
                    if (k > 0.7f) p.t.localScale = p.baseScale * Mathf.Lerp(1f, 0f, (k - 0.7f) / 0.3f);

                    // LANDED: it stays where it came down, still, on its lowest corner. Before, landing
                    // zeroed the velocity and the next frame recomputed the position from the blast
                    // point with it - measured on this rule, a chunk that had flown was pulled back to
                    // the centre by up to 11 m, went on spinning there, and rested at half its edge, so a
                    // tilted cube stood up to 12.6 cm into the road.
                    if (!float.IsNaN(p.restOffset))
                    {
                        p.t.position = new Vector3(p.from.x, Ground(p.from.x, p.from.z) + HalfHeight(p.t), p.from.z);
                        break;
                    }

                    // a real arc, so pieces land instead of drifting off
                    float t2 = p.age;
                    var pos = p.from + p.velocity * t2 + Vector3.up * (-9.81f * 0.5f * t2 * t2);
                    p.t.Rotate(p.spin * dt, Space.Self);
                    float floor = Ground(pos.x, pos.z) + HalfHeight(p.t);
                    if (pos.y < floor)
                    {
                        pos.y = floor;
                        p.from = pos;                 // where it came down, not where it was thrown from
                        p.velocity = Vector3.zero;
                        p.spin = Vector3.zero;
                        p.restOffset = floor - Ground(pos.x, pos.z);
                    }
                    p.t.position = pos;
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
    /// How far a box's lowest corner hangs below its centre, as it is turned and scaled now: half of its
    /// extent along world up. Half its edge is only right for a box sitting square.
    /// </summary>
    static float HalfHeight(Transform t)
    {
        var s = t.localScale;
        var r = t.rotation;
        return 0.5f * (Mathf.Abs((r * Vector3.right).y) * s.x
                     + Mathf.Abs((r * Vector3.up).y) * s.y
                     + Mathf.Abs((r * Vector3.forward).y) * s.z);
    }

    /// <summary>
    /// Every piece ever created. Exposed because the live count cannot show
    /// cadence: while things are retiring at the rate they are spawned it does
    /// not move, so it cannot tell a steady fire from a stopped one.
    /// </summary>
    public int TotalSpawned { get; private set; }

    /* ---------------------------------------------------------- army hooks */

    // ---- what a shot, a corpse and a bomb LOOK like -----------------------
    //
    // Lifted out of `Bind` so the C# army's events and the core's own state
    // transitions draw the SAME thing. They did not: the core-driven path had
    // a smaller muzzle flash, a thinner tracer, no impact blast, a corpse
    // sitting a proxy-box too low, and a bomb reduced to one fireball where
    // this draws nine plus smoke, twenty-two sparks and a shockwave. Two
    // callers copying one effect is how they drift apart, so now there is one
    // copy and two callers.

    /// <summary>A rifle round: a small flash and a thin tracer.</summary>
    void DrawRifleShot(Vector3 muzzle, Vector3 impact)
    {
        Flash(muzzle, 0.5f);
        Tracer(muzzle, impact, tracerMaterial, 0.09f, 0.10f);
    }

    /// <summary>A tank round: a big flash, a fat tracer, and it lands.</summary>
    void DrawTankShot(Vector3 muzzle, Vector3 impact)
    {
        Flash(muzzle, 1.6f);
        Tracer(muzzle, impact, tracerMaterial, 0.3f, 0.16f);
        Blast(impact, 4.5f);
    }

    /// <summary>
    /// A casualty, so it is not just a model changing state. The lift is the
    /// proxy box's, and it is zero when there is a real body to stand up.
    /// </summary>
    void DrawCorpse(float x, float z, float heading, bool bull, Vector2 knock)
    {
        if (knock.sqrMagnitude > 0.01f)
            Impact(new Vector3(x, Ground(x, z) + 1f, z), knock);
        float lift = bodyPrefab != null ? 0f : 0.9f;
        Body(new Vector3(x, Ground(x, z) + lift, z), heading, bull, knock);
    }

    /// <summary>
    /// A bomb is not a tank going up. Everything is bigger and there is more
    /// of it, because the whole point of a gunship is that it outweighs
    /// anything on the ground.
    /// </summary>
    void DrawBombBurst(Vector3 p)
    {
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
    }

    public void Bind(Army army)
    {
        army.Shot += (from, at) =>
            DrawRifleShot(new Vector3(from.x, Ground(from.x, from.z) + 1.5f, from.z),
                          new Vector3(at.x, Ground(at.x, at.y) + 1.0f, at.y));

        army.Fired += (from, at) =>
        {
            float yaw = from.turretYaw;
            DrawTankShot(new Vector3(from.x + Mathf.Sin(yaw) * 4.6f,
                                     Ground(from.x, from.z) + 2.1f,
                                     from.z + Mathf.Cos(yaw) * 4.6f),
                         new Vector3(at.x, Ground(at.x, at.y) + 1.2f, at.y));
        };

        army.Killed += (u, knock) =>
            DrawCorpse(u.x, u.z, u.heading, u.side == Army.Side.Bull, knock);

        army.Destroyed += v => TankExplosion(new Vector3(v.x, Ground(v.x, v.z), v.z), v.heading);

        army.Bombed += at => DrawBombBurst(new Vector3(at.x, Ground(at.x, at.y), at.y));
    }
}
