'use strict';

(() => {
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (motionPreference.matches) return;

  let navigationPending = false;
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download') || link.relList.contains('external')) return;

    let destination;
    try { destination = new URL(link.href, window.location.href); }
    catch { return; }
    if (destination.origin !== window.location.origin) return;
    if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;

    event.preventDefault();
    if (navigationPending) return;
    navigationPending = true;
    document.body.classList.add('page-leaving');
    window.setTimeout(() => { window.location.assign(destination.href); }, 220);
  });

  window.addEventListener('pageshow', () => {
    navigationPending = false;
    document.body.classList.remove('page-leaving');
  });
})();
