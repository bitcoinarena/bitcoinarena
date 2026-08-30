using UnityEngine;

/// <summary>
/// The far end of the run: drive the freight through the gate and it is
/// delivered.
///
/// This closes the loop the loading bay opens. Without it the player picks
/// transactions, drives across a battlefield and then nothing happens, which
/// makes the whole cargo system decoration.
///
/// The gate is built in code, like the rest of the scene, and it is WIDE: the
/// point of the run is surviving the war in the middle, not threading a needle
/// at the end of it.
/// </summary>
public class DeliveryGate : MonoBehaviour
{
    public Transform courier;
    public CargoBay bay;
    public TruckController truck;
    public TruckHealth health;
    public LoadoutPanel loadout;
    public MempoolTerrain terrain;
    public CombatFx fx;
    public GameAudio audio;

    [Tooltip("Where the gate stands. Mirrors the spawn at the other end.")]
    public float gateX = 114f;

    [Tooltip("Half the width of the mouth, along z.")]
    public float halfMouth = 34f;

    public Material postMaterial;

    /// <summary>Total fees delivered, in sats. This is the score.</summary>
    public long SatsDelivered { get; private set; }

    /// <summary>Completed runs.</summary>
    public int Runs { get; private set; }

    /// <summary>Sats banked by the last run, for the HUD flash.</summary>
    public long LastRun { get; private set; }

    /// <summary>BTC moved by the last run, for the block tally.</summary>
    public double LastBtc { get; private set; }

    /// <summary>Seconds since the last delivery, or a large number.</summary>
    public float SinceDelivery { get; private set; } = 999f;

    public System.Action<long> Delivered;

    void Start() => Build();

    void Update()
    {
        SinceDelivery += Time.deltaTime;
        if (courier == null || bay == null) return;
        if (health != null && health.IsDestroyed) return;
        if (!bay.IsLoaded) return;

        var p = courier.position;
        if (p.x < gateX || Mathf.Abs(p.z) > halfMouth) return;

        Deliver();
    }

    void Deliver()
    {
        LastRun = bay.FeeCarried;
        LastBtc = bay.BtcCarried;
        SatsDelivered += LastRun;
        Runs++;
        SinceDelivery = 0f;

        if (fx != null)
        {
            // arrival is worth a bang, not an explosion
            var at = courier.position + Vector3.up * 1.5f;
            for (int i = 0; i < 12; i++)
                fx.Flash(at + new Vector3(Random.Range(-4f, 4f), Random.Range(0f, 4f),
                                          Random.Range(-4f, 4f)), Random.Range(1f, 2.4f));
        }

        if (audio == null) audio = FindFirstObjectByType<GameAudio>();
        if (audio != null) audio.Delivered();

        Delivered?.Invoke(LastRun);

        // back to the ramp for the next run
        bay.Clear();
        if (truck != null) truck.Respawn();
        if (loadout != null) loadout.Open();
    }

    /// <summary>Two posts and a beam. Enough to read as a goal from a distance.</summary>
    void Build()
    {
        float ground = terrain != null ? terrain.SampleSurface(gateX, 0f) : 0f;
        const float height = 9f;

        Post(new Vector3(gateX, ground + height * 0.5f, -halfMouth),
             new Vector3(2f, height, 2f), "GatePostLeft");
        Post(new Vector3(gateX, ground + height * 0.5f, halfMouth),
             new Vector3(2f, height, 2f), "GatePostRight");
        Post(new Vector3(gateX, ground + height, 0f),
             new Vector3(2.2f, 2.2f, halfMouth * 2f), "GateBeam");
    }

    void Post(Vector3 at, Vector3 size, string name)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = name;
        var col = go.GetComponent<Collider>();
        if (col != null) Destroy(col);          // a goal you can crash into is a wall
        go.transform.SetParent(transform, false);
        go.transform.position = at;
        go.transform.localScale = size;
        if (postMaterial != null) go.GetComponent<MeshRenderer>().sharedMaterial = postMaterial;
    }
}
