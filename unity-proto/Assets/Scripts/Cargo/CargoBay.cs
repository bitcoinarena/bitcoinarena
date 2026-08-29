using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// What the truck is carrying, and the boxes that show it.
///
/// The load is visible on the flatbed rather than only counted in the HUD: a
/// number in a corner is indistinguishable from a number that is wrong, and
/// this project has spent several rounds on exactly that difference.
/// </summary>
public class CargoBay : MonoBehaviour
{
    [Tooltip("How many packages fit on the bed.")]
    public int capacity = 6;

    [Tooltip("Material for the crates. Falls back to a plain one.")]
    public Material crateMaterial;

    [Header("Bed")]
    public Vector3 bedCentre = new Vector3(0f, 1.75f, -1.15f);
    public Vector2 bedSize = new Vector2(1.9f, 3.1f);

    public List<MempoolFeed.Tx> Manifest { get; } = new List<MempoolFeed.Tx>();

    public bool IsLoaded => Manifest.Count > 0;

    /// <summary>Total fee being carried, in sats. This is the score.</summary>
    public long FeeCarried
    {
        get { long f = 0; foreach (var t in Manifest) f += t.feeSats; return f; }
    }

    public double BtcCarried
    {
        get { double b = 0; foreach (var t in Manifest) b += t.Btc; return b; }
    }

    readonly List<GameObject> _crates = new List<GameObject>();

    /// <summary>Replace the load. Passing nothing empties the bed.</summary>
    public void Load(IEnumerable<MempoolFeed.Tx> picked)
    {
        Manifest.Clear();
        if (picked != null)
            foreach (var t in picked)
            {
                if (Manifest.Count >= capacity) break;
                Manifest.Add(t);
            }
        Rebuild();
    }

    public void Clear() => Load(null);

    void Rebuild()
    {
        foreach (var c in _crates) if (c != null) Destroy(c);
        _crates.Clear();

        for (int i = 0; i < Manifest.Count; i++)
        {
            var tx = Manifest[i];
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = "Package";
            // no collider: a crate bolted to the bed must not fight the truck's
            // own body for the same space
            var col = go.GetComponent<Collider>();
            if (col != null) Destroy(col);

            go.transform.SetParent(transform, false);

            // Two rows down the bed, so six crates read as a load rather than
            // as a stack. Size follows vsize, the way the original scaled them.
            int row = i / 2, col2 = i % 2;
            float w = bedSize.x * 0.5f;
            float step = bedSize.y / Mathf.Max(1, Mathf.CeilToInt(capacity / 2f));
            float size = Mathf.Clamp(0.45f + Mathf.Log10(Mathf.Max(140f, tx.vsize)) * 0.16f, 0.5f, 1.05f);

            go.transform.localPosition = bedCentre + new Vector3(
                (col2 == 0 ? -1f : 1f) * w * 0.45f,
                size * 0.5f,
                bedSize.y * 0.5f - step * (row + 0.5f));
            go.transform.localScale = Vector3.one * size;
            go.transform.localRotation = Quaternion.Euler(0f, Random.Range(-7f, 7f), 0f);

            var mr = go.GetComponent<MeshRenderer>();
            if (crateMaterial != null)
            {
                // a whale rides in its own colour, so the valuable one is
                // obvious on the bed
                var m = new Material(crateMaterial);
                if (tx.Whale) m.color = new Color(0.49f, 0.88f, 1f);
                mr.sharedMaterial = m;
            }
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;

            _crates.Add(go);
        }
    }
}
