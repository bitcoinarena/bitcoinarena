// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Text.RegularExpressions;
using NUnit.Framework;

/// <summary>
/// THE BUILD NUMBER IS A NUMBER, AND IT IS ON BOTH SCREENS.
///
/// Twice in one session a measured fix "changed nothing on the phone" and both
/// times the page was serving an older build than the one being argued about.
/// The stamp was `43e3375  ·  2026-09-07 05:28 UTC` - a hash nobody can put in
/// order, on the splash only, so the LOADING screen said nothing at all.
///
/// 2026-09-07 07:39: build number on the loading screen AND the splash,
/// format 0.0.xxx. So the shape is pinned here: 0.0 and a counter that goes up
/// by one per commit. Restoring the old stamp fails this.
///
/// The loading screen's copy is not read from C# - it is
/// `{{{ PRODUCT_VERSION }}}` in the WebGL template, filled from
/// `PlayerSettings.bundleVersion`, which `StampTheBuild` sets from the very
/// same string it writes to `build.txt`. One number, two screens, no drift.
/// </summary>
public class BuildNumberTests
{
    [Test]
    public void TheStampIsZeroZeroAndACounter()
    {
        string v = BuildStamp.Current;

        Assert.AreNotEqual("dev", v,
            "there is no build stamp in Resources at all, so neither screen can "
            + "show one - `BuildWebGL.StampTheBuild` writes it");
        Assert.IsTrue(Regex.IsMatch(v, @"^0\.0\.[0-9]+$"),
            $"the build stamp reads \"{v}\", and the format asked for is 0.0.xxx");
    }

    /// <summary>
    /// The old stamp's own shape, named so it cannot come back quietly: it
    /// carried a hash, two spaces and a middot, and a UTC date.
    /// </summary>
    [Test]
    public void TheOldHashStampIsGone()
    {
        string v = BuildStamp.Current;
        Assert.IsFalse(v.Contains("·"), $"\"{v}\" still carries the old middot stamp");
        Assert.IsFalse(v.Contains("UTC"), $"\"{v}\" still carries the old build date");
        Assert.IsFalse(v.Contains(" "), $"\"{v}\" has a space in it; a version number has none");
    }
}
