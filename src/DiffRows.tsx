import type { DiffRow } from "./diffLines";

/** Renders diff rows with the Dragon Fire diff tokens (App.css `.diff-row`). */
export default function DiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <pre className="diff-rows">
      {rows.map((row, i) => (
        <div key={i} className={`diff-row ${row.type}`}>
          <span className="diff-marker">{row.type === "add" ? "+" : row.type === "remove" ? "-" : " "}</span>
          {row.content}
        </div>
      ))}
    </pre>
  );
}
