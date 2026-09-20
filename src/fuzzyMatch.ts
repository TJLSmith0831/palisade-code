// Subsequence fuzzy matcher: every query char must appear in target, in
// order, but not necessarily contiguous. Consecutive-match runs score
// higher so "apt.ts" beats "a-p-t.ts" for the same query.
export function fuzzyMatch(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastMatchIndex === ti - 1 ? 3 : 1;
      lastMatchIndex = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return score - target.length * 0.01;
}

/**
 * How much a hit inside the file's own name is worth over one scattered
 * through its directories. Large enough that no path match can outrank a
 * name match: without it, typing `rea` offers
 * `build-out/cache/ast/5bb3c671….json` before `README.md`, because a long
 * path simply gives a short query more places to land.
 */
const NAME_BONUS = 1000;

/**
 * Score `path` for a file picker — the `@` mention menu and ⌘P alike.
 *
 * `null` when the query doesn't match the path at all.
 */
export function scorePath(query: string, path: string): number | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const inName = fuzzyMatch(query, name);
  if (inName !== null) return inName + NAME_BONUS;
  return fuzzyMatch(query, path);
}
