/**
 * Tester feedback, filed as a GitHub issue.
 *
 * The repo is private and the credential lives in the update Worker, so the
 * app posts here rather than talking to GitHub. A tester needs no GitHub
 * account and never sees the repo.
 *
 * Uses the webview's own fetch: `app.security.csp` is null, so no HTTP
 * plugin or extra capability is involved.
 */
import * as api from "./api";

export const FEEDBACK_URL =
  "https://palisade-updates.tjlsmith0831.workers.dev/feedback";

export type FeedbackResult = { number: number; url: string };

/** Everything a report should carry that a tester should not have to type. */
export function formatDiagnostics(d: api.Diagnostics): string {
  return [
    "",
    "---",
    `Palisade ${d.appVersion} · ${d.osVersion} · ${d.arch}`,
    `Agents: ${d.executor}`,
    `Model installed: ${d.modelInstalled ? "yes" : "no"}`,
  ].join("\n");
}

export async function sendFeedback(
  title: string,
  body: string,
  diagnostics: api.Diagnostics | null
): Promise<FeedbackResult> {
  const response = await fetch(FEEDBACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      body: body + (diagnostics ? formatDiagnostics(diagnostics) : ""),
    }),
  });

  if (!response.ok) {
    // The Worker's own message is the useful one for a rate limit; anything
    // else would tell the tester to check a log they cannot reach.
    const detail = await response
      .json()
      .then((payload: { error?: string }) => payload?.error)
      .catch(() => null);
    throw new Error(detail || `Could not send the report (${response.status}).`);
  }
  return response.json();
}
