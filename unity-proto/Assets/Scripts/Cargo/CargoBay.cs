using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// The truck's flatbed: what is on it, where each crate sits, and whether the
/// next one still fits.
///
/// The bed geometry is MEASURED, not guessed. Sampling the truck mesh in its
/// own frame puts the cab roof at y 1.56 and the load floor at y 0.34, running
/// from z -3.0 to z 0.2. The first version had the crates at y 1.75 - above
/// everything - so they rode on the roof of the cab.
///
/// Capacity is space, not a count. Crates take room along the bed in
/// proportion to the transaction's size, so a bed full of big packages holds
/// fewer of them, and the player can see it filling up.
/// </summary>
public class CargoBay : MonoBehaviour
{
    [Header("Bed, in the truck's own frame")]
    public Vector3 bedFloor = new Vector3(0f, 0.36f, -1.40f);
    public float bedLength = 3.0f;
    public float bedWidth = 2.2f;

    [Tooltip("Crates are packed in this many columns down the bed.")]
    public int columns = 2;

    public Material crateMaterial;

    /// <summary>A package on the bed or in the yard.</summary>
    public class Slot
    {
        public MempoolFeed.Tx tx;
        public GameObject crate;
        public int column;
        public float along;        // distance from the front of the bed
        public float length;       // room it takes
    }

    public List<Slot> Slots { get; } = new List<Slot>();

    public bool IsLoaded => Slots.Count > 0;
    public int Count => Slots.Count;

    public long FeeCarried
    {
        get { long f = 0; foreach (var s in Slots) f += s.tx.feeSats; return f; }
    }

    public double BtcCarried
    {
        get { double b = 0; foreach (var s in Slots) b += s.tx.Btc; return b; }
    }

    /// <summary>
    /// How badly the war wants this load, 0..1.
    ///
    /// Value carried, not fees: a whale on the back is a prize worth diverting
    /// armour for, while a bed full of dust that happens to pay well is not.
    /// Twenty BTC aboard is as hot as it gets.
    /// </summary>
    public float Heat => Mathf.Clamp01((float)(BtcCarried / 20.0));

    /// <summary>0..1, how full the bed is. Drives the gauge.</summary>
    public float Fill
    {
        get
        {
            float total = bedLength * columns, used = 0f;
            foreach (var s in Slots) used += s.length;
            return total > 0f ? Mathf.Clamp01(used / total) : 1f;
        }
    }

    /// <summary>
    /// How much room a transaction takes. Four sizes, so the yard is not a row
    /// of identical boxes and the player can see what they are picking up.
    /// </summary>
    public static float RoomFor(MempoolFeed.Tx tx)
    {
        float room = tx.vsize < 250 ? 0.55f
                   : tx.vsize < 600 ? 0.78f
                   : tx.vsize < 1500 ? 1.05f
                   : 1.35f;
        return tx.Whale ? room * 1.2f : room;
    }

    /// <summary>The crate's own size in metres, from the room it takes.</summary>
    public static float CrateSize(MempoolFeed.Tx tx) => RoomFor(tx) * 0.82f;

    /// <summary>
    /// Colour by fee rate - what the next block is being paid. A whale rides
    /// in its own colour whatever it pays.
    /// </summary>
    public static Color CrateColour(MempoolFeed.Tx tx)
    {
        if (tx.Whale) return new Color(0.42f, 0.80f, 1f);
        float r = tx.FeeRate;
        if (r >= 40f) return new Color(1f, 0.80f, 0.20f);      // gold: top of the block
        if (r >= 15f) return new Color(0.42f, 0.82f, 0.42f);   // green: comfortable
        if (r >= 5f) return new Color(0.78f, 0.72f, 0.50f);    // straw: marginal
        return new Color(0.55f, 0.52f, 0.48f);                 // grey: going nowhere
    }

    public bool Contains(string txid)
    {
        foreach (var s in Slots) if (s.tx.txid == txid) return true;
        return false;
    }

    /// <summary>Does it still fit? Asked before a click is allowed to land.</summary>
    public bool Fits(MempoolFeed.Tx tx)
    {
        float need = RoomFor(tx);
        for (int c = 0; c < columns; c++)
            if (UsedIn(c) + need <= bedLength + 0.001f) return true;
        return false;
    }

    float UsedIn(int column)
    {
        float used = 0f;
        foreach (var s in Slots) if (s.column == column) used += s.length;
        return used;
    }

    /// <summary>Put it on the bed. False when there is no room left.</summary>
    public bool TryAdd(MempoolFeed.Tx tx)
    {
        if (tx == null || Contains(tx.txid)) return false;

        float need = RoomFor(tx);
        int best = -1; float bestUsed = float.MaxValue;
        for (int c = 0; c < columns; c++)
        {
            float used = UsedIn(c);
            if (used + need > bedLength + 0.001f) continue;
            if (used < bestUsed) { bestUsed = used; best = c; }
        }
        if (best < 0) return false;

        var slot = new Slot { tx = tx, column = best, along = bestUsed, length = need };
        slot.crate = MakeCrate(tx);
        slot.crate.transform.SetParent(transform, false);
        Slots.Add(slot);
        Reflow();
        return true;
    }

    public bool Remove(string txid)
    {
        for (int i = 0; i < Slots.Count; i++)
        {
            if (Slots[i].tx.txid != txid) continue;
            if (Slots[i].crate != null) Destroy(Slots[i].crate);
            Slots.RemoveAt(i);
            Repack();
            return true;
        }
        return false;
    }

    public void Clear()
    {
        foreach (var s in Slots) if (s.crate != null) Destroy(s.crate);
        Slots.Clear();
    }

    /// <summary>Close the gap left by a crate taken off the bed.</summary>
    void Repack()
    {
        var kept = new List<MempoolFeed.Tx>();
        foreach (var s in Slots) kept.Add(s.tx);
        foreach (var s in Slots) if (s.crate != null) Destroy(s.crate);
        Slots.Clear();
        foreach (var tx in kept) TryAdd(tx);
    }

    /// <summary>Sit every crate in its slot.</summary>
    void Reflow()
    {
        foreach (var s in Slots)
        {
            float colW = bedWidth / columns;
            float x = bedFloor.x - bedWidth * 0.5f + colW * (s.column + 0.5f);
            float z = bedFloor.z + bedLength * 0.5f - (s.along + s.length * 0.5f);
            float size = CrateSize(s.tx);
            s.crate.transform.localPosition = new Vector3(x, bedFloor.y + size * 0.5f, z);
            s.crate.transform.localScale = new Vector3(
                Mathf.Min(size, colW * 0.92f), size, Mathf.Min(size, s.length * 0.92f));
        }
    }

    public GameObject MakeCrate(MempoolFeed.Tx tx)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = "Package";
        // no collider on the bed: a crate bolted to the truck must not fight
        // the truck's own body for the same space
        var col = go.GetComponent<Collider>();
        if (col != null) Destroy(col);

        var mr = go.GetComponent<MeshRenderer>();
        if (crateMaterial != null)
        {
            var m = new Material(crateMaterial) { color = CrateColour(tx) };
            mr.sharedMaterial = m;
        }
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
        return go;
    }
}
