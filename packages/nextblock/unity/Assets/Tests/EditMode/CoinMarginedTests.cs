// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE OTHER BOOK, AND WHY IT PAID NOTHING.
///
/// BTCUSD_PERP is settled in coin. Its forced orders never cross fstream, so
/// in every build so far a coin-margined liquidation was worth exactly zero to
/// the player - not a small number, not a wrong number, absent. The stream
/// Binance documents for that book is `!forceOrder@arr` on
/// wss://dstream.binance.com, and it carries BOTH books: measured over 300 s,
/// 588 messages and 214 symbols, of which THREE were coin-M contracts
/// (ETHUSD_PERP, BTCUSD_PERP, XRPUSD_PERP) and the rest USDT-M names fstream
/// already delivers.
///
/// So the socket cannot simply be opened. Two rules stand between it and the
/// map, and both are pinned here:
///
///   the filter  - take coin-M names ONLY, or every USDT-M liquidation is
///                 counted twice, once off each socket;
///   the value   - the quantity is CONTRACTS, not coin. A BTCUSD_PERP
///                 contract is 100 USD. Read as `q * price` the way the
///                 USDT-M handler reads its own, one contract would be called
///                 $79,000 of liquidation instead of $100.
/// </summary>
public class CoinMarginedFilterTests
{
    /// <summary>
    /// The names are Binance's. `IsCoinMargined` was checked against their two
    /// exchangeInfo lists on 2026-09-07: of dapi's 30 coin-M symbols it takes
    /// 30, and of fapi's 897 USDT-M symbols it takes 0 - including all four of
    /// fapi's underscore names, which are the trap this rule exists for.
    /// </summary>
    [Test]
    public void CoinMarginedNamesAreTaken()
    {
        Assert.IsTrue(MarketFeed.IsCoinMargined("BTCUSD_PERP"));
        Assert.IsTrue(MarketFeed.IsCoinMargined("BTCUSD_260925"));
        Assert.IsTrue(MarketFeed.IsCoinMargined("ETHUSD_PERP"));
        Assert.IsTrue(MarketFeed.IsCoinMargined("XRPUSD_PERP"));
    }

    [Test]
    public void UsdtMarginedNamesAreNot()
    {
        // the plain ones, which are most of that socket's traffic
        Assert.IsFalse(MarketFeed.IsCoinMargined("BTCUSDT"));
        Assert.IsFalse(MarketFeed.IsCoinMargined("BTCUSDC"));
        Assert.IsFalse(MarketFeed.IsCoinMargined("WLDUSDT"));

        // AND THE DATED ONES. All four of fapi's underscore names. "Has an
        // underscore" would have taken every one of these and doubled it on
        // the map; BTCUSDT_261225 arrived on this very socket during the
        // capture that found the rule was needed.
        Assert.IsFalse(MarketFeed.IsCoinMargined("BTCUSDT_260925"));
        Assert.IsFalse(MarketFeed.IsCoinMargined("BTCUSDT_261225"));
        Assert.IsFalse(MarketFeed.IsCoinMargined("ETHUSDT_260925"));
        Assert.IsFalse(MarketFeed.IsCoinMargined("ETHUSDT_261225"));
    }

    [Test]
    public void NothingAndNonsenseAreNot()
    {
        Assert.IsFalse(MarketFeed.IsCoinMargined(null));
        Assert.IsFalse(MarketFeed.IsCoinMargined(""));
        Assert.IsFalse(MarketFeed.IsCoinMargined("_PERP"));
        Assert.IsFalse(MarketFeed.IsCoinMargined("USD_PERP"),
            "a name with nothing in front of USD is not a contract");
    }

    /// <summary>
    /// Contract sizes off dapi's exchangeInfo, read on 2026-09-07: the three
    /// BTC coin-M symbols are 100 USD a contract and the other twenty-seven
    /// are 10 USD.
    /// </summary>
    [Test]
    public void AContractIsWorthItsContractSize()
    {
        Assert.AreEqual(100.0, MarketFeed.CoinMarginedUsd("BTCUSD_PERP", 1), 0.001);
        Assert.AreEqual(4200.0, MarketFeed.CoinMarginedUsd("BTCUSD_261225", 42), 0.001);
        Assert.AreEqual(10.0, MarketFeed.CoinMarginedUsd("ETHUSD_PERP", 1), 0.001);
        Assert.AreEqual(70.0, MarketFeed.CoinMarginedUsd("XRPUSD_PERP", 7), 0.001);
    }

