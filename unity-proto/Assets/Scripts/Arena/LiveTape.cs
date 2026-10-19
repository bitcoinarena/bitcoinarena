// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Arena
{
    /// <summary>
    /// THE LIVE TAPE, FRESH (2026-09-17 16:44: "reload always shows the SAME world candles - not live"; 16:46: "the
    /// prices must be 100% current, not pre-seeded and cached"). Binance's 1 s BTCUSDT klines for the last 320 s, asked at
    /// the moment a core starts and never kept: the price standing at each of the 64 five-second marks ending at the newest
    /// kline, oldest first, in the tape's unit. Pure, for the tests; the fetch is CoreDrivenTruck's.
    /// </summary>
    public static class LiveTape
    {
        public const string Url = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=320";
        public const int Prices = 64, StepMs = 5000;
        static readonly Regex Kline = new Regex("\\[(\\d+),\"([0-9.]+)\",\"([0-9.]+)\",\"([0-9.]+)\",\"([0-9.]+)\"", RegexOptions.Compiled);

        /// <summary>The 64 tape words from a klines answer, or null when it does not cover the 5 minutes (the seed stays).</summary>
        public static int[] FromKlines(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            var open = new List<long>(); var close = new List<double>();
            foreach (Match m in Kline.Matches(json))
            {
                open.Add(long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture));
                close.Add(double.Parse(m.Groups[5].Value, CultureInfo.InvariantCulture));
            }
            if (open.Count == 0) return null;
            long newest = open[open.Count - 1];
            if (newest - open[0] < (Prices - 1) * StepMs) return null;
            var words = new int[Prices];
            int j = 0;
            for (int k = 0; k < Prices; k++)
            {
                long at = newest - (Prices - 1 - k) * (long)StepMs;
                while (j + 1 < open.Count && open[j + 1] <= at) j++;       // the last kline at or before the mark
                words[k] = ArenaCore.PriceWord(close[j]);
                if (words[k] <= 0) return null;
            }
            return words;
        }
    }
}
