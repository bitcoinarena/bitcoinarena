// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
#if UNITY_EDITOR
using System.Diagnostics;
using System.IO;
using UnityEditor;
using UnityEngine;

/// <summary>
/// Rebuilds the deterministic core's bundle and the C# layout C# indexes the state buffer by.
///
/// The two have to move together or the build is quietly wrong: the bundle the page runs and the layout generated from the same
/// state.js. This project is Next Block's own (kanban #569: it lives in the app, the core is its parent folder); the Arena's page,
/// the client bundles and the template the project once carried are the Arena's, built by the Arena (tools/build-arena-page.mjs).
///
/// Menu: Tools > BTC Logistics > Sync Deterministic Core
/// </summary>
public static class SyncCore
{
    // the app's root: this Unity project is its unity/ folder
    const string CoreDir = "..";

    [MenuItem("Tools/BTC Logistics/Sync Deterministic Core")]
    public static void Run()
    {
        string root = Path.GetFullPath(Path.Combine(Application.dataPath, "..", CoreDir));
        if (!File.Exists(Path.Combine(root, "tools/bundle.js")))
        {
            UnityEngine.Debug.LogError("[SyncCore] no core at " + root);
            return;
        }

        if (!Node(root, "tools/bundle.js", out string bundleOut)) return;
        UnityEngine.Debug.Log("[SyncCore] " + bundleOut.Trim());

        if (!Node(root, "tools/gen-unity-layout.js", out string layout)) return;
        string layoutPath = Path.Combine(Application.dataPath, "Scripts/Arena/ArenaLayout.cs");
        File.WriteAllText(layoutPath, layout);
        UnityEngine.Debug.Log("[SyncCore] wrote " + layoutPath);

        AssetDatabase.Refresh();
    }

    static bool Node(string cwd, string script, out string stdout)
    {
        var p = new Process
        {
            StartInfo = new ProcessStartInfo("/usr/bin/env", "node " + script)
            {
                WorkingDirectory = cwd,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            }
        };
        p.Start();
        stdout = p.StandardOutput.ReadToEnd();
        string err = p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0)
        {
            UnityEngine.Debug.LogError("[SyncCore] " + script + " failed:\n" + err);
            return false;
        }
        return true;
    }
}
#endif
