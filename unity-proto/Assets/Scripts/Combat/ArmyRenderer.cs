// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Draws both armies as pooled GameObjects.
///
/// This used Graphics.RenderMeshInstanced, which rendered correctly in the
/// editor and nothing at all in the WebGL build: the INSTANCING_ON variant of
/// URP/Lit is stripped at build time unless a material ASSET asks for it, and
/// setting enableInstancing at runtime is too late. Instancing also culls
/// against RenderParams.worldBounds, which defaults to a zero-size box.
///
/// Two invisible-only-in-the-build failure modes for a couple of hundred
/// objects is a bad trade. Plain renderers cannot fail either way, and 200
/// GameObjects is nothing. If the army ever grows enough to matter, that is a
/// measurable optimisation to revisit - with a build to measure.
/// </summary>
public class ArmyRenderer : MonoBehaviour
{
    /// <summary>
    /// WHERE THE PICTURE COMES FROM. The core, and nothing else.
    ///
    /// This was `public Army army`, and every loop below walked
    /// `army.Armour`, `army.Infantry`, `army.Helicopters` and `army.Bombs` -
    /// a C# simulation that, since `UploadArmour` was deleted, fed the core
    /// nothing and was fed nothing by it. The player watched an army that
    /// decided no outcome while the truck was shot at and blocked by an army
    /// nobody drew.
    ///
    /// `Army.Side` survives as an enum for the pools and tints. No `Army`
    /// instance is touched.
    /// </summary>
    static bool CoreReady => Arena.ArenaCore.Available;

    static Army.Side SideOf(int i) =>
        Arena.ArenaCore.UnitSide(i) < 0 ? Army.Side.Bull : Army.Side.Bear;
    public MempoolTerrain terrain;

    [Tooltip("Optional. When set, units stand on the road deck rather than on " +
             "the bare ground the deck is laid over.")]
    public RoadNetwork roads;
    public Material bullMaterial;
    public Material bearMaterial;

    [Header("Optional imported models")]
    [Tooltip("Soldier prefab. Falls back to a box if empty, so the scene always runs.")]
    public GameObject soldierPrefab;
    [Tooltip("Metres tall. The prefab is scaled to this, whatever units it was authored in.")]
    public float soldierHeight = 1.8f;
    [Tooltip("Degrees to add so the model faces +Z, which is what the army logic assumes.")]
    public float soldierYawOffset;
    /// <summary>§11.4/§11.5: how far a man drops when the core has him PRONE or COVER, in metres.</summary>
    public float soldierProneDrop = 0.75f;
    /// <summary>How far he pitches forward when down. 90 is flat on his face along the way he was facing.</summary>
    public float soldierPronePitch = 82f;
    [Tooltip("Controller built from the pack's clips. Without it the model stands in its bind pose.")]
    public RuntimeAnimatorController soldierAnimator;

    [Tooltip("Tank prefab. Falls back to a box hull and turret if empty.")]
    public GameObject tankPrefab;
    [Tooltip("Helicopter prefab. Falls back to a crude airframe if empty.")]
    public GameObject helicopterPrefab;
    public float helicopterLength = 14f;
    public float helicopterYawOffset;
    [Tooltip("Bomb prefab. Falls back to a box if empty.")]
    public GameObject bombPrefab;
    [Tooltip("Metres long. A free-fall bomb is about two.")]
    public float bombLength = 2.2f;
    [Tooltip("Metres wide across the tracks. The model is scaled to this.")]
    public float tankWidth = 3.7f;
    public float tankYawOffset;

    /// <summary>Turret nodes of the prefab tanks, in step with _hulls.</summary>
    readonly List<Transform> _prefabTurrets = new List<Transform>();

    /// <summary>Road wheels per tank wrapper, and how far each tank has driven.</summary>
    readonly Dictionary<Transform, List<Transform>> _tankWheels =
        new Dictionary<Transform, List<Transform>>();
    readonly Dictionary<Transform, Vector3> _lastTankPos = new Dictionary<Transform, Vector3>();

    /// <summary>
    /// Units live on their own layer with self-collision switched off. The Army
    /// logic already pushes hulls apart; letting the physics engine do it too
    /// means two systems fighting over the same positions every frame.
    /// </summary>
    public const int UnitLayer = 8;

    Mesh _hull, _turret, _soldier;
    readonly List<Transform> _hulls = new List<Transform>();
    readonly List<Transform> _turrets = new List<Transform>();
    readonly List<Transform> _helis = new List<Transform>();
    // Per gunship slot, for the nose and the bank derived from its travel.
    readonly float[] _heliYaw = new float[Arena.Layout.MAX_HELIS];
    readonly float[] _heliBank = new float[Arena.Layout.MAX_HELIS];
    readonly Vector3[] _heliWas = new Vector3[Arena.Layout.MAX_HELIS];
    readonly bool[] _heliFlown = new bool[Arena.Layout.MAX_HELIS];
    readonly List<Transform> _bombs = new List<Transform>();
    /// <summary>Main and tail rotor per airframe, so they can be spun.</summary>
    readonly Dictionary<Transform, (Transform main, Transform tail)> _heliRotors =
        new Dictionary<Transform, (Transform, Transform)>();
    Mesh _heliBody, _heliRotor, _bomb;

    readonly List<Transform> _hullsBull = new List<Transform>();
    readonly List<Transform> _hullsBear = new List<Transform>();
    readonly List<Transform> _soldiersBull = new List<Transform>();
    readonly List<Transform> _soldiersBear = new List<Transform>();

    /// <summary>
    /// Take a soldier model that arrived after the game had already started.
    ///
    /// The pools go with it: they hold instances built from whatever prefab was
    /// current when each was made, so leaving them would keep half the army as
    /// boxes for as long as those instances happen to survive.
    /// </summary>
    public void SetSoldierPrefab(GameObject prefab)
    {
        if (prefab == null || prefab == soldierPrefab) return;
        soldierPrefab = prefab;
        Discard(_soldiersBull);
        Discard(_soldiersBear);
    }

    /// <summary>The same for armour, which also drops its turret and wheel maps.</summary>
    public void SetTankPrefab(GameObject prefab)
    {
        if (prefab == null || prefab == tankPrefab) return;
        tankPrefab = prefab;
        Discard(_hulls);
        Discard(_turrets);
        Discard(_hullsBull);
        Discard(_hullsBear);
        _prefabTurrets.Clear();
        _tankWheels.Clear();
        _lastTankPos.Clear();
    }

    /// <summary>Take a bomb model that arrived after the start.</summary>
    public void SetBombPrefab(GameObject prefab)
    {
        if (prefab == null || prefab == bombPrefab) return;
        bombPrefab = prefab;
        Discard(_bombs);
    }

    /// <summary>Take a gunship model that arrived after the start.</summary>
    public void SetHelicopterPrefab(GameObject prefab)
    {
        if (prefab == null || prefab == helicopterPrefab) return;
        helicopterPrefab = prefab;
        Discard(_helis);
        _heliRotors.Clear();
    }

    static void Discard(List<Transform> pool)
    {
        foreach (var t in pool) if (t != null) Destroy(t.gameObject);
        pool.Clear();
    }


    void Awake()
    {
        Physics.IgnoreLayerCollision(UnitLayer, UnitLayer, true);
        _hull = Box(new Vector3(3.4f, 1.5f, 6.2f), "TankHull");
        _turret = Turret();
        _soldier = Box(new Vector3(0.7f, 1.8f, 0.5f), "Soldier");
        _heliBody = Box(new Vector3(2.2f, 2.2f, 11f), "HeliBody");
        _heliRotor = Box(new Vector3(13f, 0.22f, 1.1f), "Rotor");
        _bomb = Box(new Vector3(0.7f, 0.7f, 2.2f), "Bomb");
    }

