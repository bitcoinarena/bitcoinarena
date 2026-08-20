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

    /// <summary>
    /// Units live on their own layer with self-collision switched off. The Army
    /// logic already pushes hulls apart; letting the physics engine do it too
    /// means two systems fighting over the same positions every frame.
    /// </summary>
    public const int UnitLayer = 8;

    Mesh _hull, _turret, _soldier;
    readonly List<Transform> _hulls = new List<Transform>();
    readonly List<Transform> _turrets = new List<Transform>();
    readonly List<Transform> _soldiersBull = new List<Transform>();
    readonly List<Transform> _soldiersBear = new List<Transform>();

    void Awake()
    {
        Physics.IgnoreLayerCollision(UnitLayer, UnitLayer, true);
        _hull = Box(new Vector3(3.4f, 1.5f, 6.2f), "TankHull");
        _turret = Turret();
        _soldier = Box(new Vector3(0.7f, 1.8f, 0.5f), "Soldier");
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
        var go = Instantiate(soldierPrefab, transform);
        go.name = "Soldier";
        go.layer = UnitLayer;

        // scale from the actual rendered bounds, not a guess about units
        var renderers = go.GetComponentsInChildren<Renderer>(true);
        if (renderers.Length > 0)
        {
            var bounds = renderers[0].bounds;
            foreach (var r in renderers) bounds.Encapsulate(r.bounds);
            if (bounds.size.y > 0.0001f)
            {
                float k = soldierHeight / bounds.size.y;
                go.transform.localScale = Vector3.one * k;
            }
        }

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
        foreach (var c in go.GetComponentsInChildren<Collider>(true)) DestroyImmediate(c);
        var box = go.AddComponent<BoxCollider>();
        box.size = new Vector3(0.7f, soldierHeight, 0.5f);
        box.center = new Vector3(0f, soldierHeight * 0.5f, 0f);
        var rb = go.AddComponent<Rigidbody>();
        rb.isKinematic = true;
        rb.useGravity = false;

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

    /// <summary>Size one side's soldier pool to its current strength.</summary>
    void FitSided(List<Transform> pool, Army.Side side)
    {
        int need = 0;
        foreach (var u in army.Infantry) if (u.side == side) need++;
        Fit(pool, need, () => soldierPrefab != null
            ? MakeSoldierFromPrefab(side)
            : MakePiece(_soldier, "Soldier", true, new Vector3(0.7f, 1.8f, 0.5f)));
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
        Fit(_hulls, armour, () => MakePiece(_hull, "Hull", true, new Vector3(3.4f, 1.5f, 6.2f)));
        Fit(_turrets, armour, () => MakePiece(_turret, "Turret", false, Vector3.zero));
        // The pool is per side, because a soldier's team colour is baked into
        // the instance - a shared pool would hand a green body to a red man.
        FitSided(_soldiersBull, Army.Side.Bull);
        FitSided(_soldiersBear, Army.Side.Bear);

        for (int i = 0; i < armour; i++)
        {
            var v = army.Armour[i];
            float y = Ground(v.x, v.z) + 0.9f;
            var mat = v.side == Army.Side.Bull ? bullMaterial : bearMaterial;

            Place(_hulls[i], new Vector3(v.x, y, v.z), v.heading, mat);
            // the turret traverses in world space, so it is NOT parented to the hull
            Place(_turrets[i], new Vector3(v.x, y, v.z), v.turretYaw, mat);
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
            Place(pool[idx], new Vector3(s.x, Ground(s.x, s.z) + lift + bob, s.z),
                  s.heading + soldierYawOffset * Mathf.Deg2Rad, null);
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

    float Ground(float x, float z) => terrain != null ? terrain.SampleSurface(x, z) : 0f;
}
