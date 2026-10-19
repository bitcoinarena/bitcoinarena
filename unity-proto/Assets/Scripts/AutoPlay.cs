// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// DRIVES THE FIRST TEN SECONDS SO A BUILD CAN BE PHOTOGRAPHED.
///
/// The four shapes a13 needs pictures of - 844x390, 1024x768, 1920x1080,
/// 1000x360 - are only presented by a real player; the editor's Game view
/// ignores `-screen-width` and reports 733x293 whatever is asked for, which is
/// on the record. A player presents them and then sits on the title screen
/// waiting for a click that no screenshot can give it.
///
/// So: only when `-autoplay` is on the command line. A player started the
/// normal way never constructs this, and there is no key, no menu and no
/// setting that turns it on. It dismisses the title screen, takes a load and
/// rolls out, which is the state the HUD is worth photographing in.
/// </summary>
public class AutoPlay : MonoBehaviour
{
    /// <summary>Was the build asked to drive itself?</summary>
    public static bool Asked
    {
        get
        {
            foreach (var a in System.Environment.GetCommandLineArgs())
                if (a == "-autoplay") return true;
            return false;
        }
    }

    float _t;
    bool _played, _loaded;

    void Update()
    {
        _t += Time.unscaledDeltaTime;

        if (!_played && _t > 2.5f)
        {
            var splash = Object.FindFirstObjectByType<SplashScreen>();
            if (splash != null && splash.Showing) splash.Play();
            _played = true;
        }

        // The yard needs a moment after the title screen goes before the
        // packages are on the ramp to take.
        if (_played && !_loaded && _t > 5f)
        {
            var panel = Object.FindFirstObjectByType<LoadoutPanel>();
            if (panel != null && panel.IsOpen)
            {
                panel.Auto();
                panel.Confirm();
                _loaded = true;
                Debug.Log("[autoplay] rolled out");
            }
            else if (_t > 12f) _loaded = true;      // nothing to load; carry on
        }
    }
}
