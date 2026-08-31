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

  $AudioUnlockState: { armed: false },

  UnlockAudio__deps: ['$AudioUnlockState'],
  UnlockAudio: function () {
    try {
      var kick = function () {
        var ctx = (typeof WEBAudio !== 'undefined' && WEBAudio.audioContext)
                  ? WEBAudio.audioContext : null;
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
