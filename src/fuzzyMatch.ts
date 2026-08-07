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
