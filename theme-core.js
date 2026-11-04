// Shared by the launcher, overlay and browser windows: turns a theme into CSS variables.
(function () {
  const PRESETS = [
    { id: 'dusk', name: 'Dusk', background: '#161b2e', panel: '#20274a', accent: '#6c8cff' },
    { id: 'graphite', name: 'Graphite', background: '#17181a', panel: '#26282c', accent: '#e0a458' },
    { id: 'forest', name: 'Forest', background: '#12201b', panel: '#1c3029', accent: '#7ed6a4' },
    { id: 'paper', name: 'Paper', background: '#f3efe6', panel: '#e4ddcd', accent: '#2f5d8a' },
    { id: 'mono', name: 'Mono', background: '#101010', panel: null, accent: '#f2f2f2' },
    { id: 'ember', name: 'Ember', background: '#1a1214', panel: null, accent: '#ff6b4a' }
  ];

  const CORNERS = {
    rounded: { sm: '8px', md: '12px', lg: '14px', pill: '15px' },
    subtle: { sm: '4px', md: '6px', lg: '8px', pill: '6px' },
    blocky: { sm: '0px', md: '0px', lg: '0px', pill: '0px' }
  };

  const DEFAULT = { palette: 'dusk', background: '#161b2e', panel: '#20274a', accent: '#6c8cff', corners: 'rounded' };
  const LIGHT_TEXT = '#f2f4fa';
  const DARK_TEXT = '#14182a';

  function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function luminance(hex) {
    const [r, g, b] = rgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // Mix two hex colors; t is how much of b to blend in (0 to 1).
  function mix(a, b, t) {
    const ca = rgb(a);
    const cb = rgb(b);
    return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }

  // Light or dark text, whichever reads best on all the given backgrounds.
  function pickText(backgrounds) {
    const score = (t) => Math.min(...backgrounds.map((b) => contrast(t, b)));
    return score(LIGHT_TEXT) >= score(DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
  }

  // Fills in everything derived from the 2 or 3 chosen colors.
  function resolve(theme) {
    const panel = theme.panel || mix(theme.background, pickText([theme.background]), 0.1);
    const text = pickText([theme.background, panel]);
    return {
      ...theme,
      panel,
      text,
      accentText: pickText([theme.accent]),
      surfaceHi: mix(panel, text, 0.12),
      muted: mix(text, theme.background, 0.4),
      accentHover: mix(theme.accent, text, 0.18)
    };
  }

  function warnings(theme) {
    const r = resolve(theme);
    const issues = [];
    if (contrast(r.text, r.background) < 4.5 || contrast(r.text, r.panel) < 4.5) {
      issues.push('Text may be hard to read on these colors.');
    }
    if (contrast(r.accent, r.background) < 3) issues.push('The accent color blends into the background.');
    return issues;
  }

  function apply(theme) {
    const r = resolve(theme);
    const corners = CORNERS[theme.corners] || CORNERS.rounded;
    const s = document.documentElement.style;
    s.setProperty('--bg', r.background);
    s.setProperty('--surface', r.panel);
    s.setProperty('--surface-hi', r.surfaceHi);
    s.setProperty('--text', r.text);
    s.setProperty('--muted', r.muted);
    s.setProperty('--accent', r.accent);
    s.setProperty('--accent-hover', r.accentHover);
    s.setProperty('--accent-text', r.accentText);
    s.setProperty('--r-sm', corners.sm);
    s.setProperty('--r-md', corners.md);
    s.setProperty('--r-lg', corners.lg);
    s.setProperty('--r-pill', corners.pill);
  }

  window.Theme = { PRESETS, CORNERS, DEFAULT, apply, resolve, warnings };
})();