    /// <summary>
    /// The reading that would look right and is not. `q * price` is how the
    /// USDT-M handler values its own orders, correctly, because there `q` is
    /// coin. Here it is contracts, and one contract would be sized at the
    /// whole coin price.
    /// </summary>
    [Test]
    public void ItIsNotTheUsdtMarginedReading()
    {
        const double price = 79413.10;
        Assert.AreEqual(100.0, MarketFeed.CoinMarginedUsd("BTCUSD_PERP", 1), 0.001);
        Assert.AreNotEqual(1 * price, MarketFeed.CoinMarginedUsd("BTCUSD_PERP", 1),
            "one contract is 100 dollars of liquidation, not one bitcoin of it");

        // On the order actually captured: 197 contracts at 79288.0. The right
        // reading is $19,700; the USDT-M reading would call it $15.6 million.
        Assert.AreEqual(19700.0, MarketFeed.CoinMarginedUsd("BTCUSD_PERP", 197), 0.001);
        Assert.Greater(197 * 79288.0, 15e6);
    }
}

/// <summary>
/// BOTH SIDES OF THE FILTER, through the handler the socket actually calls,
/// on payloads captured off that socket rather than written here.
/// </summary>
public class CoinMarginedFeedTests
{
    // Captured from wss://dstream.binance.com/market/stream?streams=!forceOrder@arr
    // on 2026-09-07. A USDT-M name, on the coin-margined socket - which is the
    // case the filter exists for, because fstream is already carrying it.
    const string UsdtMarginedOnTheSameSocket =
        "{\"stream\":\"!forceOrder@arr\",\"data\":{\"e\":\"forceOrder\",\"E\":1788767011533,"
        + "\"o\":{\"s\":\"WLDUSDT\",\"S\":\"BUY\",\"o\":\"LIMIT\",\"f\":\"IOC\",\"q\":\"1791\","
        + "\"p\":\"0.4548000\",\"ap\":\"0.4505000\",\"X\":\"FILLED\",\"l\":\"997\",\"z\":\"1791\","
        + "\"ps\":\"WLDUSDT\",\"st\":1}}}";

    // A BTC one on the same socket, also USDT-M, and the closest thing to a
    // trap: it starts with BTC and would pass the coin filter of the other
    // handler untouched.
    const string BtcUsdtOnTheSameSocket =
        "{\"stream\":\"!forceOrder@arr\",\"data\":{\"e\":\"forceOrder\",\"E\":1788765899434,"
        + "\"o\":{\"s\":\"BTCUSDT\",\"S\":\"SELL\",\"o\":\"LIMIT\",\"f\":\"IOC\",\"q\":\"0.014\","
        + "\"p\":\"79104.30\",\"ap\":\"79413.10\",\"X\":\"FILLED\",\"l\":\"0.014\",\"z\":\"0.014\","
        + "\"ps\":\"BTCUSDT\",\"st\":1}}}";

    // THE ONE THE LETTER IS ABOUT, and it is a real one: caught off that socket
    // on 2026-09-07 at E=1788767113682, 197 contracts of BTCUSD_PERP forced at
    // 79288.0. Nothing here is invented - `ps` is the pair, "BTCUSD", which is
    // the field the docs say distinguishes this book from the other.
    const string CoinMarginedBtc =
        "{\"stream\":\"!forceOrder@arr\",\"data\":{\"e\":\"forceOrder\",\"E\":1788767113682,"
        + "\"o\":{\"s\":\"BTCUSD_PERP\",\"S\":\"BUY\",\"o\":\"LIMIT\",\"f\":\"IOC\",\"q\":\"197\","
        + "\"p\":\"79580.5\",\"ap\":\"79288.0\",\"X\":\"FILLED\",\"l\":\"11\",\"z\":\"197\","
        + "\"ps\":\"BTCUSD\",\"st\":2}}}";

    MarketFeed _feed;
    MarketFeed.Source _cm;
    MarketFeed.Liquidation? _got;
    int _raised;

    [SetUp]
    public void Rig()
    {
        _feed = new GameObject("feed").AddComponent<MarketFeed>();
        _cm = new MarketFeed.Source("binance-cm", "wss://dstream.binance.com/…", null, null, 0f);
        _got = null; _raised = 0;
        _feed.OnLiquidation += l => { _got = l; _raised++; };
    }

    [TearDown]
    public void Clear() { if (_feed != null) Object.DestroyImmediate(_feed.gameObject); }

    [Test]
    public void ACoinMarginedLiquidationPaysRealDollars()
    {
        _feed.HandleCoinMargined(_cm, CoinMarginedBtc);

        Assert.AreEqual(1, _raised, "the coin-margined order never reached OnLiquidation");
        Assert.IsTrue(_got.HasValue);
        // 197 contracts at 100 USD each. Before this letter it was 0 - not a
        // wrong number, absent, because nothing subscribed to the socket it
        // came from.
        Assert.AreEqual(19700.0, _got.Value.UsdValue, 0.001);
        Assert.AreEqual(79288.0, _got.Value.Price, 0.001);
        Assert.IsFalse(_got.Value.Long,
            "this one is a forced BUY, which closes a SHORT out");
        Assert.AreEqual("binance-cm", _got.Value.Venue);
    }

