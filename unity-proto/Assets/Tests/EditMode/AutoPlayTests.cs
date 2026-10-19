// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Linq;
using NUnit.Framework;

/// <summary>
/// AUTOPLAY'S ON/OFF FLAG (no test named AutoPlay.cs). `AutoPlay.Asked` is on only when the player was
/// started with `-autoplay` on its command line - no key, menu or setting turns it on. Run once without the flag (off) and
/// once with it (on): the same test holds both ways, reading the command line the process was really given.
/// </summary>
public class AutoPlayTests
{
    [Test]
    public void AskedIsOnExactlyWhenTheCommandLineSaysAutoplay()
    {
        bool given = System.Environment.GetCommandLineArgs().Contains("-autoplay");
        Assert.AreEqual(given, AutoPlay.Asked, given ? "started with -autoplay, yet not asked" : "asked without -autoplay on the command line");
    }

    [Test]
    public void ASimilarArgumentIsNotTheFlag()
    {
        // only the exact word counts: -autoplay=1 or --autoplay are other arguments
        var args = System.Environment.GetCommandLineArgs();
        if (args.Contains("-autoplay")) Assert.Pass("this run was given -autoplay itself");
        Assert.IsFalse(args.Any((a) => a == "-autoplay"));
        Assert.IsFalse(AutoPlay.Asked);
    }
}
