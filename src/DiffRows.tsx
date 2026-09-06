import { useMemo } from "react";
import type { DiffRow } from "./diffLines";
import { pairRows } from "./diffLines";

/** Inline (unified) or side-by-side. Inline stays the default: it is what
 *  the pane has always shown, and it is the readable one in a narrow panel. */
export type DiffView = "inline" | "split";

const MARKER = { add: "+", remove: "−", context: " " } as const;

/** One side of the split view. A null row is the blank cell opposite a pure
 *  add or delete — it carries no marker and no number. */
function SplitCell({ row, side }: { row: DiffRow | null; side: "old" | "new" }) {
  if (!row) return <div className="diff-cell blank" aria-hidden="true" />;
  const number = side === "old" ? row.oldLine : row.newLine;
  // A context line shows on both sides; an add has no old side and a remove
  // no new side, so the opposite cell renders blank rather than repeating it.
  if (side === "old" && row.type === "add")
    return <div className="diff-cell blank" aria-hidden="true" />;
  if (side === "new" && row.type === "remove")
    return <div className="diff-cell blank" aria-hidden="true" />;
  return (
    <div className={`diff-cell ${row.type}`}>
      <span className="diff-lineno">{number ?? ""}</span>
      <span className="diff-marker">{MARKER[row.type]}</span>
      <span className="diff-content">{row.content}</span>
    </div>
  );
}

/** Renders diff rows with the Dragon Fire diff tokens (App.css `.diff-row`). */
export default function DiffRows({
  rows,
  view = "inline",
}: {
  rows: DiffRow[];
  view?: DiffView;
}) {
  const pairs = useMemo(() => (view === "split" ? pairRows(rows) : []), [rows, view]);

  if (view === "split") {
    return (
      <div className="diff-rows split" data-testid="diff-rows-split">
        {pairs.map((pair, i) => (
          <div key={i} className="diff-pair">
            <SplitCell row={pair.left} side="old" />
            <SplitCell row={pair.right} side="new" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <pre className="diff-rows" data-testid="diff-rows-inline">
      {rows.map((row, i) => (
        <div key={i} className={`diff-row ${row.type}`}>
          {row.oldLine !== undefined || row.newLine !== undefined ? (
            <>
              <span className="diff-lineno">{row.oldLine ?? ""}</span>
              <span className="diff-lineno">{row.newLine ?? ""}</span>
            </>
          ) : null}
          <span className="diff-marker">
            {row.type === "add" ? "+" : row.type === "remove" ? "-" : " "}
          </span>
          {row.content}
        </div>
      ))}
    </pre>
  );
}
