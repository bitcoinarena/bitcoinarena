// HOW FAR A VISIT GOES (kanban #932): the page is one long page, so a page view says nothing about what was read. Every section has its own event, sent once when it reaches the
// middle of the screen; the scroll depth counts once at 25, 50, 75 and 100 %; a click on a download counts by file, without its version. Nothing here names a visitor.
(() => {
  const send = (name, data, tries = 0) => {
    if (window.umami && typeof window.umami.track === 'function') { try { window.umami.track(name, data); } catch { /* the page goes on */ } return; }
    if (tries < 20) setTimeout(() => send(name, data, tries + 1), 500);   // the script is deferred
  };
  const sections = [...document.querySelectorAll('header[id], section[id], footer')];
  if ('IntersectionObserver' in window) {
    const seen = new IntersectionObserver((rows) => rows.forEach((r) => {
      if (!r.isIntersecting) return;
      seen.unobserve(r.target);
      send(`section-${r.target.id || r.target.tagName.toLowerCase()}`, { place: sections.indexOf(r.target) + 1 });
    }), { rootMargin: '-50% 0px -50% 0px' });
    sections.filter((s) => s.tagName !== 'FOOTER').forEach((s) => seen.observe(s));
    // THE FOOTER IS TOO SHORT TO REACH THE MIDDLE OF A SCREEN: it counts when it comes into view
    const foot = new IntersectionObserver((rows) => rows.forEach((r) => {
      if (!r.isIntersecting) return;
      foot.unobserve(r.target);
      send('section-footer', { place: sections.indexOf(r.target) + 1 });
    }));
    sections.filter((s) => s.tagName === 'FOOTER').forEach((s) => foot.observe(s));
  }
  const marks = [25, 50, 75, 100]; let reached = 0, queued = false;
  const depth = () => {
    queued = false;
    const whole = document.documentElement.scrollHeight;
    const pct = whole > 0 ? ((window.scrollY + window.innerHeight) / whole) * 100 : 0;
    while (reached < marks.length && pct >= marks[reached] - 0.5) { send(`scroll-${marks[reached]}`); reached += 1; }
    if (reached >= marks.length) window.removeEventListener('scroll', onScroll);
  };
  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(depth); } };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('load', () => setTimeout(depth, 1000));
  // A DOWNLOAD: the file a link names, its version left out, so all releases of one file count together
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const asset = a.getAttribute('data-arena-release-asset');
    const url = String(a.href || '');
    if (asset) send('site-download', { file: asset.replace(/\{v\}/g, 'v').replace(/\d+\.\d+\.\d+(\.\d+)?/g, 'v') });
    else if (/\/releases(\/|$)/.test(url)) send('site-download', { file: 'release-page' });
  }, true);
})();
