// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

/// <summary>
/// A Linux player, for one reason: it presents the resolutions the editor will
/// not. `-screen-width` and `-screen-height` are player arguments, and the
/// editor's Game view ignores them - asked for 844x390 it reports 733x293,
/// which is on the record in TASKBOOK.
///
///   -batchmode -quit -buildTarget StandaloneLinux64
///   -executeMethod BuildLinux.Run -buildOutput &lt;dir&gt;
/// </summary>
public static class BuildLinux
{
    public static void Run()
    {
        string output = "/tmp/blwp-linux/blwp.x86_64";
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == "-buildOutput") output = args[i + 1];

        Directory.CreateDirectory(Path.GetDirectoryName(output));

        var scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
        if (scenes.Length == 0) scenes = new[] { "Assets/Scenes/Prototype.unity" };

        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = scenes,
            locationPathName = output,
            target = BuildTarget.StandaloneLinux64,
            options = BuildOptions.None,
        });

        var s = report.summary;
        Debug.Log($"[build] linux {s.result} {s.totalSize / 1048576} MB to {output}");
        if (s.result != BuildResult.Succeeded) EditorApplication.Exit(1);
    }
}
