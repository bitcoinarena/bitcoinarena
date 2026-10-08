// WebSocket bridge for Unity WebGL.
//
// System.Net.WebSockets does not exist in the browser build - there are no
// sockets, only what the page can reach. This exposes the browser's own
// WebSocket to C# through a poll queue rather than callbacks, so the managed
// side stays free of function pointers and marshalling of delegates.
//
// C# calls WsPoll each frame and drains whatever arrived.

mergeInto(LibraryManager.library, {

  $WsState: {
    sockets: {},
    next: 1,
  },

  WsOpen__deps: ['$WsState'],
  WsOpen: function (urlPtr) {
    var url = UTF8ToString(urlPtr);
    var id = WsState.next++;
    var entry = { ws: null, queue: [], status: 0 };   // 0 connecting, 1 open, 2 closed, 3 error
    WsState.sockets[id] = entry;
    try {
      var ws = new WebSocket(url);
      entry.ws = ws;
      ws.onopen = function () { entry.status = 1; };
      ws.onmessage = function (e) {
        if (typeof e.data === 'string') {
          // a stalled consumer must not grow the heap without bound
          if (entry.queue.length < 512) entry.queue.push(e.data);
        }
      };
      ws.onerror = function () { entry.status = 3; };
      ws.onclose = function () { if (entry.status !== 3) entry.status = 2; };
    } catch (err) {
      entry.status = 3;
    }
    return id;
  },

  WsStatus__deps: ['$WsState'],
  WsStatus: function (id) {
    var e = WsState.sockets[id];
    return e ? e.status : 3;
  },

  WsPending__deps: ['$WsState'],
  WsPending: function (id) {
    var e = WsState.sockets[id];
    return e ? e.queue.length : 0;
  },

  // Returns a malloc'd UTF-8 string the caller must free with WsFree, or 0.
  WsTake__deps: ['$WsState', 'malloc'],
  WsTake: function (id) {
    var e = WsState.sockets[id];
    if (!e || e.queue.length === 0) return 0;
    var msg = e.queue.shift();
    var len = lengthBytesUTF8(msg) + 1;
    var buf = _malloc(len);
    stringToUTF8(msg, buf, len);
    return buf;
  },

  WsFree__deps: ['free'],
  WsFree: function (ptr) {
    if (ptr) _free(ptr);
  },

  WsSend__deps: ['$WsState'],
  WsSend: function (id, textPtr) {
    var e = WsState.sockets[id];
    if (!e || !e.ws || e.status !== 1) return 0;
    try { e.ws.send(UTF8ToString(textPtr)); return 1; } catch (err) { return 0; }
  },

  WsClose__deps: ['$WsState'],
  WsClose: function (id) {
    var e = WsState.sockets[id];
    if (!e) return;
    try { if (e.ws) e.ws.close(); } catch (err) {}
    delete WsState.sockets[id];
  },
});
