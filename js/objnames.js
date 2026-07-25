// Project Planetarium — one shared spelling for object names. The same
// object arrives under many spellings: SIMBAD main_ids ("NAME Betelgeuse",
// "* alf Ori", "V* V645 Cen"), compound layer labels ("NGC 7293 — Helix
// Nebula"), user typing ("M 31", "messier 31"). Every feature that looks an
// object up by name — procedural renders, photographs, bundled
// descriptions — funnels through these two helpers so they can never
// disagree about what counts as the same object. The data pipeline
// (tools/fetch_descriptions.py) mirrors normalizeName when it writes its
// lookup keys; change one and you must change the other.

/** Canonical lowercase spelling; catalog designations collapse to one form
 *  ("m31", "ngc 224", "ic 434"). */
export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^name\s+/, '')
    .replace(/^v?\*\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^messier\s*(?=\d)/, 'm')
    .replace(/^m\s+(?=\d)/, 'm')
    .replace(/^(ngc|ic)\s*(?=\d)/, '$1 ');
}

/** Every plausible lookup key for a name and its aliases: the whole string,
 *  each side of an em-dash compound, and any parenthesized designation —
 *  all normalized, deduplicated, in caller order. */
export function matchKeysFor(name, aliases = []) {
  const raw = [name, ...(aliases || [])].flatMap((s) => {
    const t = String(s || '');
    const paren = t.match(/\(([^)]+)\)/);
    return [t, ...t.split('—'), t.replace(/\s*\([^)]*\)/g, ''), ...(paren ? [paren[1]] : [])];
  });
  return [...new Set(raw.map(normalizeName).filter(Boolean))];
}
