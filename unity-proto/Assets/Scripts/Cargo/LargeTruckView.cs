using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// THE LARGER TRUCK, DRAWN (kanban #369, the first in-game item; the owner 2026-10-15: "a larger truck for 500 satoshis. It can load
/// 30% more packages and is slightly faster").
///
/// The core decides the truck: a run whose entry plays with the item is started with its unlock and drives a bed of 255590
/// (3.9 m, 1.3 x the standard 196608) - and its own drive acceleration, which reaches the screen by itself, since the view
/// follows the core's pose. What is left to draw is the length. Read off the core every frame
/// (<see cref="Blwp.BlwpCore.TruckBedMeters"/>), never chosen here:
///
///   - THE BAY takes the core's bed: the same front (behind the cab), the bed 0.9 m longer towards the tail, so 30 % more room
///     and the crates packed over all of it;
///   - THE BODY stretches only its bed: every vertex between the bed's front and its tail (the bay's own span, 3.0 m) is
///     spread over 3.9 m, everything behind it moves back the 0.9 m - the cab is untouched and the truck is 0.9 m longer.
///     The wheels left the body when it was dressed (Bootstrap.NormaliseTruckModel), so they are not stretched.
///
/// Back to the standard truck, every mesh is its original again. A body swapped in later (the model streaming in) is measured
/// and stretched afresh.
/// </summary>
[RequireComponent(typeof(CargoBay))]
public class LargeTruckView : MonoBehaviour
{
    /// <summary>The standard bed (CargoBay.bedLength, the core's BED_LENGTH 196608 / 65536).</summary>
    public const float StandardBed = 3.0f;

    CargoBay _bay;
    Vector3 _floor0;
    Transform _body;
    readonly List<(MeshFilter mf, Mesh original)> _meshes = new List<(MeshFilter, Mesh)>();
    float _applied = StandardBed;

    /// <summary>The bed length drawn now, in metres.</summary>
    public float AppliedBed => _applied;

    void Awake()
    {
        _bay = GetComponent<CargoBay>();
        _floor0 = _bay.bedFloor;
    }

    void Update()
    {
        float want = Blwp.BlwpCore.TruckBedMeters;
        if (want <= 0f) want = StandardBed;
        var body = transform.Find("Body") ?? transform.Find("BodyProxy");   // the model, or the box before it streams in
        if (body != _body) { Restore(); _body = body; _meshes.Clear(); _applied = StandardBed; }
        if (Mathf.Abs(want - _applied) > 0.0005f) Apply(want);
    }

    /// <summary>Draw a bed `bed` metres long (the core's), the front where the standard one starts.</summary>
    public void Apply(float bed)
    {
        float front = _floor0.z + StandardBed * 0.5f, rear = _floor0.z - StandardBed * 0.5f;
        float extra = bed - StandardBed;

        // THE BAY: same front, the core's length; its crates repacked over it
        _bay.bedLength = bed;
        _bay.bedFloor = new Vector3(_floor0.x, _floor0.y, front - bed * 0.5f);
        _bay.ReflowForNewBed();

        // THE BODY: its bed section spread over the new length, the tail moved back - from the original vertices every time
        if (_body != null)
        {
            if (_meshes.Count == 0)
                foreach (var mf in _body.GetComponentsInChildren<MeshFilter>(true))
                {
                    if (mf.sharedMesh == null) continue;
                    // the model's mesh is imported Read/Write (SmallTruck_1.FBX.meta isReadable), else it cannot be stretched
                    if (!mf.sharedMesh.isReadable) { Debug.LogWarning($"[LargeTruckView] mesh {mf.sharedMesh.name} is not readable: its bed is not drawn longer"); continue; }
                    _meshes.Add((mf, mf.sharedMesh));
                }
            float k = bed / StandardBed;
            foreach (var (mf, original) in _meshes)
            {
                if (mf == null) continue;
                if (Mathf.Abs(extra) < 0.0005f) { mf.sharedMesh = original; continue; }
                var src = original.vertices;
                var dst = new Vector3[src.Length];
                // the vertex in the truck's frame, stretched there, and back into the mesh's own
                var toTruck = transform.worldToLocalMatrix * mf.transform.localToWorldMatrix;
                var toMesh = toTruck.inverse;
                for (int i = 0; i < src.Length; i++)
                {
                    var p = toTruck.MultiplyPoint3x4(src[i]);
                    if (p.z < front && p.z >= rear) p.z = front - (front - p.z) * k;
                    else if (p.z < rear) p.z -= extra;
                    dst[i] = toMesh.MultiplyPoint3x4(p);
                }
                var m = Instantiate(original);
                m.name = original.name + " (larger truck)";
                m.vertices = dst;
                m.RecalculateBounds();
                mf.sharedMesh = m;
            }
        }
        _applied = bed;
        Debug.Log($"[LargeTruckView] bed {bed:0.000} m drawn ({(bed > StandardBed + 0.0005f ? "the larger truck" : "the standard truck")})");
    }

    void Restore()
    {
        foreach (var (mf, original) in _meshes) if (mf != null) mf.sharedMesh = original;
        if (_bay != null) { _bay.bedLength = StandardBed; _bay.bedFloor = _floor0; }
    }
}
