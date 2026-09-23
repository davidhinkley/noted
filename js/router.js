/* router.js — hash router + route table. No view logic lives here. */

const ROUTES = [
  { name: 'list', pattern: /^#?\/?$/, params: () => ({}) },
  {
    name: 'note',
    pattern: /^#\/note\/([^/]+)\/?$/,
    params: (m) => ({ id: safeDecode(m[1]) }),
  },
  {
    name: 'tag',
    pattern: /^#\/tag\/(.+)\/?$/,
    params: (m) => ({ tag: safeDecode(m[1]) }),
  },
];

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseHash(hash = window.location.hash) {
  for (const route of ROUTES) {
    const match = hash.match(route.pattern);
    if (match) return { name: route.name, params: route.params(match) };
  }
  return { name: 'notfound', params: {} };
}

/** Calls onChange immediately, then on every hash change. Returns a stop fn. */
export function startRouter(onChange) {
  const handler = () => onChange(parseHash());
  window.addEventListener('hashchange', handler);
  handler();
  return () => window.removeEventListener('hashchange', handler);
}

export function navigate(hash) {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}