    static Mesh Box(Vector3 size, string name)
    {
        var t = GameObject.CreatePrimitive(PrimitiveType.Cube);
        var src = t.GetComponent<MeshFilter>().sharedMesh;
        var m = new Mesh { name = name };
        var verts = src.vertices;
        for (int i = 0; i < verts.Length; i++) verts[i] = Vector3.Scale(verts[i], size);
        m.vertices = verts;
        m.triangles = src.triangles;
        m.normals = src.normals;
        m.uv = src.uv;
        m.RecalculateBounds();
        DestroyImmediate(t);
        return m;
    }

    /// <summary>Turret box with a barrel out of the front, as one mesh.</summary>
    static Mesh Turret()
    {
        var body = Box(new Vector3(2.2f, 1.0f, 2.6f), "t");
        var barrel = Box(new Vector3(0.34f, 0.34f, 4.2f), "b");
        var combine = new[]
        {
            new CombineInstance { mesh = body, transform = Matrix4x4.Translate(new Vector3(0f, 1.2f, -0.2f)) },
            new CombineInstance { mesh = barrel, transform = Matrix4x4.Translate(new Vector3(0f, 1.15f, 2.6f)) },
        };
        var m = new Mesh { name = "TankTurret" };
        m.CombineMeshes(combine, true, true);
        m.RecalculateNormals();
        m.RecalculateBounds();
        return m;
    }

    /// <param name="solid">
    /// Hulls and soldiers block the truck; turrets do not, because a turret
    /// sits inside its own hull's collider and would only fight with it.
    /// </param>
    /// <summary>
    /// Build one tank from the imported prefab.
    ///
    /// The model carries its own turret node, so the turret is driven as a
    /// LOCAL rotation of the hull rather than as a separate object at a world
    /// angle - which is how the box version had to do it, and why that one
    /// looked like a turret hovering next to a tank rather than on it.
    /// </summary>
    Transform MakeTankFromPrefab(Army.Side side)
    {
        // Scaled on the NARROWER horizontal axis: the longer one includes the
        // gun barrel, which sticks far past the hull and would shrink every tank.
        var go = WrapOnItsSole(tankPrefab, transform, "Hull", tankWidth, Measure.NarrowestHorizontal);
        go.layer = UnitLayer;

        Transform turret = null;
        foreach (var r in go.GetComponentsInChildren<Renderer>(true))
            if (r.name.ToLowerInvariant().Contains("turret")) { turret = r.transform; break; }

        // road wheels, so the running gear turns as the tank moves
        var wheels = new List<Transform>();
        foreach (var t in go.GetComponentsInChildren<Transform>(true))
        {
            string n = t.name.ToLowerInvariant();
            if (n.Contains("wheel") && !n.Contains("bone")) wheels.Add(t);
        }
        _tankWheels[go.transform] = wheels;

        Rematerialise(go, side == Army.Side.Bull ? bullMaterial : bearMaterial);

        foreach (var c in go.GetComponentsInChildren<Collider>(true)) DestroyImmediate(c);
        var box = go.AddComponent<BoxCollider>();
        // As tall as the real thing. At 1.5 the truck climbed straight over a
        // tank instead of being stopped by it - a low box is a ramp, not a wall.
        box.size = new Vector3(3.6f, 2.6f, 7.2f);
        box.center = new Vector3(0f, 1.3f, 0f);
        var rb = go.AddComponent<Rigidbody>();
        rb.isKinematic = true;
        rb.useGravity = false;

        _prefabTurrets.Add(turret);
        return go.transform;
    }

    /// <summary>
    /// Build one soldier from the imported prefab.
    ///
    /// Two things have to be normalised whatever the asset does: its scale,
    /// because a model authored in centimetres arrives a hundred times too big,
    /// and its materials, because an Asset Store model is usually Built-in
    /// pipeline and renders magenta in a URP project. The team colour is
    /// multiplied into whatever texture it came with rather than replacing it,
    /// so a green soldier still looks like a soldier.
    /// </summary>
    Transform MakeSoldierFromPrefab(Army.Side side)
    {
        var go = WrapOnItsSole(soldierPrefab, transform, "Soldier", soldierHeight, Measure.Height);
        go.layer = UnitLayer;

        Rematerialise(go, side == Army.Side.Bull ? bullMaterial : bearMaterial);

        // No collider. Infantry is meant to be driven through, and a truck that
        // bounces off a man it is running over reads as a bug rather than as a
        // casualty. Armour keeps its collider; that is the thing you go round.
        foreach (var c in go.GetComponentsInChildren<Collider>(true)) DestroyImmediate(c);

        if (soldierAnimator != null)
        {
            var anim = go.GetComponentInChildren<Animator>() ?? go.AddComponent<Animator>();
            anim.runtimeAnimatorController = soldierAnimator;
            // Only animate what is on screen. A hundred and eighty skinned
            // characters is a real cost in WebGL, and a man behind you does not
            // need his legs solved.
            anim.cullingMode = AnimatorCullingMode.CullCompletely;
            anim.applyRootMotion = false;      // the army logic owns the position
        }

        return go.transform;
    }

    readonly Dictionary<(Material, Material), Material> _teamCache =
        new Dictionary<(Material, Material), Material>();

    /// <summary>
    /// A URP material carrying the model's own texture under a team colour.
    /// Cached, or every soldier would carry his own copy.
    /// </summary>
    /// <summary>
    /// Re-materialise an imported model for URP.
    ///
    /// EVERY imported model needs this, and forgetting it on one of them is
    /// what has made first the truck and then the helicopter invisible: these
    /// packs ship Built-in materials, and a Built-in shader does not merely
    /// look wrong in a URP build - it is absent, so the mesh renders nothing
    /// while still casting a shadow. Having one function for it means the next
    /// model cannot quietly miss out.
    /// </summary>
    void Rematerialise(GameObject go, Material tint)
    {
        foreach (var r in go.GetComponentsInChildren<Renderer>(true))
        {
            var mats = new Material[r.sharedMaterials.Length];
            for (int i = 0; i < mats.Length; i++) mats[i] = TeamMaterial(r.sharedMaterials[i], tint);
            r.sharedMaterials = mats;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
        }
    }

    Material TeamMaterial(Material source, Material tint)
    {
        var key = (source, tint);
        if (_teamCache.TryGetValue(key, out var cached)) return cached;

        var shader = Shader.Find("Universal Render Pipeline/Lit");
        if (shader == null) return tint != null ? tint : source;
        var m = new Material(shader);
        // A null tint means "keep the model's own colours" - aircraft belong to
        // a side but are not painted in its colour.
        m.SetColor("_BaseColor", tint != null ? tint.GetColor("_BaseColor") : Color.white);

        // carry the original albedo across if the asset had one, under either
        // the URP or the Built-in property name
        if (source != null)
        {
            Texture tex = source.HasProperty("_BaseMap") ? source.GetTexture("_BaseMap")
                        : source.HasProperty("_MainTex") ? source.GetTexture("_MainTex")
                        : null;
            if (tex != null) m.SetTexture("_BaseMap", tex);
        }
        m.SetFloat("_Smoothness", 0.25f);
        _teamCache[key] = m;
        return m;
    }

    Transform MakePiece(Mesh mesh, string name, bool solid, Vector3 hitbox)
    {
        var go = new GameObject(name);
        go.transform.SetParent(transform, false);
        go.layer = UnitLayer;
        go.AddComponent<MeshFilter>().sharedMesh = mesh;
        var mr = go.AddComponent<MeshRenderer>();
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;

        if (solid)
        {
            go.AddComponent<BoxCollider>().size = hitbox;
            // A collider that moves every frame without a body makes Unity
            // rebuild the static collision structure each time. Kinematic keeps
            // it in the moving set and still refuses to be pushed around.
            var rb = go.AddComponent<Rigidbody>();
            rb.isKinematic = true;
            rb.useGravity = false;
            rb.interpolation = RigidbodyInterpolation.Interpolate;
        }
        return go.transform;
    }

