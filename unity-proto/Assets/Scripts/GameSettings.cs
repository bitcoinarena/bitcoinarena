// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

/// <summary>
/// The two switches a player wants within reach, and nothing else.
///
/// Sound, because a browser game that starts making noise is a browser game
/// people close. Debug, because everything that has gone wrong in this build
/// so far - a truck riding half a metre high, wheels sunk into the road, a
/// steering model off by a factor of four - was invisible until somebody put a
/// number on it, and the person best placed to catch the next one is whoever
/// is driving.
///
/// Remembered across sessions: a setting that resets every launch is not a
/// setting, it is a chore.
/// </summary>
public static class GameSettings
{
    const string SoundKey = "arena.sound";
    const string DebugKey = "arena.debug";
    // the names before kanban #524: a player's setting kept under them is read once and carried over
    const string OldSoundKey = "blwp.sound";
    const string OldDebugKey = "blwp.debug";

    static bool _loaded, _sound = true, _debug;

    static void Load()
    {
        if (_loaded) return;
        _loaded = true;
        _sound = PlayerPrefs.GetInt(SoundKey, PlayerPrefs.GetInt(OldSoundKey, 1)) != 0;
        _debug = PlayerPrefs.GetInt(DebugKey, PlayerPrefs.GetInt(OldDebugKey, 0)) != 0;
        Apply();
    }

    public static bool Sound
    {
        get { Load(); return _sound; }
        set { Load(); _sound = value; PlayerPrefs.SetInt(SoundKey, value ? 1 : 0); Apply(); }
    }

    public static bool Debug
    {
        get { Load(); return _debug; }
        set { Load(); _debug = value; PlayerPrefs.SetInt(DebugKey, value ? 1 : 0); }
    }

    public static void ToggleSound() => Sound = !Sound;
    public static void ToggleDebug() => Debug = !Debug;

    /// <summary>
    /// One listener volume rather than a mute on every source.
    ///
    /// The audio is spread over an engine loop, tyre noise, gunfire, rotors
    /// and one-shots; muting them individually means a new source added later
    /// is one somebody forgot to silence.
    /// </summary>
    static void Apply() => AudioListener.volume = _sound ? 1f : 0f;
}
