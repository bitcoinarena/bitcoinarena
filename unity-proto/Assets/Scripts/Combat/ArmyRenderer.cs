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

    /// <summary>
    /// Units live on their own layer with self-collision switched off. The Army
    /// logic already pushes hulls apart; letting the physics engine do it too
    /// means two systems fighting over the same positions every frame.
    /// </summary>
    public const int UnitLayer = 8;

    Mesh _hull, _turret, _soldier;
    readonly List<Transform> _hulls = new List<Transform>();
    readonly List<Transform> _turrets = new List<Transform>();
    readonly List<Transform> _soldiers = new List<Transform>();

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
        Fit(_soldiers, army.Infantry.Count,
            () => MakePiece(_soldier, "Soldier", true, new Vector3(0.7f, 1.8f, 0.5f)));

        for (int i = 0; i < armour; i++)
        {
            var v = army.Armour[i];
            float y = Ground(v.x, v.z) + 0.9f;
            var mat = v.side == Army.Side.Bull ? bullMaterial : bearMaterial;

            Place(_hulls[i], new Vector3(v.x, y, v.z), v.heading, mat);
            // the turret traverses in world space, so it is NOT parented to the hull
            Place(_turrets[i], new Vector3(v.x, y, v.z), v.turretYaw, mat);
        }

        for (int i = 0; i < army.Infantry.Count; i++)
        {
            var s = army.Infantry[i];
            // a small bob, so a line of infantry does not read as fenceposts
            float bob = Mathf.Abs(Mathf.Sin(s.phase)) * 0.16f;
            Place(_soldiers[i], new Vector3(s.x, Ground(s.x, s.z) + 0.9f + bob, s.z), s.heading,
                  s.side == Army.Side.Bull ? bullMaterial : bearMaterial);
        }
    }

    static void Place(Transform t, Vector3 pos, float yawRadians, Material mat)
    {
        if (!t.gameObject.activeSelf) t.gameObject.SetActive(true);
        t.SetPositionAndRotation(pos, Quaternion.Euler(0f, yawRadians * Mathf.Rad2Deg, 0f));
        var mr = t.GetComponent<MeshRenderer>();
        if (mat != null && mr.sharedMaterial != mat) mr.sharedMaterial = mat;
    }

    float Ground(float x, float z) => terrain != null ? terrain.SampleSurface(x, z) : 0f;
}
