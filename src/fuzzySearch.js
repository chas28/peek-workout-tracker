import Fuse from "fuse.js";

// Shared search behavior for every exercise search/autocomplete in the app.
// Uses Fuse's extended search, where unquoted space-separated terms are
// ANDed together and each is fuzzy-matched independently — so "incline
// bench" finds "Incline Barbell Bench Press" (the words aren't adjacent)
// and "incilne" still finds "Incline ..." entries despite the typo.
const FUSE_OPTIONS = {
  threshold: 0.3,
  ignoreLocation: true,
  useExtendedSearch: true,
};

export function fuzzySearch(list, query, options) {
  const q = query.trim();
  if (!q) return list;
  const fuse = new Fuse(list, { ...FUSE_OPTIONS, ...options });
  return fuse.search(q).map(r => r.item);
}
