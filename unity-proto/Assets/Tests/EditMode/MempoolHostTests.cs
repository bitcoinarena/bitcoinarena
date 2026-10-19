// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;

/// <summary>
/// The host list itself. The failover behaviour needs the network and belongs
/// in play mode; what is checkable here is that the list is sane, which is
/// where the last outage actually bit: one host, hard-coded three times.
/// </summary>
public class MempoolHostTests
{
    [Test]
    public void ThereIsMoreThanOneHost()
    {
        Assert.GreaterOrEqual(MempoolHosts.All.Length, 3,
            "a single mirror is a single point of failure, which is the bug this list exists to fix");
    }

    [Test]
    public void EveryHostIsAnApiRootOverTls()
    {
        foreach (var h in MempoolHosts.All)
        {
            // Plain http would be blocked as mixed content by the browser the
            // moment the game is served over https, which it always is.
            StringAssert.StartsWith("https://", h, $"{h} is not TLS");
            Assert.IsFalse(h.EndsWith("/"), $"{h} has a trailing slash - paths are concatenated raw");
            StringAssert.EndsWith("/api", h, $"{h} is not an Esplora API root");
        }
    }

    [Test]
    public void TheHostsAreDistinct()
    {
        for (int i = 0; i < MempoolHosts.All.Length; i++)
            for (int j = i + 1; j < MempoolHosts.All.Length; j++)
                Assert.AreNotEqual(MempoolHosts.All[i], MempoolHosts.All[j],
                    "a duplicated host adds a timeout, not a fallback");
    }

    /// <summary>
    /// mempool.bisq.services is listed almost everywhere as an official
    /// instance and no longer resolves. Named here so it does not get helpfully
    /// added back.
    /// </summary>
    [Test]
    public void TheDeadBisqMirrorIsNotBack()
    {
        foreach (var h in MempoolHosts.All)
            StringAssert.DoesNotContain("bisq.services", h,
                "mempool.bisq.services is dead - it costs a full timeout and returns nothing");
    }
}
