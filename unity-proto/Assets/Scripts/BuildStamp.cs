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
/// build time, from the commit the build was made at. In the editor there is
/// no such file and it reads "dev", which is the honest answer there.
/// </summary>
public static class BuildStamp
{
    static string _value;

    /// <summary>The short commit and the build date, or "dev" in the editor.</summary>
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
