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

    class Piece
    {
        public Transform t;
        public float life, age;
        public Vector3 baseScale;
        public Kind kind;
        public Quaternion fallFrom, fallTo;
    }

    enum Kind { Tracer, Flash, Blast, Body, Wreck }

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
        (p.t.GetComponent<MeshFilter>().sharedMesh == _sphere ? _spheres : _cubes).Push(p.t);
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

    /// <summary>A shell going off: grows fast, then collapses.</summary>
    public void Blast(Vector3 at, float size)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_spheres, _sphere, blastMaterial);
        t.SetPositionAndRotation(at, Quaternion.identity);
        var scale = Vector3.one * size;
        t.localScale = scale * 0.2f;
        _live.Add(new Piece { t = t, life = 0.55f, baseScale = scale, kind = Kind.Blast });
    }

    /// <summary>A rifleman going down: he topples, lies there, then sinks away.</summary>
    public void Body(Vector3 at, float heading, bool bull)
    {
        if (_live.Count >= maxPieces) return;
        var t = Take(_cubes, _cube, bull ? bullMaterial : bearMaterial);
        var scale = new Vector3(0.7f, 1.8f, 0.5f);
        t.localScale = scale;
        var upright = Quaternion.Euler(0f, heading * Mathf.Rad2Deg, 0f);
        // falls away from where he was facing, so a line goes down together
        var flat = upright * Quaternion.Euler(78f, 0f, 0f);
        t.SetPositionAndRotation(at, upright);
        _live.Add(new Piece
        {
            t = t, life = 5f, baseScale = scale, kind = Kind.Body,
            fallFrom = upright, fallTo = flat,
        });
    }

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
            float k = Mathf.Clamp01(p.age / p.life);

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
                    // topple over the first half second, then sink into the ground
                    p.t.rotation = Quaternion.Slerp(p.fallFrom, p.fallTo, Mathf.Clamp01(p.age / 0.5f));
                    if (k > 0.75f)
                        p.t.localScale = p.baseScale * Mathf.Lerp(1f, 0f, (k - 0.75f) / 0.25f);
                    break;
                case Kind.Wreck:
                    if (k > 0.7f) p.t.localScale = p.baseScale * Mathf.Lerp(1f, 0f, (k - 0.7f) / 0.3f);
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

        army.Killed += u => Body(new Vector3(u.x, Ground(u.x, u.z) + 0.9f, u.z), u.heading,
                               u.side == Army.Side.Bull);

        army.Destroyed += v =>
        {
            var at = new Vector3(v.x, Ground(v.x, v.z) + 1.2f, v.z);
            Blast(at, 9f);
            Wreck(at, v.heading);
        };
    }
}
