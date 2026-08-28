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
    public Army army;
    public MempoolTerrain terrain;
    public Material bullMaterial;
    public Material bearMaterial;

    [Header("Optional imported models")]
    [Tooltip("Soldier prefab. Falls back to a box if empty, so the scene always runs.")]
    public GameObject soldierPrefab;
    [Tooltip("Metres tall. The prefab is scaled to this, whatever units it was authored in.")]
    public float soldierHeight = 1.8f;
    [Tooltip("Degrees to add so the model faces +Z, which is what the army logic assumes.")]
    public float soldierYawOffset;
    [Tooltip("Controller built from the pack's clips. Without it the model stands in its bind pose.")]
    public RuntimeAnimatorController soldierAnimator;

    [Tooltip("Tank prefab. Falls back to a box hull and turret if empty.")]
    public GameObject tankPrefab;
    [Tooltip("Helicopter prefab. Falls back to a crude airframe if empty.")]
    public GameObject helicopterPrefab;
    public float helicopterLength = 14f;
    public float helicopterYawOffset;
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
        var go = WrapOnItsSole(tankPrefab, transform, "Hull", tankWidth, true);
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

        var tint = side == Army.Side.Bull ? bullMaterial : bearMaterial;
        foreach (var r in go.GetComponentsInChildren<Renderer>(true))
        {
            var mats = new Material[r.sharedMaterials.Length];
            for (int i = 0; i < mats.Length; i++) mats[i] = TeamMaterial(r.sharedMaterials[i], tint);
            r.sharedMaterials = mats;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
        }

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
        var go = WrapOnItsSole(soldierPrefab, transform, "Soldier", soldierHeight, false);
        go.layer = UnitLayer;

        var tint = side == Army.Side.Bull ? bullMaterial : bearMaterial;
        foreach (var r in go.GetComponentsInChildren<Renderer>(true))
        {
            var mats = new Material[r.sharedMaterials.Length];
            for (int i = 0; i < mats.Length; i++) mats[i] = TeamMaterial(r.sharedMaterials[i], tint);
            r.sharedMaterials = mats;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
        }

        // colliders come from the asset in whatever shape it likes; replace
        // them with the same box the rest of the army uses
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
    Material TeamMaterial(Material source, Material tint)
    {
        var key = (source, tint);
        if (_teamCache.TryGetValue(key, out var cached)) return cached;

        var shader = Shader.Find("Universal Render Pipeline/Lit");
        var m = shader != null ? new Material(shader) : new Material(tint);
        m.SetColor("_BaseColor", tint.GetColor("_BaseColor"));

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
    static GameObject WrapOnItsSole(GameObject prefab, Transform parent, string name,
                                    float wantedSize, bool sizeByNarrowest)
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
        float measure = sizeByNarrowest ? Mathf.Min(bounds.size.x, bounds.size.z) : bounds.size.y;
        if (measure > 0.0001f) model.transform.localScale = Vector3.one * (wantedSize / measure);

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
    void PlaceAircraft()
    {
        Fit(_helis, army.Helicopters.Count, MakeHelicopter);
        for (int i = 0; i < army.Helicopters.Count; i++)
        {
            var h = army.Helicopters[i];
            if (i >= _helis.Count) break;
            var t = _helis[i];
            if (!t.gameObject.activeSelf) t.gameObject.SetActive(true);

            t.SetPositionAndRotation(
                new Vector3(h.x, h.y, h.z),
                Quaternion.Euler(0f, (h.yaw + helicopterYawOffset * Mathf.Deg2Rad) * Mathf.Rad2Deg,
                                 h.bank * Mathf.Rad2Deg));

            var mat = h.side == Army.Side.Bull ? bullMaterial : bearMaterial;
            foreach (var r in t.GetComponentsInChildren<MeshRenderer>(true))
                if (mat != null && r.sharedMaterial != mat && helicopterPrefab == null)
                    r.sharedMaterial = mat;

            // rotors spin regardless of what the model provides
            if (_heliRotors.TryGetValue(t, out var rotors))
            {
                if (rotors.main != null) rotors.main.Rotate(0f, 1500f * Time.deltaTime, 0f, Space.Self);
                if (rotors.tail != null) rotors.tail.Rotate(2200f * Time.deltaTime, 0f, 0f, Space.Self);
            }
        }

        Fit(_bombs, army.Bombs.Count, () => MakePiece(_bomb, "Bomb", false, Vector3.zero));
        for (int i = 0; i < army.Bombs.Count; i++)
        {
            var b = army.Bombs[i];
            if (i >= _bombs.Count) break;
            // noses along its own flight path, so it does not fall sideways
            var vel = new Vector3(b.vx, b.vy, b.vz);
            var rot = vel.sqrMagnitude > 0.01f
                ? Quaternion.LookRotation(vel.normalized, Vector3.up) : Quaternion.identity;
            var t = _bombs[i];
            if (!t.gameObject.activeSelf) t.gameObject.SetActive(true);
            t.SetPositionAndRotation(new Vector3(b.x, b.y, b.z), rot);
            var mr = t.GetComponent<MeshRenderer>();
            if (mr != null && debrisMaterialForBombs != null) mr.sharedMaterial = debrisMaterialForBombs;
        }
    }

    [Tooltip("Bombs are dark metal, not team-coloured - they belong to nobody once released.")]
    public Material debrisMaterialForBombs;

    Transform MakeHelicopter()
    {
        if (helicopterPrefab != null)
        {
            var wrapped = WrapOnItsSole(helicopterPrefab, transform, "Helicopter", helicopterLength, false);
            // a flying model must not be seated on the ground like a tank
            var inner = wrapped.transform.childCount > 0 ? wrapped.transform.GetChild(0) : null;
            if (inner != null) inner.localPosition = Vector3.zero;
            foreach (var c in wrapped.GetComponentsInChildren<Collider>(true)) DestroyImmediate(c);

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
        foreach (var v in army.Armour) { if (v.side == Army.Side.Bull) bull++; else bear++; }
        Fit(_hullsBull, bull, () => MakeTankFromPrefab(Army.Side.Bull));
        Fit(_hullsBear, bear, () => MakeTankFromPrefab(Army.Side.Bear));
    }

    /// <summary>Size one side's soldier pool to its current strength.</summary>
    void FitSided(List<Transform> pool, Army.Side side)
    {
        int need = 0;
        foreach (var u in army.Infantry) if (u.side == side) need++;
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
    public void Submit()
    {
        if (army == null) return;

        int armour = army.Armour.Count;
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

        int bullTanks = 0, bearTanks = 0;
        for (int i = 0; i < armour; i++)
        {
            var v = army.Armour[i];
            bool prefab = tankPrefab != null;
            // a prefab stands ON the ground; the proxy box is centred on its middle
            float y = Ground(v.x, v.z) + (prefab ? 0f : 0.9f);

            Transform hull;
            if (prefab)
            {
                var pool = v.side == Army.Side.Bull ? _hullsBull : _hullsBear;
                int idx = v.side == Army.Side.Bull ? bullTanks++ : bearTanks++;
                if (idx >= pool.Count) continue;
                hull = pool[idx];
            }
            else hull = _hulls[i];

            var mat = prefab ? null : (v.side == Army.Side.Bull ? bullMaterial : bearMaterial);
            Place(hull, new Vector3(v.x, y, v.z), v.heading + (prefab ? tankYawOffset * Mathf.Deg2Rad : 0f), mat);

            if (prefab)
            {
                // world traverse expressed relative to the hull it sits on
                var turret = FindDeep(hull, "turret");
                if (turret != null)
                    turret.localRotation = Quaternion.Euler(
                        0f, (v.turretYaw - v.heading) * Mathf.Rad2Deg, 0f);
                SpinRunningGear(hull);
            }
            else
            {
                // the turret traverses in world space, so it is NOT parented to the hull
                Place(_turrets[i], new Vector3(v.x, y, v.z), v.turretYaw, mat);
            }
        }

        int bull = 0, bear = 0;
        foreach (var s in army.Infantry)
        {
            var pool = s.side == Army.Side.Bull ? _soldiersBull : _soldiersBear;
            int idx = s.side == Army.Side.Bull ? bull++ : bear++;
            if (idx >= pool.Count) continue;

            // a small bob, so a line of infantry does not read as fenceposts
            float bob = Mathf.Abs(Mathf.Sin(s.phase)) * 0.16f;
            // a prefab stands ON the ground; the proxy box is centred on its middle
            float lift = soldierPrefab != null ? 0f : 0.9f;
            var t = pool[idx];
            Place(t, new Vector3(s.x, Ground(s.x, s.z) + lift + bob, s.z),
                  s.heading + soldierYawOffset * Mathf.Deg2Rad, null);
            // one model repeated at one size is what makes a rank look stamped
            // out; a few percent either way is enough to break that
            if (!Mathf.Approximately(t.localScale.x, s.height))
                t.localScale = Vector3.one * s.height;

            if (soldierAnimator != null)
            {
                var anim = t.GetComponentInChildren<Animator>();
                if (anim != null && anim.runtimeAnimatorController != null)
                {
                    // The army decides whether he is walking; the renderer must
                    // not guess it again from position, or the two disagree and
                    // he runs on the spot or slides while standing.
                    anim.SetFloat("Speed", s.walking ? 1f : 0f);
                    anim.SetBool("Shoot", !s.walking);
                }
            }
        }
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

    float Ground(float x, float z) => terrain != null ? terrain.SampleSurface(x, z) : 0f;
}