    /// <summary>
    /// Wrap an imported model so the wrapper's origin sits on the model's
    /// SOLE, scaled to a wanted size.
    ///
    /// A pack's pivot is wherever the artist left it - often the hull centre,
    /// sometimes the turret ring. Placing such a model at ground level buries
    /// half of it. Measuring the bounds and shifting the model inside a wrapper
    /// means every caller can simply put the wrapper on the ground.
    ///
    /// The measurement has to be done in the WRAPPER's space: Renderer.bounds
    /// is world-space, and feeding a world Y into a localPosition is what put
    /// the truck somewhere off the map entirely.
    /// </summary>
    /// <summary>Which dimension <paramref name="wantedSize"/> refers to.</summary>
    public enum Measure { Height, NarrowestHorizontal, LongestHorizontal }

    static GameObject WrapOnItsSole(GameObject prefab, Transform parent, string name,
                                    float wantedSize, Measure measure)
    {
        var wrapper = new GameObject(name);
        wrapper.transform.SetParent(parent, false);

        var model = Instantiate(prefab, wrapper.transform);
        model.transform.localPosition = Vector3.zero;
        model.transform.localRotation = Quaternion.identity;

        var renderers = model.GetComponentsInChildren<Renderer>(true);
        if (renderers.Length == 0) return wrapper;

        Bounds World()
        {
            var b = renderers[0].bounds;
            foreach (var r in renderers) b.Encapsulate(r.bounds);
            return b;
        }

        var bounds = World();
        // Measured on the axis the caller actually meant. A helicopter given
        // its LENGTH but measured on its height comes out several times too
        // big, because an airframe is long and flat.
        float span = measure switch
        {
            Measure.NarrowestHorizontal => Mathf.Min(bounds.size.x, bounds.size.z),
            Measure.LongestHorizontal => Mathf.Max(bounds.size.x, bounds.size.z),
            _ => bounds.size.y,
        };
        if (span > 0.0001f) model.transform.localScale = Vector3.one * (wantedSize / span);

        // re-measure after scaling, then lift by the sole IN LOCAL SPACE
        bounds = World();
        float soleLocalY = wrapper.transform.InverseTransformPoint(
            new Vector3(bounds.center.x, bounds.min.y, bounds.center.z)).y;
        model.transform.localPosition = new Vector3(0f, -soleLocalY, 0f);

        return wrapper;
    }

    /// <summary>
    /// Gunships and the bombs they drop.
    ///
    /// The airframe is one pool for both sides - it is tinted per frame rather
    /// than per instance, because there are only ever a handful in the air and
    /// a pool per side would spend more on bookkeeping than it saves.
    /// </summary>
    /// <summary>
    /// The gunships, and the sound of them.
    ///
    /// `GameAudio.Rotors` had no caller at all: the helicopters flew over the
    /// field from core state, rotors turning, in silence. It wants the NEAREST
    /// one each frame or nothing when the sky is clear, so the nearest is
    /// taken here, where the living ones are already being walked - measured
    /// against the truck's own position, which the core publishes too. No new
    /// state, no second reader, and nothing that decides anything.
    /// </summary>
    void PlaceAircraft()
    {
        if (audio == null) audio = FindFirstObjectByType<GameAudio>();
        var ear = Arena.ArenaCore.TruckPosition(0f);
        float nearest = float.MaxValue;
        Vector2? overhead = null;

        int helis = 0;
        for (int k = 0; k < Arena.Layout.MAX_HELIS; k++) if (Arena.ArenaCore.HeliAlive(k)) helis++;
        Fit(_helis, helis, MakeHelicopter);
        int hn = 0;
        for (int k = 0; k < Arena.Layout.MAX_HELIS; k++)
        {
            // A dead slot forgets its nose: the next sortie in it starts from
            // its own crossing direction, not from where the last one was
            // pointing when it left the field.
            if (!Arena.ArenaCore.HeliAlive(k)) { _heliFlown[k] = false; continue; }
            if (hn >= _helis.Count) break;
            var t = _helis[hn++];
            if (!t.gameObject.activeSelf) t.gameObject.SetActive(true);

            // YAW AND BANK ARE THE RENDERER'S OWN. The core carries `H_DIR`,
            // the way the gunship is crossing, and nothing else - it has no
            // yaw and no bank because neither decides anything. A gunship
            // faces along its run and banks for the look of it, so both are
            // derived here and no simulation is invented to supply them.
            // ... and DERIVED means from the travel, which the last version did
            // not do. It took the nose straight from `H_DIR`, which is the way
            // the gunship is CROSSING and is one number for the whole sortie,
            // while the machine's z chases `seam(x) +- (26 + sin(t*0.6)*9)` at
            // up to 29.5 m/s. Measured over 150 s: the drawn nose was 19.4 deg
            // off the real travel on average, 37.0 at the 95th percentile and
            // 55.9 at worst - a gunship crabbing sideways across its own run.
            // The PATH was never wrong; only the nose was.
            //
            // So it is derived the way `Army.cs:443-451` derives it - nose to
            // Atan2 of the step, eased at 3 per second, bank in proportion to
            // how hard it is turning, clamped at 0.8 rad and eased at 3.5.
            // Nothing in the simulation reads either, which is why they belong
            // here and cost no layout word.
            var where = Arena.ArenaCore.HeliPosition(k);
            float yaw = _heliYaw[k];
            if (!_heliFlown[k])
            {
                yaw = Arena.ArenaCore.HeliDir(k) >= 0 ? 90f : -90f;
                _heliBank[k] = 0f;
                _heliFlown[k] = true;
            }
            else
            {
                float vx = where.x - _heliWas[k].x, vz = where.z - _heliWas[k].z;
                if (vx * vx + vz * vz > 1e-8f)
                {
                    float want = Mathf.Atan2(vx, vz) * Mathf.Rad2Deg;
                    float turn = Mathf.DeltaAngle(yaw, want) * Mathf.Deg2Rad;
                    yaw = Mathf.LerpAngle(yaw, want, 1f - Mathf.Exp(-3f * Time.deltaTime));
                    _heliBank[k] += (Mathf.Clamp(turn * 4.5f, -0.8f, 0.8f) - _heliBank[k])
                                  * (1f - Mathf.Exp(-3.5f * Time.deltaTime));
                }
            }
            _heliYaw[k] = yaw;
            _heliWas[k] = where;
            t.SetPositionAndRotation(where,
                Quaternion.Euler(0f, yaw + helicopterYawOffset, -_heliBank[k] * Mathf.Rad2Deg));

            float d2 = (where.x - ear.x) * (where.x - ear.x) + (where.z - ear.z) * (where.z - ear.z);
            if (d2 < nearest) { nearest = d2; overhead = new Vector2(where.x, where.z); }

            var mat = Arena.ArenaCore.HeliSide(k) < 0 ? bullMaterial : bearMaterial;
            foreach (var r in t.GetComponentsInChildren<MeshRenderer>(true))
                if (mat != null && r.sharedMaterial != mat && helicopterPrefab == null)
                    r.sharedMaterial = mat;

            if (_heliRotors.TryGetValue(t, out var rotors))
            {
                if (rotors.main != null) rotors.main.Rotate(0f, 1500f * Time.deltaTime, 0f, Space.Self);
                if (rotors.tail != null) rotors.tail.Rotate(2200f * Time.deltaTime, 0f, 0f, Space.Self);
            }
        }

        // Every frame, the nearest gunship or nothing - which is the contract
        // `Rotors` documents and which nobody had ever called it with.
        if (audio != null) audio.Rotors(overhead);

        int bombs = 0;
        for (int k = 0; k < Arena.Layout.MAX_BOMBS; k++) if (Arena.ArenaCore.BombAlive(k)) bombs++;
        Fit(_bombs, bombs, MakeBomb);
        int bn = 0;
        for (int k = 0; k < Arena.Layout.MAX_BOMBS; k++)
        {
            if (!Arena.ArenaCore.BombAlive(k)) continue;
            if (bn >= _bombs.Count) break;
            // noses along its own flight path, so it does not fall sideways
            var vel = Arena.ArenaCore.BombVelocity(k);
            var rot = vel.sqrMagnitude > 0.01f
                ? Quaternion.LookRotation(vel.normalized, Vector3.up) : Quaternion.identity;
            var t = _bombs[bn++];
            if (!t.gameObject.activeSelf) t.gameObject.SetActive(true);
            t.SetPositionAndRotation(Arena.ArenaCore.BombPosition(k), rot);
            if (bombPrefab == null)
            {
                var mr = t.GetComponent<MeshRenderer>();
                if (mr != null && debrisMaterialForBombs != null) mr.sharedMaterial = debrisMaterialForBombs;
            }
        }
    }

