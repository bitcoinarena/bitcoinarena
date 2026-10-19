// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// WHICH BUILD IS THIS.
///
/// Asked for on 2026-09-06 after a session where a measured fix "changed
/// nothing on the phone" twice, and both times the answer was that the page
/// was serving an older build than the one being reasoned about. A number on
/// the loading screen turns that from an argument into a glance.
///
/// The value is written by `BuildWebGL.Run` into `Resources/build.txt` at
/// build time: `0.0.<commits on this branch>`, the shape the owner asked for on
/// 2026-09-07. It goes up by one per commit, which a hash does not, and
/// `git rev-list --count` maps it back. The same number is put on the player
/// version, so the LOADING screen and the SPLASH cannot drift apart.
///
/// In the editor there may be no such file, and then it reads "dev", which is
/// the honest answer there.
/// </summary>
public static class BuildStamp
{
    static string _value;

    /// <summary>`0.0.xxx`, or "dev" in an editor with no stamp.</summary>
    public static string Current
    {
        get
        {
            if (_value != null) return _value;
            var asset = Resources.Load<TextAsset>("build");
            _value = asset != null && !string.IsNullOrWhiteSpace(asset.text)
                   ? asset.text.Trim()
                   : "dev";
            return _value;
        }
    }
}
