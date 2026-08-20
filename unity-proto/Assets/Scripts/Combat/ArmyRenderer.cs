using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Draws both armies.
///
/// Instanced rather than a GameObject per unit: a few hundred soldiers as
/// GameObjects costs a Transform hierarchy, a Renderer and a culling entry
/// each, for models that are boxes. This walks the plain unit list and issues
/// one draw per mesh per side.
/// </summary>
public class ArmyRenderer : MonoBehaviour
{
    public Army army;
    public MempoolTerrain terrain;
    public Material bullMaterial;
    public Material bearMaterial;

    /// <summary>RenderMeshInstanced takes at most 1023 matrices per call.</summary>
    const int Batch = 1023;

    Mesh _hull, _turret, _soldier;
    readonly Dictionary<(Army.Side, int), List<Matrix4x4>> _batches = new Dictionary<(Army.Side, int), List<Matrix4x4>>();

    void Awake()
    {
        _hull = Box(new Vector3(3.4f, 1.5f, 6.2f), "TankHull");
        _turret = Turret();
        _soldier = Box(new Vector3(0.7f, 1.8f, 0.5f), "Soldier");

        foreach (Army.Side side in new[] { Army.Side.Bull, Army.Side.Bear })
            for (int kind = 0; kind < 3; kind++)
                _batches[(side, kind)] = new List<Matrix4x4>();
    }

    static Mesh Box(Vector3 size, string name)
    {
        var m = new Mesh { name = name };
        var t = GameObject.CreatePrimitive(PrimitiveType.Cube);
        var src = t.GetComponent<MeshFilter>().sharedMesh;
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

    /// <summary>Turret box with a barrel poking out of the front, as one mesh.</summary>
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

    void LateUpdate() => Submit();

    /// <summary>
    /// Hand this frame's instances to the renderer. Separate from LateUpdate so
    /// a test can submit and render in the same frame - batch mode never fires
    /// WaitForEndOfFrame, so there is no other way to catch a submission.
    /// </summary>
    public void Submit()
    {
        if (army == null || bullMaterial == null || bearMaterial == null) return;

        foreach (var list in _batches.Values) list.Clear();

        foreach (var v in army.Armour)
        {
            float y = Ground(v.x, v.z);
            // hull yaw is its line of advance; the turret traverses in world
            // space, so it is NOT parented to the hull's rotation
            _batches[(v.side, 0)].Add(Matrix4x4.TRS(
                new Vector3(v.x, y + 0.9f, v.z), Quaternion.Euler(0f, v.heading * Mathf.Rad2Deg, 0f), Vector3.one));
            _batches[(v.side, 1)].Add(Matrix4x4.TRS(
                new Vector3(v.x, y + 0.9f, v.z), Quaternion.Euler(0f, v.turretYaw * Mathf.Rad2Deg, 0f), Vector3.one));
        }

        foreach (var s in army.Infantry)
        {
            float y = Ground(s.x, s.z);
            // a small bob, so a line of infantry does not read as fenceposts
            float bob = Mathf.Abs(Mathf.Sin(s.phase)) * 0.16f;
            _batches[(s.side, 2)].Add(Matrix4x4.TRS(
                new Vector3(s.x, y + 0.9f + bob, s.z),
                Quaternion.Euler(0f, s.heading * Mathf.Rad2Deg, 0f), Vector3.one));
        }

        Draw(Army.Side.Bull, 0, _hull); Draw(Army.Side.Bear, 0, _hull);
        Draw(Army.Side.Bull, 1, _turret); Draw(Army.Side.Bear, 1, _turret);
        Draw(Army.Side.Bull, 2, _soldier); Draw(Army.Side.Bear, 2, _soldier);
    }

    float Ground(float x, float z) => terrain != null ? terrain.SampleSurface(x, z) : 0f;

    void Draw(Army.Side side, int kind, Mesh mesh)
    {
        var list = _batches[(side, kind)];
        if (list.Count == 0) return;
        var rp = new RenderParams(side == Army.Side.Bull ? bullMaterial : bearMaterial)
        {
            receiveShadows = true,
            shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On,
            // REQUIRED. worldBounds defaults to a zero-size box at the origin,
            // and instanced draws are culled against it - leave it alone and
            // every unit is submitted every frame and never appears.
            worldBounds = new Bounds(Vector3.zero, new Vector3(600f, 400f, 600f)),
        };
        for (int i = 0; i < list.Count; i += Batch)
        {
            int n = Mathf.Min(Batch, list.Count - i);
            Graphics.RenderMeshInstanced(rp, mesh, 0, list.GetRange(i, n).ToArray(), n);
        }
    }
}
