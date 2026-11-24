// kanban #3664: the canary's hard stop closes the browser before the process exits. A killed Chrome loses the page's last localStorage
// writes (Chrome commits them a few seconds late) - the 16:57Z run stopped mid-collect, the player wallet in the kept profile lost its newest
// state, and the 17:34Z run locked a note the federation had already counted spent (lock refused, round VOID). A clean close writes storage
// out. The close is capped (capMs) so a hung browser never holds the exit; the wrapper's 8-min group kill stays the last word.
export async function closeThenExit(ctx, finish, capMs = 15000) {
  let timer;
  const cap = new Promise((r) => { timer = setTimeout(r, capMs); });
  let closing = null;
  try { closing = ctx && typeof ctx.close === 'function' ? Promise.resolve(ctx.close()).catch(() => {}) : null; } catch { closing = null; }
  if (closing) await Promise.race([closing, cap]);
  clearTimeout(timer);
  finish();
}
