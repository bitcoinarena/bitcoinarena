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
        public bool isModelBody, bull;
    }

    enum Kind { Tracer, Flash, Blast, Body, Wreck }

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

        army.Killed += (u, knock) =>
        {
            // a model body stands on the ground; the proxy box is centred
            float lift = bodyPrefab != null ? 0f : 0.9f;
            Body(new Vector3(u.x, Ground(u.x, u.z) + lift, u.z), u.heading,
                 u.side == Army.Side.Bull, knock);
        };

        army.Destroyed += v =>
        {
            var at = new Vector3(v.x, Ground(v.x, v.z) + 1.2f, v.z);
            Blast(at, 9f);
            Wreck(at, v.heading);
        };
    }
}
