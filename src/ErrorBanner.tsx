import { Alert, Code, Text } from "@mantine/core";
import { IconAlertCircle, IconAlertTriangle } from "@tabler/icons-react";
import { stripAnsi } from "./detectDevServerUrl";

export default function ErrorBanner({ message, tone, onDismiss }: {
  message: string;
  tone: "error" | "warn";
  onDismiss(): void;
}) {
  const detail = stripAnsi(message).trim();
  const firstLine = detail.split(/\r?\n/, 1)[0];
  const verification = tone === "error" && firstLine.match(/Verification (.+?) failed\./);
  const expandedDetail = detail.includes("\n") || detail.length > 220;
  const summary = verification
    ? `The “${verification[1]}” check failed. Fix the failing check, then run verification again.`
    : firstLine.length > 220 ? `${firstLine.slice(0, 220)}…` : firstLine;

  return (
    <Alert className="ds-error-banner" color={tone === "warn" ? "warn" : "danger"}
      variant="light" radius={0} p="md" title={verification ? "Verification failed" : undefined}
      icon={tone === "warn" ? <IconAlertTriangle size={16} aria-hidden="true" /> : <IconAlertCircle size={16} aria-hidden="true" />}
      withCloseButton onClose={onDismiss} closeButtonLabel={tone === "warn" ? "Dismiss warning" : "Dismiss error"}
      role={tone === "warn" ? "status" : "alert"} data-testid="error" data-tone={tone}>
      <Text size="sm" className="ds-error-summary">{summary}</Text>
      {expandedDetail && <details className="ds-error-details">
        <summary>Details</summary>
        <Code block className="ds-error-log" tabIndex={0} aria-label="Diagnostic details">{detail}</Code>
      </details>}
    </Alert>
  );
}
