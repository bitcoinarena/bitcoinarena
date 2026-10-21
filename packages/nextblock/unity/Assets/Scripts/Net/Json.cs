// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Globalization;

/// <summary>
/// Minimal JSON field reader.
///
/// JsonUtility cannot do top-level arrays, dictionaries, or the polymorphic
/// `data` payload of a Binance combined stream, and pulling in a full parser
/// for six fields is not worth the build size. This reads a named field out of
/// a JSON string without building a tree.
///
/// It is deliberately shallow: good enough for known message shapes, not a
/// general parser.
/// </summary>
public static class Json
{
    /// <summary>Index just past the colon of "key": , or -1.</summary>
    static int Find(string json, string key, int from = 0)
    {
        string needle = "\"" + key + "\"";
        int at = json.IndexOf(needle, from, System.StringComparison.Ordinal);
        if (at < 0) return -1;
        int colon = json.IndexOf(':', at + needle.Length);
        if (colon < 0) return -1;
        int i = colon + 1;
        while (i < json.Length && char.IsWhiteSpace(json[i])) i++;
        return i;
    }

    /// <summary>String value of a field, unescaped only for the common cases.</summary>
    public static string GetString(string json, string key, string fallback = null)
    {
        int i = Find(json, key);
        if (i < 0 || i >= json.Length) return fallback;
        if (json[i] != '"')
        {
            // unquoted (number, bool, null): read to the delimiter
            int e = i;
            while (e < json.Length && json[e] != ',' && json[e] != '}' && json[e] != ']') e++;
            return json.Substring(i, e - i).Trim();
        }
        i++;
        var sb = new System.Text.StringBuilder();
        while (i < json.Length && json[i] != '"')
        {
            if (json[i] == '\\' && i + 1 < json.Length) { i++; sb.Append(json[i] == 'n' ? '\n' : json[i]); }
            else sb.Append(json[i]);
            i++;
        }
        return sb.ToString();
    }

    /// <summary>Numeric value of a field. Binance sends numbers as strings, so both work.</summary>
    public static double GetDouble(string json, string key, double fallback = 0)
    {
        var s = GetString(json, key);
        if (string.IsNullOrEmpty(s)) return fallback;
        return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : fallback;
    }

    /// <summary>Raw substring of a nested object or array field, braces included.</summary>
    public static string GetRaw(string json, string key)
    {
        int i = Find(json, key);
        if (i < 0 || i >= json.Length) return null;
        char open = json[i];
        char close = open == '{' ? '}' : open == '[' ? ']' : '\0';
        if (close == '\0') return null;

        int depth = 0;
        bool inStr = false;
        for (int e = i; e < json.Length; e++)
        {
            char c = json[e];
            if (inStr) { if (c == '\\') e++; else if (c == '"') inStr = false; continue; }
            if (c == '"') { inStr = true; continue; }
            if (c == open) depth++;
            else if (c == close && --depth == 0) return json.Substring(i, e - i + 1);
        }
        return null;
    }

    /// <summary>Split a JSON array's top-level elements. Input must include the brackets.</summary>
    public static System.Collections.Generic.List<string> Elements(string array)
    {
        var outp = new System.Collections.Generic.List<string>();
        if (string.IsNullOrEmpty(array) || array[0] != '[') return outp;
        int depth = 0, start = -1;
        bool inStr = false;
        for (int i = 0; i < array.Length; i++)
        {
            char c = array[i];
            if (inStr) { if (c == '\\') i++; else if (c == '"') inStr = false; continue; }
            if (c == '"') { if (depth == 1 && start < 0) start = i; inStr = true; continue; }
            if (c == '[' || c == '{')
            {
                depth++;
                if (depth == 2 && start < 0) start = i;
            }
            else if (c == ']' || c == '}')
            {
                depth--;
                if (depth == 1 && start >= 0) { outp.Add(array.Substring(start, i - start + 1)); start = -1; }
                if (depth == 0 && start >= 0) { outp.Add(array.Substring(start, i - start).Trim()); start = -1; }
            }
            else if (depth == 1)
            {
                if (c == ',') { if (start >= 0) { outp.Add(array.Substring(start, i - start).Trim()); start = -1; } }
                else if (start < 0 && !char.IsWhiteSpace(c)) start = i;
            }
        }
        return outp;
    }
}
