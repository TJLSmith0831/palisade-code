import { useEffect, useState } from "react";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconInfoCircle,
} from "@tabler/icons-react";
import {
  DIAGNOSTICS_CHANGED,
  allDiagnostics,
  type Diagnostic,
} from "./lspClients";

// Amendment 2's Problems tab. Everything here comes from a language server —
// Palisade does not invent diagnostics, so an empty list means the servers said
// nothing, not that the code is proven fine. The empty state says which.

const ICON = {
  error: IconAlertCircle,
  warning: IconAlertTriangle,
  info: IconInfoCircle,
  hint: IconInfoCircle,
} as const;

const TONE = {
  error: "bad",
  warning: "warn",
  info: "muted",
  hint: "muted",
} as const;

export default function ProblemsPane({
  onOpen,
}: {
  onOpen: (path: string, line: number) => void;
}) {
  const [rows, setRows] = useState<Diagnostic[]>(allDiagnostics);

  useEffect(() => {
    const refresh = () => setRows(allDiagnostics());
    window.addEventListener(DIAGNOSTICS_CHANGED, refresh);
    refresh();
    return () => window.removeEventListener(DIAGNOSTICS_CHANGED, refresh);
  }, []);

  if (rows.length === 0) {
    return (
      <p className="empty" data-testid="problems-empty">
        No problems reported by the language servers.
      </p>
    );
  }

  return (
    <div className="ds-problems" data-testid="problems-list">
      {rows.map((row, index) => {
        const Icon = ICON[row.severity];
        return (
          <button
            key={`${row.path}:${row.line}:${index}`}
            className="ds-problem-row"
            onClick={() => onOpen(row.path, row.line)}
            data-testid="problem-row"
            data-severity={row.severity}
          >
            <Icon size={14} className={`ds-problem-icon-${TONE[row.severity]}`} />
            <span className="ds-problem-message">{row.message}</span>
            <span className="ds-problem-where">
              {row.path}:{row.line}
              {row.source ? ` · ${row.source}` : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}
