// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.IO;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE LIVE TAPE (2026-09-17 16:44 / 16:46): 64 current prices out of Binance's 1 s klines, one at each five-second
/// mark ending at the newest kline - measured on a real answer (Tests/Fixtures/binance-klines-1s.json, 320 klines).
/// </summary>
public class LiveTapeTests
{
    static string Fixture => File.ReadAllText(Path.Combine(Application.dataPath, "Tests", "Fixtures", "binance-klines-1s.json"));

    [Test]
    public void SixtyFourFiveSecondPricesEndingAtTheNewestKline()
    {
        var words = Arena.LiveTape.FromKlines(Fixture);
        Assert.IsNotNull(words, "a full 320 s answer gave no tape");
        Assert.AreEqual(64, words.Length);
        foreach (var w in words) Assert.Greater(w, 0);
        // the newest mark is the newest kline's close, in the tape's unit
        Assert.AreEqual(Arena.ArenaCore.PriceWord(76722.37), words[63]);
        float lo = float.MaxValue, hi = 0f;
        foreach (var w in words) { lo = Mathf.Min(lo, w / 256f); hi = Mathf.Max(hi, w / 256f); }
        Debug.Log($"[live-tape] 64 prices ${words[0] / 256f:0.00} .. ${words[63] / 256f:0.00}, range ${lo:0.00} - ${hi:0.00}");
        Assert.Less(hi - lo, 2000f, "five minutes of BTC do not span $2,000");
    }

    [Test]
    public void AnAnswerShortOfFiveMinutesOrEmptyLeavesTheSeed()
    {
        Assert.IsNull(Arena.LiveTape.FromKlines(""));
        Assert.IsNull(Arena.LiveTape.FromKlines("[]"));
        Assert.IsNull(Arena.LiveTape.FromKlines("[[1789656629000,\"76717.74\",\"76722.37\",\"76717.74\",\"76722.37\",\"0.1\"]]"));
    }
}
