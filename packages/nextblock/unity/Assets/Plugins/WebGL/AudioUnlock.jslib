// Getting sound out of a phone browser.
//
// Every mobile browser starts its AudioContext suspended and will only resume
// it from inside a real user-gesture handler. Unity's loader tries once on the
// first click, which is enough on a desktop and is NOT enough on iOS: the
// context there also has to be given something to play inside that same
// gesture, or it stays silent while reporting itself as running. So this is
// called when PLAY is pressed - which IS a gesture - and it also arms the
// document's own touch handlers, because the first press a phone sees may be
// the tap that dismissed the title screen and nothing after it.
mergeInto(LibraryManager.library, {

  $AudioUnlockState: { armed: false, said: false },

  UnlockAudio__deps: ['$AudioUnlockState'],
  UnlockAudio: function () {
    try {
      var kick = function () {
        var ctx = (typeof WEBAudio !== 'undefined' && WEBAudio.audioContext)
                  ? WEBAudio.audioContext : null;
        // MEASURED, not assumed: say which handle actually held a context in
        // this build. `WEBAudio` is emscripten-scope and a Unity 6 player did
        // not expose it on `Module` at all, which is why the page captures the
        // context as it is constructed - see the template's [audio] block. If
        // that one is there, use it, so both paths kick the same object.
        if (!ctx && typeof window !== 'undefined' && window.__arenaAudio &&
            window.__arenaAudio.contexts.length) {
          ctx = window.__arenaAudio.contexts[0];
        }
        if (!AudioUnlockState.said) {
          AudioUnlockState.said = true;
          console.log('[audio] jslib WEBAudio=' + (typeof WEBAudio !== 'undefined') +
                      ' page=' + (typeof window !== 'undefined' && !!window.__arenaAudio) +
                      ' ctx=' + (ctx ? ctx.state : 'none'));
        }
        if (!ctx) return;
        if (ctx.state !== 'running' && ctx.resume) ctx.resume();
        // one silent sample, played from inside the gesture: this is the part
        // iOS actually requires, and skipping it is why a resumed context can
        // still produce nothing
        try {
          var b = ctx.createBuffer(1, 1, 22050);
          var s = ctx.createBufferSource();
          s.buffer = b;
          s.connect(ctx.destination);
          (s.start || s.noteOn).call(s, 0);
        } catch (e) { /* an older context: resume alone will have to do */ }
      };

      kick();
      if (!AudioUnlockState.armed) {
        AudioUnlockState.armed = true;
        ['touchstart', 'touchend', 'mousedown', 'keydown'].forEach(function (name) {
          document.addEventListener(name, kick, { passive: true });
        });
      }
    } catch (e) {
      console.warn('[AudioUnlock] ' + e);
    }
  },
});
