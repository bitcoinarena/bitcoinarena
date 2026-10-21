// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// Ties the live tape to the ground. The frontline is the price chart, and
/// which side of it you stand on decides whether the ground is bull or bear
/// territory.
/// </summary>
public class Battlefield : MonoBehaviour
{
    /// <summary>
    /// The one in the scene. The deterministic core needs the tank positions
    /// every tick, and hunting for it with FindFirstObjectByType at sixty
    /// hertz is a search per frame for something that never moves.
    /// </summary>
    public static Battlefield Current { get; private set; }

    void OnDestroy() { if (Current == this) Current = null; }

    public MempoolTerrain terrain;
    public MarketFeed market;
    /// <summary>The truck. The armies move aside for it.</summary>
    public Transform courier;

    [Tooltip("Optional. When set, the armies stop shooting at the truck while " +
             "it is burning, and hits are routed into its condition.")]
    public TruckHealth health;

    [Tooltip("Optional. Shaken when the truck rides somebody down. Found in " +
             "Start: Bootstrap builds the camera after this is wired up, so " +
             "anything assigned at wiring time would be null.")]
    public ChaseCamera chase;

    [Tooltip("Optional. The sound of somebody going under the wheels.")]
    public GameAudio audio;

    [Tooltip("Optional. What is on the truck sets how hard it is hunted.")]
    public CargoBay cargo;

    public PriceHistory History { get; private set; }
    /// <summary>Both armies. Owned here because they live and die by the same tape.</summary>
    public Army Army { get; set; }
    /// <summary>How many riflemen the courier has ridden down.</summary>
    public int RunDown { get; private set; }

    /// <summary>Simulated price when the live feed has nothing, so the map is never dead.</summary>
    double _simPrice = 63000;
    float _simVel;

    [Header("Air support")]
    [Tooltip("Seconds between sorties, per side. Rare enough that one is an event.")]
    public float sortieSeconds = 17f;


    void Awake()
    {
        Current = this;
        History = new PriceHistory(96);
    }

    void Start()
    {
        if (chase == null) chase = FindFirstObjectByType<ChaseCamera>();
        if (audio == null) audio = FindFirstObjectByType<GameAudio>();
    }

    void Update()
    {
        double price;
        if (market != null && market.Fresh) price = market.Price;
        else
        {
            // random walk at roughly real volatility, replaced the moment the
            // socket delivers a moving price
            _simVel = _simVel * 0.94f + Random.Range(-1f, 1f) * 12f;
            _simPrice = Mathf.Max(1000f, (float)_simPrice + _simVel * Time.deltaTime * 6f);
            price = _simPrice;
        }
        History.Feed(price, Time.deltaTime);

        // THE C# ARMY IS NOT STEPPED, and nothing here feeds it any more.
        // This block set Flow from the tape, Courier from the truck and Heat
        // from the load and then ran `Army.Update(dt)` every frame - a full
        // second simulation beside the core's, which since `UploadArmour` was
        // deleted fed it nothing and was fed nothing by it. The core owns the
        // army and `ArmyRenderer` draws the core.
        //
        // The rotor audio went with it: it picked the nearest of `Army`'s own
        // helicopters. The core has helicopters and no sound yet, which is the
        // same gap as the muzzle flashes and is item 7's.
    }

    /// <summary>
    /// GONE with the C# army it launched. This sent `Army.SendHelicopter` on
    /// its own clock; the core runs `launchSorties` on the same schedule from
    /// the same seed, and two launchers over one sky is the shape this whole
    /// step removes. `sortieSeconds` stays as a serialized field so an existing
    /// scene does not lose it, and is read by nothing.
    /// </summary>

    /// <summary>Frontline z at a world x.</summary>
    public float FrontlineZ(float x)
    {
        // The core when one answers: it smooths the tape and this does not, and
        // the two are 49.14 m apart at worst. Every drawn use of the front runs
        // through here - TerritoryMap:102, RunScore:268, DriveHud:1115 and
        // RoadNetwork:74 - so one line fixes all four.
        if (Arena.ArenaCore.Available) return Arena.ArenaCore.FrontlineZ(x);
        if (History == null || terrain == null) return 0f;
        return History.FrontlineZ(x, terrain.width, terrain.depth);
    }

    /// <summary>True where the bulls hold the ground.</summary>
    public bool IsBullHeld(float x, float z) => z < FrontlineZ(x);
}
