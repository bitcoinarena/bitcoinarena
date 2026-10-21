// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE PLAYER IS NEVER TOLD "SEAT" (2026-09-15 16:22 and 19:56): the machines that sign a
/// round are signer nodes, the player's own place is "joined", a round that asks no stake is a
/// "free round". Every string literal in the game's scripts is scanned - interpolated and verbatim
/// strings included, the code inside their braces left out - so no GUI label, HUD line or card can
/// carry the word back in. Code identifiers (SeatingOf, seat.Tyre) are not text anybody reads.
/// </summary>
public class PlayerCopyTests
{
    static readonly Regex Seat = new Regex(@"\bseat(s|ed|ing)?\b", RegexOptions.IgnoreCase);

    /// <summary>The text of every string literal in a C# source, comments and interpolation holes left out.</summary>
    public static List<string> StringLiterals(string src)
    {
        var outp = new List<string>();
        int i = 0, n = src.Length;
        while (i < n)
        {
            char c = src[i], d = i + 1 < n ? src[i + 1] : '\0';
            if (c == '/' && d == '/') { while (i < n && src[i] != '\n') i++; continue; }
            if (c == '/' && d == '*') { int e = src.IndexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
            if (c == '\'') { i++; while (i < n && src[i] != '\'') { if (src[i] == '\\') i++; i++; } i++; continue; }
            bool interp = false, verbatim = false;
            int j = i;
            while (j < n && (src[j] == '$' || src[j] == '@')) { if (src[j] == '$') interp = true; else verbatim = true; j++; }
            if (j < n && src[j] == '"' && (j > i || c == '"'))
            {
                i = j + 1;
                var s = new StringBuilder();
                while (i < n)
                {
                    char ch = src[i];
                    if (verbatim && ch == '"' && i + 1 < n && src[i + 1] == '"') { s.Append('"'); i += 2; continue; }
                    if (!verbatim && ch == '\\') { if (i + 1 < n) s.Append(src[i + 1]); i += 2; continue; }
                    if (ch == '"') { i++; break; }
                    if (interp && ch == '{' && i + 1 < n && src[i + 1] == '{') { s.Append('{'); i += 2; continue; }
                    if (interp && ch == '}' && i + 1 < n && src[i + 1] == '}') { s.Append('}'); i += 2; continue; }
                    if (interp && ch == '{') { int depth = 1; i++; while (i < n && depth > 0) { if (src[i] == '{') depth++; else if (src[i] == '}') depth--; i++; } s.Append(' '); continue; }
                    if (!verbatim && ch == '\n') break;
                    s.Append(ch); i++;
                }
                outp.Add(s.ToString());
                continue;
            }
            i++;
        }
        return outp;
    }

    [Test]
    public void TheScannerReadsStringTextAndSkipsCommentsAndInterpolationCode()
    {
        var got = StringLiterals("// a seat comment\nvar a = \"free seat\"; /* seats */ var b = $\"x {r.seated} y\"; var c = @\"say \"\"seated\"\"\"; var t = 'x';");
        CollectionAssert.AreEqual(new[] { "free seat", "x   y", "say \"seated\"" }, got);
    }

    [Test]
    public void NoStringInTheGamesScriptsSaysSeat()
    {
        var hits = new List<string>();
        foreach (var f in Directory.GetFiles(Path.Combine(Application.dataPath, "Scripts"), "*.cs", SearchOption.AllDirectories))
            foreach (var s in StringLiterals(File.ReadAllText(f)))
                if (Seat.IsMatch(s)) hits.Add($"{Path.GetFileName(f)}: \"{(s.Length > 90 ? s.Substring(0, 90) : s)}\"");
        CollectionAssert.IsEmpty(hits, "player-facing copy still says seat:\n" + string.Join("\n", hits));
    }
}