    [Test]
    public void AUsdtMarginedOrderOnTheSameSocketIsDropped()
    {
        _feed.HandleCoinMargined(_cm, UsdtMarginedOnTheSameSocket);
        _feed.HandleCoinMargined(_cm, BtcUsdtOnTheSameSocket);

        Assert.AreEqual(0, _raised,
            "a USDT-M order was taken off the coin-margined socket, so every one "
            + "of them is now on the map twice - once from fstream and once from here");
    }

    /// <summary>
    /// And the socket still counts what it sees. `Forced` is the liveness
    /// proof and is deliberately counted for EVERY symbol: BTC coin-M can be
    /// quiet for an hour while the rest of the book is cleared out, and a
    /// counter that only moved on accepted orders could not tell that from a
    /// dead subscription.
    /// </summary>
    [Test]
    public void EveryForcedOrderStillProvesTheSocketIsAlive()
    {
        _feed.HandleCoinMargined(_cm, UsdtMarginedOnTheSameSocket);
        _feed.HandleCoinMargined(_cm, BtcUsdtOnTheSameSocket);
        _feed.HandleCoinMargined(_cm, CoinMarginedBtc);

        Assert.AreEqual(3, _cm.Forced, "the liveness count must move on every forced order");
        Assert.AreEqual(1, _cm.Accepted, "and only one of the three is ours to pay");
    }
}

/// <summary>
/// AND WHAT THE CORE IS TOLD, which is the only part that changes the game.
///
/// `Bootstrap` hands every accepted liquidation to `ArenaCore.Liquidation(usd)`
/// and nothing else decides a strike: the C# side gets the SIDE and the venue
/// for the renderer, while the size, the crater, its depth and its lifetime
/// are the core's. So the question this letter has to answer about the two
/// engines is not "do they agree" - there is no second engine sizing a strike
/// any more - it is whether the new book reaches the core in the SAME units as
/// the old one. `ArenaCore.Scale` is the whole conversion and is readable
/// outside a WebGL player, so it can be measured here rather than argued.
/// </summary>
public class CoinMarginedCoreUnitsTests
{
    // the order captured off dstream: 197 contracts of BTCUSD_PERP
    const double CapturedUsd = 19700.0;

    [Test]
    public void OneBookAndOneRule()
    {
        // A coin-margined liquidation of a given dollar value and a USDT-M one
        // of the same value are the same input. They go through one `Raise`,
        // one `OnLiquidation` and one `Scale`, and this says so in numbers.
        Assert.AreEqual(Arena.ArenaCore.Scale(CapturedUsd),
                        Arena.ArenaCore.Scale(19700.0),
                        "the core must see one liquidation rule, not one per book");
    }

    [Test]
    public void TheCapturedOrderIsRealSizeToTheCore()
    {
        // millions of USD in Q16.16: 0.0197 * 65536 = 1291.06, rounded.
        Assert.AreEqual(1291, Arena.ArenaCore.Scale(CapturedUsd));
        Assert.AreEqual(0, Arena.ArenaCore.Scale(0),
            "and before this letter that is what the core was told: nothing");
    }

    /// <summary>
    /// The wrong reading is not a rounding error at the core either. Valued
    /// the USDT-M way the same order would have been 1,023,655 steps against
    /// 1,291 - a strike 793 times the size, and the crater follows the cube
    /// root of it, so about nine times the radius.
    /// </summary>
    [Test]
    public void TheUsdtMarginedReadingWouldHaveBeenAnotherStrikeEntirely()
    {
        int right = Arena.ArenaCore.Scale(CapturedUsd);
        int wrong = Arena.ArenaCore.Scale(197 * 79288.0);
        Assert.AreEqual(1291, right);
        Assert.AreEqual(1023655, wrong);
        Assert.Greater(wrong / (double)right, 700.0);
    }

    /// <summary>
    /// And the smallest coin-margined order there can be still reaches the
    /// core. One BTC contract is 100 USD, and the core's step is $15.26, so it
    /// arrives as 7 steps rather than being floored away - which is the thing
    /// worth checking about a book whose quantities are small integers.
    /// </summary>
    [Test]
    public void EvenASingleContractIsNotRoundedAway()
    {
        double oneContract = MarketFeed.CoinMarginedUsd("BTCUSD_PERP", 1);
        Assert.AreEqual(100.0, oneContract, 0.001);
        Assert.AreEqual(7, Arena.ArenaCore.Scale(oneContract));
    }
}
