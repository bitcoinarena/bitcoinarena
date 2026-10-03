using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using UnityEngine;

/// <summary>
/// THE RESULT SUMMARY ON THE END CARD (the owner 2026-10-04): who delivered and who did not, the high score, this player's
/// win or loss, and a preliminary balance list - four lines under SCORE, above "copy game replay".
///
/// Display only. Every number is the seats' own, from the round's /api/round-result as the page read it (index.html
/// BLWP_RESULT, through BlwpCore.ResultSummary): the outcome and score the signers signed, how many signed it, and the
/// result and netMsat the seats' playerBalance worked out. Nothing here decides a win, a loss or a balance.
/// </summary>
public static class ResultSummary
{
    [System.Serializable] public class Row
    {
        public string entry = "", key = "", name = "", outcome = "", result = "", net = "";
        public long score = -1;
        public int signedBy;
    }

    [System.Serializable] public class Wire
    {
        public string mine = "";
        public Row[] players = new Row[0];
    }

    /// <summary>The words the outcomes are named by, in the order the names line lists them.</summary>
    public static readonly string[] Outcomes = { "DELIVERED", "MISSED", "WRECKED", "FORFEIT" };

    /// <summary>A run counts as signed once this many signer nodes signed its result.</summary>
    public const int SignedAt = 5;

    public static Wire Parse(string json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { var w = JsonUtility.FromJson<Wire>(json); if (w != null && w.players == null) w.players = new Row[0]; return w; }
        catch { return null; }
    }

    /// <summary>"you" for this run's entry; else the lobby name; else the first 8 characters of the player key.</summary>
    public static string Who(Row r, string mine)
    {
        if (!string.IsNullOrEmpty(mine) && r.entry == mine) return "you";
        if (!string.IsNullOrEmpty(r.name)) return r.name;
        return string.IsNullOrEmpty(r.key) ? "?" : r.key.Substring(0, Mathf.Min(8, r.key.Length));
    }

    /// <summary>A signed core score as the lobby's best line shows it: 8304450 is 83.04450.</summary>
    public static string Score(long s) =>
        (s / 100000).ToString(CultureInfo.InvariantCulture) + "." + (s % 100000).ToString("00000", CultureInfo.InvariantCulture);

    /// <summary>netMsat as signed sat ("+12 sat", "-100 sat", "-1.5 sat"); empty is "pending".</summary>
    public static string Sats(string netMsat)
    {
        if (string.IsNullOrEmpty(netMsat) || !long.TryParse(netMsat, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out long msat))
            return "pending";
        string sign = msat < 0 ? "-" : "+";
        long a = System.Math.Abs(msat);
        string sat = (a / 1000).ToString(CultureInfo.InvariantCulture);
        long frac = a % 1000;
        if (frac != 0) sat += "." + frac.ToString("000", CultureInfo.InvariantCulture).TrimEnd('0');
        return sign + sat + " sat";
    }

    public static string NamesLine(Wire w)
    {
        var parts = new List<string>();
        foreach (var o in Outcomes)
        {
            var who = w.players.Where(p => p.outcome == o).Select(p => Who(p, w.mine)).ToList();
            if (who.Count > 0) parts.Add(o + " " + string.Join(", ", who));
        }
        int driving = w.players.Count(p => string.IsNullOrEmpty(p.outcome));
        if (driving > 0) parts.Add(driving + " still driving");
        return parts.Count > 0 ? string.Join("  ·  ", parts) : "no result signed yet";
    }

    public static string HighScoreLine(Wire w)
    {
        var top = w.players.Where(p => p.score >= 0 && !string.IsNullOrEmpty(p.outcome))
                           .OrderByDescending(p => p.score).Take(3).ToList();
        if (top.Count == 0) return "HIGH SCORE  -";
        return "HIGH SCORE  " + string.Join("   ", top.Select((p, i) => $"{i + 1}. {Who(p, w.mine)} {Score(p.score)}"));
    }

    public static string YouLine(Wire w)
    {
        var me = w.players.FirstOrDefault(p => !string.IsNullOrEmpty(w.mine) && p.entry == w.mine);
        if (me == null) return "YOU  not in the result yet";
        string result = string.IsNullOrEmpty(me.result) ? "PENDING" : me.result.ToUpperInvariant();
        return string.IsNullOrEmpty(me.net) ? $"YOU  {result}" : $"YOU  {result}  {Sats(me.net)}";
    }

    public static string BalanceHeader(Wire w) =>
        $"preliminary · {w.players.Count(p => p.signedBy >= SignedAt)} of {w.players.Length} runs signed";

    /// <summary>One row per player, in the result's order; with <paramref name="most"/> set, that many and "and N more".</summary>
    public static List<string> BalanceRows(Wire w, int most = int.MaxValue)
    {
        var rows = w.players.Take(most).Select(p => $"{Who(p, w.mine)}  {Sats(p.net)}").ToList();
        if (w.players.Length > most) rows.Add($"and {w.players.Length - most} more");
        return rows;
    }

    /// <summary>Every line the card draws, top to bottom.</summary>
    public static List<string> Lines(Wire w, int mostRows = int.MaxValue)
    {
        if (w == null) return new List<string>();
        var lines = new List<string> { NamesLine(w), HighScoreLine(w), YouLine(w), BalanceHeader(w) };
        lines.AddRange(BalanceRows(w, mostRows));
        return lines;
    }
}
