/**
 * Does an artboard's NAME carry this screen id?
 *
 * The join between a diagram and the designs it points at, and it lives in
 * `shared` because three different things need the same answer: the userflow's
 * `linkScreens` (plugin), the screen-coverage warning when a new artboard is
 * created (plugin), and the sitemap's IA-coverage check (server). Two copies
 * of a matching rule is two rules the moment one of them is tuned.
 *
 * Substring, but only on an id BOUNDARY: "1.1" must not match an artboard
 * called "1.10", and "01" must not match "101".
 */
/** Characters that can be part of a screen id, so "1.1" never matches "11.10". */
function isIdChar(ch: string): boolean {
  return ch !== "" && /[a-z0-9._-]/.test(ch);
}

/**
 * Does `name` (an artboard name like "1.2 · sign-in") carry `screenId` as a
 * WHOLE token? A plain substring test made "1.1" match "11.10 · order-history"
 * and wired a click-through to the wrong screen — silently, because one false
 * positive looks exactly like a correct hit.
 */
export function nameMatchesScreenId(name: string, screenId: string): boolean {
  const id = screenId.trim().toLowerCase();
  if (!id) return false;
  const hay = name.toLowerCase();
  for (let from = 0; from <= hay.length; ) {
    const i = hay.indexOf(id, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : hay.charAt(i - 1);
    const after = i + id.length >= hay.length ? "" : hay.charAt(i + id.length);
    if (!isIdChar(before) && !isIdChar(after)) return true;
    from = i + 1;
  }
  return false;
}