    [Tooltip("Bombs are dark metal, not team-coloured - they belong to nobody once released.")]
    public Material debrisMaterialForBombs;

    /// <summary>
    /// A bomb, from the model where there is one.
    ///
    /// The model is turned so its LONGEST axis points along +Z before anything
    /// else happens, because the wrapper is then rotated to face the flight
    /// path - and a body modelled nose-up would otherwise fall sideways. Which
    /// axis that is gets measured rather than assumed; the pack does not say.
    /// </summary>
    Transform MakeBomb()
    {
        if (bombPrefab == null) return MakePiece(_bomb, "Bomb", false, Vector3.zero);

        var wrapper = new GameObject("Bomb");
        wrapper.transform.SetParent(transform, false);
        var model = Instantiate(bombPrefab, wrapper.transform);
        model.transform.localPosition = Vector3.zero;

        var rs = model.GetComponentsInChildren<Renderer>(true);
        if (rs.Length > 0)
        {
            Bounds B()
            {
                var bb = rs[0].bounds;
                foreach (var r in rs) bb.Encapsulate(r.bounds);
                return bb;
            }
            var b = B();
            // point the long axis down +Z
            if (b.size.y >= b.size.x && b.size.y >= b.size.z)
                model.transform.localRotation = Quaternion.Euler(90f, 0f, 0f);
            else if (b.size.x > b.size.z)
                model.transform.localRotation = Quaternion.Euler(0f, 90f, 0f);

            b = B();
            float longest = Mathf.Max(b.size.x, Mathf.Max(b.size.y, b.size.z));
            if (longest > 0.0001f) model.transform.localScale = Vector3.one * (bombLength / longest);

            b = B();
            // centre it on the wrapper, so it spins about itself in flight
            model.transform.localPosition -= wrapper.transform.InverseTransformPoint(b.center);
        }

        Rematerialise(wrapper, null);
        foreach (var c in wrapper.GetComponentsInChildren<Collider>(true)) DestroyImmediate(c);
        return wrapper.transform;
    }

    Transform MakeHelicopter()
    {
        if (helicopterPrefab != null)
        {
            var wrapped = WrapOnItsSole(helicopterPrefab, transform, "Helicopter", helicopterLength, Measure.LongestHorizontal);
            // a flying model must not be resting on the ground like a tank
            var inner = wrapped.transform.childCount > 0 ? wrapped.transform.GetChild(0) : null;
            if (inner != null) inner.localPosition = Vector3.zero;
            foreach (var c in wrapped.GetComponentsInChildren<Collider>(true)) DestroyImmediate(c);
            // THIS was missing, and it is why the model helicopter was invisible
            // while the placeholder was not: no URP materials, nothing drawn.
            Rematerialise(wrapped, null);

            // Tail rotors are named for the end they sit on, and packs disagree
            // about which word that is - this one calls it Back_Rotor. Check the
            // tail FIRST, or a name containing "rotor" is claimed by the main.
            Transform main = null, tail = null;
            foreach (var t in wrapped.GetComponentsInChildren<Transform>(true))
            {
                string n = t.name.ToLowerInvariant();
                if (!n.Contains("rotor")) continue;
                bool isTail = n.Contains("tail") || n.Contains("back") || n.Contains("rear");
                if (isTail) { tail ??= t; }
                else { main ??= t; }
            }
            _heliRotors[wrapped.transform] = (main, tail);

            var rs = wrapped.GetComponentsInChildren<Renderer>(true);
            if (rs.Length > 0)
            {
                var b = rs[0].bounds;
                foreach (var r in rs) b.Encapsulate(r.bounds);
                Debug.Log($"[Heli] built from model: {rs.Length} renderers, size {b.size}, " +
                          $"scale {wrapped.transform.GetChild(0).localScale.x:0.000}, " +
                          $"rotors main={(main != null ? main.name : "none")} tail={(tail != null ? tail.name : "none")}");
            }
            else Debug.LogWarning("[Heli] model has no renderers");
            return wrapped.transform;
        }

        // crude airframe: a body with a rotor disc, enough to read as a gunship
        var go = new GameObject("Helicopter");
        go.transform.SetParent(transform, false);
        var body = MakeChild(go.transform, _heliBody, "Body", Vector3.zero);
        var rotor = MakeChild(go.transform, _heliRotor, "MainRotor", new Vector3(0f, 1.6f, 1f));
        var tailRotor = MakeChild(go.transform, _heliRotor, "TailRotor", new Vector3(0f, 1.2f, -5.6f));
        tailRotor.localScale = new Vector3(0.34f, 1f, 0.34f);
        _heliRotors[go.transform] = (rotor, tailRotor);
        _ = body;
        return go.transform;
    }

