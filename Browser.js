const $ = (id) => document.getElementById(id);

if (!window.browserApi) {
  $('address').value = 'Browser failed to load: check that browser-preload.js is in the app folder.';
  throw new Error('browserApi is missing: browser-preload.js did not load');
}

function apply(state) {
  if (!state) return;
  $('back').disabled = !state.canGoBack;
  $('forward').disabled = !state.canGoForward;
  $('reload').textContent = state.loading ? '✕' : '↻';
  $('reload').title = state.loading ? 'Stop loading' : 'Reload';
  $('reload').setAttribute('aria-label', state.loading ? 'Stop loading' : 'Reload');
  if (document.activeElement !== $('address')) $('address').value = state.url || '';
}

$('back').addEventListener('click', () => window.browserApi.back());
$('forward').addEventListener('click', () => window.browserApi.forward());
$('reload').addEventListener('click', () => window.browserApi.reload());
$('home').addEventListener('click', () => window.browserApi.home());
$('close').addEventListener('click', () => window.browserApi.close());

$('address').addEventListener('focus', () => $('address').select());
$('address').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    window.browserApi.navigate($('address').value);
    $('address').blur();
  }
});

window.browserApi.onState(apply);
window.browserApi.getState().then(apply);

window.browserApi.getTheme().then(Theme.apply);
window.browserApi.onTheme(Theme.apply);