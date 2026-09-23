/* search.js — Fuse.js index build + query. Never writes to the DB. */

let fuse = null;

const FUSE_OPTIONS = {
  // Title matches must outrank body matches — Fuse does not infer this.
  keys: [
    { name: 'title', weight: 2 },
    { name: 'body', weight: 1 },
    { name: 'tags', weight: 1 },
  ],
  threshold: 0.4,
  ignoreLocation: true,
};

export function buildIndex(notes) {
  fuse = new Fuse(notes, FUSE_OPTIONS);
  return fuse;
}

/** Returns [{ item, score, refIndex }] or null when the query is blank/no index. */
export function search(query) {
  const q = query.trim();
  if (!fuse || !q) return null;
  return fuse.search(q);
}
