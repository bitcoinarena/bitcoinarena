// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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

    [Tooltip("Space left between packages, in metres. Flush together they read " +
             "as one block of cardboard rather than as separate parcels.")]
    public float gap = 0.15f;

    public Material crateMaterial;

    [Tooltip("Optional cardboard box model. Falls back to a plain cube, which " +
             "is what every crate was until this was imported.")]
    public GameObject boxPrefab;

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

    [Tooltip("Fees carried at which the wanted level is at its maximum.")]
    public float heatAtSats = 20000f;

    /// <summary>
    /// The BTC aboard in hundredths, which is what crosses to the core.
    ///
    /// A whole number on purpose: the core is integer arithmetic and the
    /// boundary is where a rounding rule would differ between two machines.
    /// </summary>
    public int BtcHundredths => (int)System.Math.Round(BtcCarried * 100.0);

    /// <summary>
    /// How badly the war wants this load, 0..1 - THE YARD'S PREVIEW OF IT.
    ///
    /// This number no longer reaches the simulation. `LoadoutPanel` hands the
    /// core the LOAD at roll-out - fee sats and hundredths of a BTC - and the
    /// core's own `rules/cargo.js` decides what it costs; from the first tick
    /// on, every gauge reads `ArenaCore.Heat`, which is the word the shooting
    /// reads. What is left here is the gauge the player watches WHILE they
    /// choose, before there is a round to ask.
    ///
    /// Its three constants are pinned against the core's by
    /// `arena-node/test/replay-heat.test.js`, so the preview and the rule
    /// cannot drift apart without a red test.
    ///
    /// Driven by the FEES aboard - what the run pays out - not by the value
    /// being moved. Against value, a 25,000 sat load came out at 1% risk,
    /// which is both wrong and unreadable: the player is hunted for the prize
    /// they are carrying, and the prize is the fee.
    ///
    /// A whale still adds on top, because a bed carrying twenty-five BTC is
    /// worth diverting armour for whatever it pays. The 25 BTC is the core's
    /// (cargo.js BTC_AT_FULL), not the truck's 20 BTC load limit: a full truck
    /// does not fill this term, and that is the game's real heat (the owner
    /// 2026-09-30 - the gauge shows the core, the core is not moved to 20).
    /// </summary>
    public float Heat
    {
        get
        {
            float fromFees = Mathf.Clamp01(FeeCarried / Mathf.Max(1f, heatAtSats));
            float fromValue = Mathf.Clamp01((float)(BtcCarried / 25.0)) * 0.45f;
            return Mathf.Clamp01(fromFees + fromValue);
        }
    }

    /// <summary>What each package would add to the wanted level, for the UI.</summary>
    public float HeatOf(MempoolFeed.Tx tx) =>
        tx == null ? 0f : Mathf.Clamp01(tx.feeSats / Mathf.Max(1f, heatAtSats));

    /// <summary>The vsizes on the bed, comma-separated: what the load carries to the core, which sums its own roomFor.</summary>
    public string VsizeList
    {
        get
        {
            var sb = new System.Text.StringBuilder();
            foreach (var s in Slots) { if (s.tx == null) continue; if (sb.Length > 0) sb.Append(','); sb.Append(s.tx.vsize); }
            return sb.ToString();
        }
    }

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
    /// What one package adds to the cargo factor, as a fraction of the bed.
    ///
    /// This is the honest answer to "what does loading this buy me": a share
    /// of C in score = 1000 * E * T * C, and nothing else. Its sats are the
    /// transaction's fee and go to the miner, not to the player.
    /// </summary>
    public float ShareOf(MempoolFeed.Tx tx)
    {
        float total = bedLength * columns;
        return total > 0f ? Mathf.Clamp01(RoomFor(tx) / total) : 0f;
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

    /// <summary>
    /// HOW MUCH BTC ONE TRUCK CARRIES TO THE MINERS: 20 BTC (2026-09-29, CARGO-BTC-2148, after the measurement:
    /// "Instead of 15.92 btc make the limit 20 btc"). The measurement it replaced: 150 mainnet blocks, 969043-969192
    /// (mempool.space, 2026-09-29), a median 6,792 BTC of outputs over a median 4,452 transactions - 1.592 BTC a
    /// transaction; a full bed of ten parcels of an average block, 15.92 BTC. The parcels are the live mempool's own
    /// transactions at their own value (sampled: median 0.0036 BTC, 90th percentile 0.43, a few in the hundreds), so most
    /// trucks fill by room, a whale (25 BTC and up) does not fit one truck, and a few big transactions fill it by value.
    /// </summary>
    public const double BtcLimit = 20.0;

    /// <summary>0..1, how much of the truck's BTC limit is on board.</summary>
    public float BtcFill => (float)System.Math.Min(1.0, BtcCarried / BtcLimit);

    /// <summary>Does it still fit? Asked before a click is allowed to land: the room on the bed and the BTC limit.</summary>
    public bool Fits(MempoolFeed.Tx tx)
    {
        if (tx != null && BtcCarried + tx.Btc > BtcLimit + 1e-9) return false;
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
        // AND THE TRUCK'S BTC LIMIT, here as in Fits: measured, AUTO loaded the 30 BTC whale first (it pays the most per
        // vbyte), the truck read full by value, and AUTO stopped at one parcel.
        if (BtcCarried + tx.Btc > BtcLimit + 1e-9) return false;

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

    /// <summary>
    /// THE BED CHANGED LENGTH (LargeTruckView: the larger truck's 3.9 m, or back to 3.0): every crate packed again
    /// from the front over the new bed - what no longer fits on a shorter one stays off.
    /// </summary>
    public void ReflowForNewBed() => Repack();

    /// <summary>Close the gap left by a crate taken off the bed.</summary>
    void Repack()
    {
        var kept = new List<MempoolFeed.Tx>();
        foreach (var s in Slots) kept.Add(s.tx);
        foreach (var s in Slots) if (s.crate != null) Destroy(s.crate);
        Slots.Clear();
        foreach (var tx in kept) TryAdd(tx);
    }

    /// <summary>
    /// Sit every crate in its slot, FILLING it.
    ///
    /// The crates used to be sized to 82% of the room they claimed, which left
    /// a gap on every side of every package and made a full bed look like a
    /// few boxes rattling around in it. A crate now takes the whole width of
    /// its column and the whole length of its slot; the transaction's size is
    /// still visible, in how much of the bed it takes and in how tall it
    /// stands.
    /// </summary>
    void Reflow()
    {
        float colW = bedWidth / columns;
        foreach (var s in Slots)
        {
            float x = bedFloor.x - bedWidth * 0.5f + colW * (s.column + 0.5f);
            float z = bedFloor.z + bedLength * 0.5f - (s.along + s.length * 0.5f);

            // height follows the package, width and depth follow the slot
            float tall = Mathf.Clamp(CrateSize(s.tx) * 0.95f, 0.42f, colW * 1.15f);

            s.crate.transform.localPosition = new Vector3(x, bedFloor.y + tall * 0.5f, z);
            s.crate.transform.localRotation = Quaternion.identity;   // stacked, not strewn
            // A hand's width between packages. Flush against each other they
            // read as one block of cardboard rather than as a load of separate
            // parcels.
            s.crate.transform.localScale = new Vector3(
                Mathf.Max(0.2f, colW - gap), tall, Mathf.Max(0.2f, s.length - gap));
        }
    }

    public GameObject MakeCrate(MempoolFeed.Tx tx)
    {
        return boxPrefab != null ? ModelCrate(tx) : CubeCrate(tx);
    }

    GameObject CubeCrate(MempoolFeed.Tx tx)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = "Package";
        // no collider on the bed: a crate bolted to the truck must not fight
        // the truck's own body for the same space
        var col = go.GetComponent<Collider>();
        if (col != null) Destroy(col);

        var mr = go.GetComponent<MeshRenderer>();
        if (crateMaterial != null)
            mr.sharedMaterial = new Material(crateMaterial) { color = CrateColour(tx) };
        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
        return go;
    }

    /// <summary>
    /// A real cardboard box, wrapped so it behaves exactly like the cube it
    /// replaces: one unit across and sitting on its own underside, so every
    /// caller can keep setting localScale and be done.
    ///
    /// The colour is kept. It is not decoration - it says what the transaction
    /// pays - so the model is tinted rather than left in its own brown.
    /// </summary>
    GameObject ModelCrate(MempoolFeed.Tx tx)
    {
        var wrapper = new GameObject("Package");
        var model = Instantiate(boxPrefab, wrapper.transform);
        model.transform.localPosition = Vector3.zero;
        // Square to the wrapper. A random yaw looked lively in the panel and
        // like a badly loaded truck on the bed, where the boxes are supposed
        // to be stacked. The panel spins them anyway.
        model.transform.localRotation = Quaternion.identity;

        foreach (var c in model.GetComponentsInChildren<Collider>(true)) DestroyImmediate(c);

        var rs = model.GetComponentsInChildren<Renderer>(true);
        if (rs.Length == 0) { Destroy(wrapper); return CubeCrate(tx); }

        var bounds = rs[0].bounds;
        foreach (var r in rs) bounds.Encapsulate(r.bounds);

        // scale so the box is one unit on its widest horizontal axis, then sit
        // it on the wrapper's origin
        float widest = Mathf.Max(0.0001f, Mathf.Max(bounds.size.x, bounds.size.z));
        float k = 1f / widest;
        model.transform.localScale = Vector3.one * k;
        model.transform.localPosition = -(bounds.center - model.transform.position) * k
                                        + Vector3.up * (bounds.size.y * k * 0.5f);

        var tint = CrateColour(tx);
        foreach (var r in rs)
        {
            var mats = new Material[r.sharedMaterials.Length];
            for (int i = 0; i < mats.Length; i++)
            {
                var src = r.sharedMaterials[i];
                // Built-in shaders draw nothing in a URP build, so anything
                // imported is rebuilt on URP/Lit - the same trap the soldiers,
                // the tanks and the helicopter all fell into.
                var m = new Material(Shader.Find("Universal Render Pipeline/Lit"));
                if (src != null && src.HasProperty("_MainTex"))
                    m.SetTexture("_BaseMap", src.GetTexture("_MainTex"));
                else if (src != null && src.HasProperty("_BaseMap"))
                    m.SetTexture("_BaseMap", src.GetTexture("_BaseMap"));
                m.color = tint;
                mats[i] = m;
            }
            r.sharedMaterials = mats;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
        }
        return wrapper;
    }
}
