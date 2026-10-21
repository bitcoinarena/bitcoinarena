// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using UnityEngine;
#if !UNITY_WEBGL || UNITY_EDITOR
using System.Net.WebSockets;
using System.Threading;
#endif

/// <summary>
/// One WebSocket, two implementations.
///
/// In the browser there are no sockets, so the WebGL build goes through a
/// .jslib bridge to the page's own WebSocket. Everywhere else (editor,
/// standalone) it uses ClientWebSocket. Both present the same poll-a-queue
/// interface, so callers never branch.
/// </summary>
public class WebSocketClient : IDisposable
{
    public enum State { Connecting, Open, Closed, Error }

    readonly Queue<string> _inbox = new Queue<string>();
    readonly object _lock = new object();
    public string Url { get; private set; }

#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] static extern int WsOpen(string url);
    [DllImport("__Internal")] static extern int WsStatus(int id);
    [DllImport("__Internal")] static extern int WsPending(int id);
    [DllImport("__Internal")] static extern IntPtr WsTake(int id);
    [DllImport("__Internal")] static extern void WsFree(IntPtr ptr);
    [DllImport("__Internal")] static extern int WsSend(int id, string text);
    [DllImport("__Internal")] static extern void WsClose(int id);

    int _id;

    public WebSocketClient(string url) { Url = url; _id = WsOpen(url); }

    public State Status => _id == 0 ? State.Error : (State)WsStatus(_id);

    /// <summary>Drain everything that arrived since the last call.</summary>
    public IEnumerable<string> Drain()
    {
        if (_id == 0) yield break;
        int n = WsPending(_id);
        for (int i = 0; i < n; i++)
        {
            var ptr = WsTake(_id);
            if (ptr == IntPtr.Zero) yield break;
            var s = Marshal.PtrToStringUTF8(ptr);
            WsFree(ptr);
            if (s != null) yield return s;
        }
    }

    public void Send(string text) { if (_id != 0) WsSend(_id, text); }
    public void Dispose() { if (_id != 0) { WsClose(_id); _id = 0; } }
#else
    ClientWebSocket _ws;
    CancellationTokenSource _cts;
    volatile State _state = State.Connecting;

    public WebSocketClient(string url)
    {
        Url = url;
        _cts = new CancellationTokenSource();
        _ws = new ClientWebSocket();
        _ = Pump(url, _cts.Token);
    }

    async System.Threading.Tasks.Task Pump(string url, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        try
        {
            await _ws.ConnectAsync(new Uri(url), ct);
            _state = State.Open;
            var sb = new System.Text.StringBuilder();
            while (!ct.IsCancellationRequested && _ws.State == WebSocketState.Open)
            {
                var seg = new ArraySegment<byte>(buffer);
                WebSocketReceiveResult r;
                sb.Clear();
                do
                {
                    r = await _ws.ReceiveAsync(seg, ct);
                    if (r.MessageType == WebSocketMessageType.Close) { _state = State.Closed; return; }
                    sb.Append(System.Text.Encoding.UTF8.GetString(buffer, 0, r.Count));
                } while (!r.EndOfMessage);

                lock (_lock) { if (_inbox.Count < 512) _inbox.Enqueue(sb.ToString()); }
            }
            _state = State.Closed;
        }
        catch (OperationCanceledException) { _state = State.Closed; }
        catch (Exception e) { Debug.LogWarning($"[WebSocketClient] {url}: {e.Message}"); _state = State.Error; }
    }

    public State Status => _state;

    /// <summary>
    /// Put a frame in the queue as if the socket had received it.
    ///
    /// For tests, and it exists because the thing worth testing is the DRAIN:
    /// two forced orders that arrive between two frames are handled in one
    /// pass of `MarketFeed.Update`, and that is where two liquidations meet
    /// inside one frame. Waiting for the real book to do it took twenty
    /// passive minutes and produced none. Editor and standalone only - the
    /// browser build has no `_inbox`, it takes its frames from the page.
    /// </summary>
    public void Deliver(string text)
    {
        lock (_lock) _inbox.Enqueue(text);
    }

    public IEnumerable<string> Drain()
    {
        while (true)
        {
            string s;
            lock (_lock) { if (_inbox.Count == 0) yield break; s = _inbox.Dequeue(); }
            yield return s;
        }
    }

    public void Send(string text)
    {
        if (_ws?.State != WebSocketState.Open) return;
        var bytes = System.Text.Encoding.UTF8.GetBytes(text);
        _ = _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token);
    }

    public void Dispose()
    {
        try { _cts?.Cancel(); _ws?.Dispose(); } catch { }
        _ws = null;
    }
#endif
}