    Transform MakeChild(Transform parent, Mesh mesh, string name, Vector3 local)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        go.transform.localPosition = local;
        go.AddComponent<MeshFilter>().sharedMesh = mesh;
        var mr = go.AddComponent<MeshRenderer>();
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
        return go.transform;
    }

    static Transform FindDeep(Transform root, string name)
    {
        foreach (var t in root.GetComponentsInChildren<Transform>(true))
            if (t.name.ToLowerInvariant() == name) return t;
        return null;
    }

    /// <summary>Size each side's tank pool. Per side, because the tint is baked in.</summary>
    void FitArmourSided(int total)
    {
        int bull = 0, bear = 0;
        for (int i = 0; i < Arena.Layout.UNITS; i++)
        {
            if (!Arena.ArenaCore.UnitIsArmour(i) || !Arena.ArenaCore.UnitAlive(i)) continue;
            if (SideOf(i) == Army.Side.Bull) bull++; else bear++;
        }
        Fit(_hullsBull, bull, () => MakeTankFromPrefab(Army.Side.Bull));
        Fit(_hullsBear, bear, () => MakeTankFromPrefab(Army.Side.Bear));
    }

    /// <summary>Size one side's soldier pool to its current strength.</summary>
    void FitSided(List<Transform> pool, Army.Side side)
    {
        int need = 0;
        for (int i = 0; i < Arena.Layout.UNITS; i++)
        {
            if (Arena.ArenaCore.UnitIsArmour(i) || !Arena.ArenaCore.UnitAlive(i)) continue;
            if (SideOf(i) == side) need++;
        }
        Fit(pool, need, () => soldierPrefab != null
            ? MakeSoldierFromPrefab(side)
            : MakePiece(_soldier, "Soldier", false, Vector3.zero));
        // the proxy carries no team colour of its own, so give it one
        if (soldierPrefab == null)
        {
            var mat = side == Army.Side.Bull ? bullMaterial : bearMaterial;
            foreach (var t in pool)
            {
                var mr = t.GetComponent<MeshRenderer>();
                if (mr != null && mr.sharedMaterial != mat) mr.sharedMaterial = mat;
            }
        }
    }

    /// <summary>Grow the pool to fit, and park anything spare out of sight.</summary>
    static void Fit(List<Transform> pool, int need, System.Func<Transform> make)
    {
        while (pool.Count < need) pool.Add(make());
        for (int i = need; i < pool.Count; i++)
            if (pool[i].gameObject.activeSelf) pool[i].gameObject.SetActive(false);
    }

    void LateUpdate() => Submit();

    /// <summary>
    /// Place every piece for this frame. Called from LateUpdate; public so a
    /// visibility test can place and render inside a single frame, because
    /// batch mode never fires WaitForEndOfFrame.
    /// </summary>
    /// <summary>
    /// §11.4/§11.5, FOR TESTS ONLY: how many men the last Submit laid on the ground, and the transforms it placed.
    /// Read-only seams. Nothing in the game reads them and they decide nothing - they exist so a suite can assert
    /// that the renderer poses from the CORE's posture word rather than from a guess of its own.
    /// </summary>
    public int MenDrawnDown => _downDrawn;
    public IReadOnlyList<Transform> SoldiersOf(Army.Side side) =>
        side == Army.Side.Bull ? _soldiersBull : _soldiersBear;

    public void Submit()
    {
        if (!CoreReady) return;

        int armour = 0;
        for (int i = 0; i < Arena.Layout.UNITS; i++)
            if (Arena.ArenaCore.UnitIsArmour(i) && Arena.ArenaCore.UnitAlive(i)) armour++;

        if (tankPrefab != null)
        {
            // the model brings its own turret, so no separate pool is needed
            FitArmourSided(armour);
        }
        else
        {
            Fit(_hulls, armour, () => MakePiece(_hull, "Hull", true, new Vector3(3.4f, 1.5f, 6.2f)));
            Fit(_turrets, armour, () => MakePiece(_turret, "Turret", false, Vector3.zero));
        }
        // The pool is per side, because a soldier's team colour is baked into
        // the instance - a shared pool would hand a green body to a red man.
        FitSided(_soldiersBull, Army.Side.Bull);
        FitSided(_soldiersBear, Army.Side.Bear);

        PlaceAircraft();

        int bullTanks = 0, bearTanks = 0, dense = 0;
        // WHAT IS ACTUALLY DRAWN, against what the core holds. The core does
        // not stack its armour - measured in node, the closest two tanks are
        // 8.21 m apart across a 142 m spread - so if the picture is a heap the
        // gap is here. Reported once every few seconds, not every frame.
        bool say = Time.time - _saidTanks > 4f;
        if (say) _saidTanks = Time.time;
        int liveArmour = 0, drawnArmour = 0, skipped = 0;
        var resting = new int[7];
        float deepest = float.MaxValue, highest = float.MinValue;
        // AND THE SAME AGAIN PER TRACK CORNER (2026-09-16). The census above measures the
        // hull's lowest point against the ground under its CENTRE, and a centre reading hides tilt:
        // a hull reads as seated while one track is in the dirt, which is the fault the player sees
        // as ground drawn inside the hull. The four corners are `RestOnTerrain`'s own half-length
        // and half-width, so the diagnostic and the seating describe one rectangle.
        var corners = new int[7];
        float deepestCorner = float.MaxValue, highestCorner = float.MinValue;
        float minX = float.MaxValue, maxX = float.MinValue;
        float minZ = float.MaxValue, maxZ = float.MinValue;
        float closest = float.MaxValue;
        var drawnAt = say ? new System.Collections.Generic.List<Vector3>() : null;

        for (int i = 0; i < Arena.Layout.UNITS; i++)
        {
            if (!Arena.ArenaCore.UnitIsArmour(i) || !Arena.ArenaCore.UnitAlive(i)) continue;
            liveArmour++;
            var side = SideOf(i);
            var at = Arena.ArenaCore.UnitPosition(i, 0f);
            float heading = Arena.ArenaCore.UnitHeading(i) * Mathf.Deg2Rad;
            bool prefab = tankPrefab != null;

            Transform hull;
            if (prefab)
            {
                var pool = side == Army.Side.Bull ? _hullsBull : _hullsBear;
                int idx = side == Army.Side.Bull ? bullTanks++ : bearTanks++;
                if (idx >= pool.Count) { skipped++; continue; }
                hull = pool[idx];
            }
            else
            {
                if (dense >= _hulls.Count) { dense++; continue; }
                hull = _hulls[dense];
            }

            var mat = prefab ? null : (side == Army.Side.Bull ? bullMaterial : bearMaterial);
            if (!hull.gameObject.activeSelf) hull.gameObject.SetActive(true);
            RestOnTerrain(hull, at.x, at.z, heading + (prefab ? tankYawOffset * Mathf.Deg2Rad : 0f),
                          3.4f, 1.8f, prefab ? 0f : 0.9f);
            drawnArmour++;
            if (say)
            {
                // HOW FAR THE HULL'S LOWEST POINT IS FROM THE GROUND IT
                // STANDS ON. `RestOnTerrain` puts the transform's ORIGIN on
                // the plane fit, and if a model's origin is not its base the
                // hull sinks - which is exactly how the dust skirt ended up
                // 23 m down and the mushroom's stem 26 m down earlier in this
                // letter. Measured rather than assumed, and as a spread
                // rather than a mean.
                var hr = hull.GetComponentInChildren<Renderer>();
                if (hr != null)
                {
                    float clear = hr.bounds.min.y - Ground(hull.position.x, hull.position.z);
                    if (clear < deepest) deepest = clear;
                    if (clear > highest) highest = clear;
                    int k = clear < -1f ? 0 : clear < -0.3f ? 1 : clear < -0.05f ? 2
                          : clear <= 0.05f ? 3 : clear <= 0.3f ? 4 : clear <= 1f ? 5 : 6;
                    resting[k]++;
                }
                // In the hull's OWN frame at y = 0: `WrapOnItsSole` puts the model's base at the
                // wrapper's origin, so that plane is the track, and the tilt comes with the
                // transform rather than being averaged away.
                foreach (var corner in new[]
                {
                    new Vector3(1.8f, 0f, 3.4f), new Vector3(-1.8f, 0f, 3.4f),
                    new Vector3(1.8f, 0f, -3.4f), new Vector3(-1.8f, 0f, -3.4f),
                })
                {
                    var p = hull.TransformPoint(corner);
                    float clear = p.y - Ground(p.x, p.z);
                    if (clear < deepestCorner) deepestCorner = clear;
                    if (clear > highestCorner) highestCorner = clear;
                    int k = clear < -1f ? 0 : clear < -0.3f ? 1 : clear < -0.05f ? 2
                          : clear <= 0.05f ? 3 : clear <= 0.3f ? 4 : clear <= 1f ? 5 : 6;
                    corners[k]++;
                }
                var w = hull.position;
                foreach (var q in drawnAt)
                {
                    float d = Vector2.Distance(new Vector2(q.x, q.z), new Vector2(w.x, w.z));
                    if (d < closest) closest = d;
                }
                drawnAt.Add(w);
                if (w.x < minX) minX = w.x;  if (w.x > maxX) maxX = w.x;
                if (w.z < minZ) minZ = w.z;  if (w.z > maxZ) maxZ = w.z;
            }
            if (mat != null)
            {
                var mr = hull.GetComponent<MeshRenderer>();
                if (mr != null && mr.sharedMaterial != mat) mr.sharedMaterial = mat;
            }

            // THE TURRET LOOKS WHERE `StepArmour` WOULD HAVE LOOKED. It used
            // to be glued to the hull, because the core has no turret word and
            // is not getting one for a quantity that decides nothing. The aim
            // is derived from core state and smoothed here; `LerpAngle` at
            // 2.6 per second is C#'s own rate.
            if (_turretYaw.Length != Arena.Layout.UNITS)
                _turretYaw = new float[Arena.Layout.UNITS];
            float aim = AimOf(i, at, heading, side);
            _turretYaw[i] = Mathf.LerpAngle(_turretYaw[i] * Mathf.Rad2Deg, aim * Mathf.Rad2Deg,
                                            1f - Mathf.Exp(-2.6f * Time.deltaTime)) * Mathf.Deg2Rad;
            float yaw = _turretYaw[i];

            if (prefab)
            {
                var turret = FindDeep(hull, "turret");
                // The model's turret is a child of the hull, so the hull's own
                // rotation has to come off the world aim or the two would add.
                if (turret != null)
                    turret.localRotation = Quaternion.Euler(0f, (yaw - heading) * Mathf.Rad2Deg, 0f);
                SpinRunningGear(hull);
            }
            else if (dense < _turrets.Count)
            {
                Place(_turrets[dense], new Vector3(at.x, hull.position.y, at.z), yaw, mat);
            }
            dense++;
        }

        if (say && drawnArmour > 0)
            Debug.Log($"[ground] tanks at tick {Arena.ArenaCore.Tick}: hull bottom vs ground - "
                      + $"under 1 m {resting[0]}, 0.3-1 m under {resting[1]}, 5-30 cm under {resting[2]}, "
                      + $"on it {resting[3]}, 5-30 cm over {resting[4]}, 0.3-1 m over {resting[5]}, "
                      + $"over 1 m {resting[6]}; deepest {deepest:F2} m, highest {highest:F2} m");
        if (say && drawnArmour > 0)
            Debug.Log($"[ground] tank corners at tick {Arena.ArenaCore.Tick}: track corner vs the ground "
                      + $"under it, {drawnArmour * 4} corners - under 1 m {corners[0]}, "
                      + $"0.3-1 m under {corners[1]}, 5-30 cm under {corners[2]}, on it {corners[3]}, "
                      + $"5-30 cm over {corners[4]}, 0.3-1 m over {corners[5]}, over 1 m {corners[6]}; "
                      + $"deepest {deepestCorner:F2} m, highest {highestCorner:F2} m");
        if (say)
            Debug.Log($"[tanks] core alive {liveArmour}, drawn {drawnArmour}, "
                      + $"skipped for want of a hull {skipped}; drawn x "
                      + $"{minX:F1}..{maxX:F1} ({(maxX - minX):F1} m), z "
                      + $"{minZ:F1}..{maxZ:F1} ({(maxZ - minZ):F1} m), "
                      + $"closest pair {(closest < float.MaxValue ? closest.ToString("F2") : "n/a")} m");

        int bull = 0, bear = 0;
        _downDrawn = 0;                     // per frame, like bull and bear above it
        for (int i = 0; i < Arena.Layout.UNITS; i++)
        {
            if (Arena.ArenaCore.UnitIsArmour(i) || !Arena.ArenaCore.UnitAlive(i)) continue;
            var side = SideOf(i);
            var pool = side == Army.Side.Bull ? _soldiersBull : _soldiersBear;
            int idx = side == Army.Side.Bull ? bull++ : bear++;
            if (idx >= pool.Count) continue;

            var at = Arena.ArenaCore.UnitPosition(i, 0f);
            float heading = Arena.ArenaCore.UnitHeading(i) * Mathf.Deg2Rad;

            // §11.4 / §11.5: A MAN THE CORE HAS PUT DOWN IS DRAWN DOWN. The core writes STAND / PRONE / COVER
            // into TAC_COVER's high bits and pins a fire team in TAC_SUPP; until now this renderer read neither,
            // so a man crawling on his belly at 0.5 m/s was drawn walking upright and the whole of suppression
            // was invisible - the one moment the rule exists for, a shell landing beside him, looked like
            // nothing. It READS those words and poses from them; it decides nothing and writes nothing back.
            int posture = Arena.ArenaCore.UnitPosture(i);
            bool down = posture != Arena.Layout.POSTURE_STAND;
            if (down) _downDrawn++;

            // A small bob, so a line of infantry does not read as fenceposts.
            // Derived from the tick and the slot, NOT from a gait the core
            // keeps - it keeps none, which is its own listed gap (q). This is
            // decoration, computed where decoration belongs.
            // A man on the ground does not bob: the bob is a walking cue.
            float bob = down ? 0f : Mathf.Abs(Mathf.Sin(Arena.ArenaCore.Tick * 0.08f + i)) * 0.16f;
            float lift = SoldierLift(down, soldierPrefab != null, soldierProneDrop);
            var t = pool[idx];
            // A man stands UPRIGHT on a slope - he does not lean with the
            // ground the way a tank does - but he still has to stand on the
            // highest ground his feet cover, or the downhill foot sinks in.
            float foot = Mathf.Max(
                Mathf.Max(Ground(at.x + 0.3f, at.z), Ground(at.x - 0.3f, at.z)),
                Mathf.Max(Ground(at.x, at.z + 0.3f), Ground(at.x, at.z - 0.3f)));
            Place(t, new Vector3(at.x, Mathf.Max(foot, Ground(at.x, at.z)) + lift + bob, at.z),
                  heading + soldierYawOffset * Mathf.Deg2Rad, null);
            // ...and he lies along the way he was facing. Pitched forward about his own axis, not laid on the
            // terrain's normal: a man goes flat, he does not drape over a slope the way a hull does.
            if (down) t.localRotation = t.localRotation * Quaternion.Euler(soldierPronePitch, 0f, 0f);
            // §11.4: WHERE A DOWNED MAN ACTUALLY ENDED UP, read back off the transform rather than restated from
            // the arithmetic above - the fixture already knows what the formula says, and what is wanted here is
            // what the screen holds. Negative is under the ground he stands on. Instrumentation only.
#if UNITY_EDITOR || DEVELOPMENT_BUILD
            // NOT A PLAYER-FACING LINE (ruled 2026-09-20). This fires whenever the down-count changes, which is
            // most frames, and it is the instrumentation that PROVED the sole-anchor sink - not something a player
            // needs beside "[render] drew N units". Compiled out of a release build; to re-measure, build with
            // -Development. The 0.00 m result itself is kept in SoldierLiftTests and in TASKBOOK.
            {
                float over = t.position.y - Ground(at.x, at.z);
                if (down)
                {
                    _downOverSum += over; _downOverN++;
                    if (over < _downOverWorst) _downOverWorst = over;
                }
                else { _upOverSum += over; _upOverN++; }
            }
#endif

            // Height per man is a core gap, listed as (q). One size until it
            // exists - guessing one here would be a second simulation of a
            // thing the core is supposed to own.
            if (!Mathf.Approximately(t.localScale.x, 1f)) t.localScale = Vector3.one;

            if (soldierAnimator != null)
            {
                var anim = t.GetComponentInChildren<Animator>();
                if (anim != null && anim.runtimeAnimatorController != null)
                {
                    // The core's infantry HAS a halt now, and a crawl: §11.4 writes STAND / PRONE / COVER and
                    // §11.5 pins a team. "Always walking" was true when the core kept no gait; it is not any
                    // more, and a man the core has on the ground is not walking. Speed comes from the posture
                    // word rather than from a guess made from position.
                    anim.SetFloat("Speed", down ? 0f : 1f);
                    anim.SetBool("Shoot", false);
                }
            }
        }

        // WHAT WAS ACTUALLY DRAWN, said out loud when it changes.
        //
        // Three picture comparisons failed to prove anything: with the game
        // running, 500 ms of ordinary motion moved 53019 pixels against the
        // 42094 that killing every unit moved, and freezing the core still
        // left 44042 moving because rotors, HUD and camera do not stop. The
        // scene animates more than the army does, so a screenshot cannot
        // isolate it. A count can. This is instrumentation, not a rule: it
        // decides nothing and only reports what the loops above placed.
        int drawn = bullTanks + bearTanks + bull + bear;
        if (drawn != _lastDrawn)
        {
            _lastDrawn = drawn;
            Debug.Log($"[render] drew {drawn} units from the core");
        }
        // §11.4/§11.5, and for the same reason the line above exists: a screenshot cannot isolate the army, but a
        // count can. This says how many of the men just placed were laid on the ground because the core has them
        // PRONE or COVER. It decides nothing and only reports what the loop above did.
        if (_downDrawn != _lastDownDrawn)
        {
            _lastDownDrawn = _downDrawn;
            Debug.Log($"[render] {_downDrawn} of {bull + bear} men drawn DOWN from the core's posture word");
            // The height that goes with that count: a downed man must sit ON the ground, not under it. `prefab`
            // says which anchor is in play, because the fallback box is centre-anchored and legitimately sits at
            // +0.15 while a sole-anchored prefab man sits at +0.00.
#if UNITY_EDITOR || DEVELOPMENT_BUILD
            if (_downOverN > 0)
                Debug.Log($"[render] downed men sit {_downOverSum / _downOverN:F2} m over the ground, "
                          + $"worst {_downOverWorst:F2} m; standing men "
                          + $"{(_upOverN > 0 ? (_upOverSum / _upOverN).ToString("F2") : "n/a")} m; "
                          + $"prefab {(soldierPrefab != null ? "yes" : "no")}");
#endif
        }
#if UNITY_EDITOR || DEVELOPMENT_BUILD
        _downOverSum = 0f; _downOverN = 0; _downOverWorst = float.MaxValue;
        _upOverSum = 0f; _upOverN = 0;
#endif
    }

    int _lastDrawn = -1;
    /// <summary>§11.4/§11.5: how many men the last frame laid on the ground. Instrumentation only.</summary>
    int _downDrawn, _lastDownDrawn = -1;
    /// <summary>§11.4: how far over the ground the last frame's downed men sat. Instrumentation only.</summary>
