using UnityEngine;

/// <summary>
/// Ties the live tape to the ground. The frontline is the price chart, and
/// which side of it you stand on decides whether the ground is bull or bear
/// territory.
/// </summary>
public class Battlefield : MonoBehaviour
{
    public MempoolTerrain terrain;
    public MarketFeed market;

    public PriceHistory History { get; private set; }

    /// <summary>Simulated price when the live feed has nothing, so the map is never dead.</summary>
    double _simPrice = 63000;
    float _simVel;

    void Awake() => History = new PriceHistory(96);

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
    }

    /// <summary>Frontline z at a world x.</summary>
    public float FrontlineZ(float x)
    {
        if (History == null || terrain == null) return 0f;
        return History.FrontlineZ(x, terrain.width, terrain.depth);
    }

    /// <summary>True where the bulls hold the ground.</summary>
    public bool IsBullHeld(float x, float z) => z < FrontlineZ(x);
}