#if UNITY_EDITOR || DEVELOPMENT_BUILD
    float _downOverSum, _downOverWorst = float.MaxValue;
    int _downOverN;
    /// <summary>The same for men still on their feet, as the control the downed number is read against.</summary>
    float _upOverSum; int _upOverN;
#endif

    /// <summary>The combat mixer, found once. Only ever told what the core did.</summary>
    public GameAudio audio;

    /// <summary>
    /// Where each tank's barrel points, one entry per unit slot.
    ///
    /// CLIENT MEMORY, NOT CORE STATE. `Army.cs` carried `turretYaw` on the
    /// unit and traversed it in world space, and it read that word back
    /// NOWHERE: a shot is `Random01() &lt; 0.55f` and the target is chosen by
    /// distance and heat, so the barrel's angle decides nothing. Unread state
    /// does not belong in a hashed core - it would cost `U_WORDS` 8 to 9,
    /// every offset after it, every golden vector, `ArenaLayout.cs` and the C#
    /// buffer, to move none of the seventy-eight numbers the core is compared
    /// on. So the aim is derived here from state the core already publishes
    /// and smoothed here, in the same class as the infantry's bob off
    /// `ArenaCore.Tick` and the running gear. Nothing is written back.
    /// </summary>
    float[] _turretYaw = new float[0];
    float _saidTanks = -99f;

    /// <summary>
    /// Where a tank would be looking, following `StepArmour`'s own choice.
    ///
    /// Engaged - the nearest enemy TANK inside 46 m, which is what
    /// `NearestEnemy` walks and what `foeD2 &lt; 46f * 46f` tests - and the
    /// barrel goes straight to it. That half is C#'s rule exactly.
    ///
    /// Not engaged, C# sweeps across a point `(x + sin(phase) * 14,
    /// front + Dir * 20)`. ONE SUBSTITUTION, and it is named rather than
    /// hidden: the renderer has no frontline. The seam is derived inside the
    /// core from the price tape every tick and is not a state word, so no
    /// accessor can hand it over. The sweep is taken about the direction to
    /// the nearest enemy tank instead - at any distance, not just inside 46 m
    /// - over the same 14 m of lateral wander at that distance.
    ///
    /// MEASURED, because the first version of this centred the sweep on the
    /// hull's own heading and that was wrong: against C#'s own centre, over
    /// eight seeds at four marks, the hull heading sits a mean 77 to 84
    /// degrees away and as much as 176, while the enemy's direction sits 22
    /// to 27 away and at most 81. A tank not in contact is manoeuvring, and
    /// where its hull points is not where the enemy line is. The sweep's
    /// WIDTH was right either way - C# 12.6 to 13.9 degrees mean, this 11.9
    /// to 12.5 - so only the centre moved.
    /// </summary>
    static float AimOf(int i, Vector3 at, float heading, Army.Side side)
    {
        float bestD2 = float.MaxValue, fx = 0f, fz = 0f;
        for (int j = 0; j < Arena.Layout.UNITS; j++)
        {
            if (j == i || !Arena.ArenaCore.UnitIsArmour(j) || !Arena.ArenaCore.UnitAlive(j)) continue;
            if (SideOf(j) == side) continue;
            var o = Arena.ArenaCore.UnitPosition(j, 0f);
            float d2 = (o.x - at.x) * (o.x - at.x) + (o.z - at.z) * (o.z - at.z);
            if (d2 < bestD2) { bestD2 = d2; fx = o.x; fz = o.z; }
        }
        if (bestD2 < 46f * 46f) return Mathf.Atan2(fx - at.x, fz - at.z);

        // `v.phase += dt * 0.4f` in C#, off a per-unit draw. Off the tick and
        // the slot here, the way the bob is: no state, same slow wander, and
        // no two tanks in step.
        float phase = Arena.ArenaCore.Tick * (0.4f / 60f) + i * 0.7f;
        if (bestD2 == float.MaxValue) return heading;      // nobody left to look at
        float ahead = Mathf.Sqrt(bestD2);
        return Mathf.Atan2(fx - at.x, fz - at.z)
             + Mathf.Atan2(Mathf.Sin(phase) * 14f, Mathf.Max(1f, ahead));
    }

    static void Place(Transform t, Vector3 pos, float yawRadians, Material mat)
    {
        if (!t.gameObject.activeSelf) t.gameObject.SetActive(true);
        t.SetPositionAndRotation(pos, Quaternion.Euler(0f, yawRadians * Mathf.Rad2Deg, 0f));
        if (mat == null) return;
        var mr = t.GetComponent<MeshRenderer>();
        if (mr != null && mr.sharedMaterial != mat) mr.sharedMaterial = mat;
    }

    /// <summary>
    /// Turn the road wheels by how far the tank actually moved.
    ///
    /// Driven from distance rather than a clock, so a tank standing still has
    /// still wheels - which is most of what makes tracked movement read as
    /// movement rather than sliding.
    /// </summary>
    void SpinRunningGear(Transform hull)
    {
        if (!_tankWheels.TryGetValue(hull, out var wheels) || wheels.Count == 0) return;

        Vector3 now = hull.position;
        if (!_lastTankPos.TryGetValue(hull, out var was)) { _lastTankPos[hull] = now; return; }
        _lastTankPos[hull] = now;

        float travelled = Vector3.Dot(now - was, hull.forward);
        const float WheelRadius = 0.42f;
        float degrees = travelled / WheelRadius * Mathf.Rad2Deg;
        foreach (var w in wheels) w.Rotate(degrees, 0f, 0f, Space.Self);
    }

    /// <summary>
    /// The surface to stand on: the road deck where there is one, otherwise the
    /// ground. The deck sits 45 cm over the terrain, so sampling the terrain
    /// alone left everything driving through the road it was standing on.
    /// </summary>
    /// <summary>The fallback box is centre-anchored, so it stands at half a 1.8 m man.</summary>
    public const float BoxStandLift = 0.9f;

    /// <summary>
    /// §11.4/§11.5: how far above the ground under his feet a man is drawn, by posture.
    ///
    /// TWO ANCHORS, TWO ANSWERS, and conflating them is what put downed men under the dirt. The fallback BOX is
    /// CENTRE-anchored: it stands at half its height, 0.9, and laid flat it sits at about half its thickness, so
    /// `0.9 - soldierProneDrop` = 0.15 is right for it and is kept exactly as it was. The real PREFAB is
    /// SOLE-anchored - `WrapOnItsSole` puts the origin at the man's soles - so a standing man is at +0 and a man
    /// laid flat is ALSO at +0: the 82-degree pitch applied after this swings his body down about his own feet,
    /// which is what lying down is. Subtracting the box's drop from a sole anchor instead drove his feet under
    /// the ground and took the rest of him with them.
    ///
    /// MEASURED BEFORE THIS (2026-09-20, 2 seeds x 40 s): 20550 man-ticks standing on a hole, 98.9% of them DOWN,
    /// each drawn 0.74 m below the surface his own feet stood on - the same 0.74 on candle lips, crater rims and
    /// wrecks alike, which is how it was known not to be the crater bowl. Unity carves no bowl: MempoolTerrain's
    /// HeightAt returns ArenaCore.TerrainAt, and the core has already cut it.
    ///
    /// Draw only. Nothing here reads combat, driving or scoring, and the core is not consulted - which is also
    /// what lets EditMode assert it without a browser core behind ArenaCore.Available.
    /// </summary>
    public static float SoldierLift(bool down, bool hasPrefab, float proneDrop)
        => hasPrefab ? 0f : (down ? BoxStandLift - proneDrop : BoxStandLift);

    float Ground(float x, float z) =>
        roads != null ? roads.SurfaceHeight(x, z)
                      : (Arena.ArenaCore.HasSurface ? Arena.ArenaCore.SurfaceAt(x, z)
                                                  : (terrain != null ? terrain.SampleSurface(x, z) : 0f));

    /// <summary>Eased attitude per pooled hull, so tanks do not jitter.</summary>
    readonly Dictionary<Transform, Vector2> _attitude = new Dictionary<Transform, Vector2>();

    /// <summary>
    /// Sit a hull ON the ground it is standing on, not at one point above it.
    ///
    /// A seven metre vehicle placed from a single sample and left level buries
    /// its nose or its tail the moment the ground is not flat - which is most
    /// of this map, because the terrain is the fee histogram. Four samples
    /// around the footprint give both the height it rests at and the attitude
    /// it rests in.
    ///
    /// The height is the AVERAGE of the samples, not the highest: once the hull
    /// is tilted into the slope its underside already lies in that plane, and
    /// the plane passes through the average. Taking the maximum as well counted
    /// the slope twice and left the tanks visibly hovering.
    ///
    /// The attitude is eased rather than taken raw. Sampled fresh every frame
    /// off a histogram that updates live, it snapped about while they drove.
    /// </summary>
    void RestOnTerrain(Transform t, float x, float z, float yaw,
                       float halfLength, float halfWidth, float lift = 0f)
    {
        // heading is Unity yaw here - Army sets it with Atan2(dx, dz) - so the
        // nose is (sin, cos) and the right flank is (cos, -sin)
        float c = Mathf.Cos(yaw), s2 = Mathf.Sin(yaw);
        float fx = s2 * halfLength, fz = c * halfLength;
        float rx = c * halfWidth, rz = -s2 * halfWidth;

        float front = Ground(x + fx, z + fz);
        float back = Ground(x - fx, z - fz);
        float right = Ground(x + rx, z + rz);
        float left = Ground(x - rx, z - rz);

        float rest = (front + back + right + left) * 0.25f;
        // Both signs are inverted against the ground on purpose: a positive
        // rotation about local X pitches the NOSE DOWN, and a positive rotation
        // about local Z lifts the RIGHT side. Taken the intuitive way round the
        // hull tilts against the slope and doubles the error instead of
        // cancelling it - measured at one track corner 0.85 m under the ground
        // with the opposite corner 0.79 m above it.
        float pitch = Mathf.Atan2(back - front, halfLength * 2f) * Mathf.Rad2Deg;
        float roll = Mathf.Atan2(right - left, halfWidth * 2f) * Mathf.Rad2Deg;

        // clamped: a spike in the fee histogram should tilt a tank, not stand it
        // on its nose
        pitch = Mathf.Clamp(pitch, -18f, 18f);
        roll = Mathf.Clamp(roll, -14f, 14f);

        if (_attitude.TryGetValue(t, out var was))
        {
            float k = 1f - Mathf.Exp(-6f * Time.deltaTime);
            pitch = Mathf.Lerp(was.x, pitch, k);
            roll = Mathf.Lerp(was.y, roll, k);
        }
        _attitude[t] = new Vector2(pitch, roll);

        // NO TRACK CORNER UNDER THE GROUND IT STANDS ON (2026-09-16).
        //
        // The fit above samples four EDGE MIDPOINTS and the hull rests on four CORNERS, which it
        // never sampled - and the attitude finally applied is not even the one it computed: pitch and
        // roll are clamped and then eased towards the fit over several frames. So the corners are
        // measured against the ground under each of them, with the rotation that is about to be
        // used, and the hull is raised by the worst shortfall. Measured before this, one Daily run:
        // 270 of 1596 corners under the ground, 16.9%, the deepest 0.63 m down.
        //
        // This replaces the old `saddle` term, which lifted by the better of the two mid-pairs - a
        // guess at the corners from points that are not them. A lift along Y only: the plane fit
        // still decides the attitude, so no chase is coupled into x or z.
        var attitude = Quaternion.Euler(0f, yaw * Mathf.Rad2Deg, 0f) * Quaternion.Euler(pitch, 0f, roll);
        float sink = 0f;
        for (int k = 0; k < 4; k++)
        {
            // the hull's own corners, at the same half-length and half-width the caller seats it by
            var corner = new Vector3((k & 1) == 0 ? halfWidth : -halfWidth, 0f,
                                     (k & 2) == 0 ? halfLength : -halfLength);
            var at = new Vector3(x, rest, z) + attitude * corner;
            sink = Mathf.Max(sink, Ground(at.x, at.z) - at.y);
        }
        rest += sink;

        // OVER A CANDLE'S FACE IN 0.3 s (WAR_TACTICS.md §4.15: "a tank crossing a face steps 2 m up or down in the core,
        // and the renderer eases the hull over 0.3 s"). The core's height is the target; the drawn height moves toward it
        // at most a plateau's height per 0.3 s, so a face is a climb the eye sees and ordinary slopes (a tank at 5 m/s on
        // the relief's 55% is 2.75 m/s) are followed without lag. A hull that jumped sideways (pooled, respawned) snaps.
        if (_rest.TryGetValue(t, out var drawn) && (new Vector2(drawn.x - x, drawn.z - z)).sqrMagnitude < SnapDistance * SnapDistance)
            rest = EaseRest(drawn.y, rest, Time.deltaTime);
        _rest[t] = new Vector3(x, rest, z);

        t.SetPositionAndRotation(new Vector3(x, rest + lift, z), attitude);
    }

    /// <summary>Drawn rest height per pooled hull (x, height, z), for the face ease.</summary>
    readonly Dictionary<Transform, Vector3> _rest = new Dictionary<Transform, Vector3>();

    /// <summary>A hull that moved farther than this in a frame was placed, not driven: it snaps to its ground.</summary>
    public const float SnapDistance = 3f;

    /// <summary>The time a candle's full face takes to climb or drop, drawn.</summary>
    public const float FaceSeconds = 0.3f;

    /// <summary>
    /// The drawn height one frame on: toward the core's <paramref name="target"/> at most a plateau
    /// (Layout.CANDLE_H) per <see cref="FaceSeconds"/>. Pure, for the tests.
    /// </summary>
    public static float EaseRest(float drawn, float target, float dt) =>
        Mathf.MoveTowards(drawn, target, Arena.Layout.CANDLE_H / 65536f / FaceSeconds * Mathf.Max(0f, dt));
}
