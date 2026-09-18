import { Badge, Tooltip } from "@mantine/core";
import type { FleetAttention, FleetRow, FleetVerify } from "./api";

// The three signals a fleet row carries, shared by the Fleet board and the
// sidebar so the same thread never reads two different ways depending on
// which surface you are looking at. Moved out of FleetBoard unchanged.

export const ATTENTION_LABEL: Record<FleetAttention, string> = {
  permission: "Needs permission",
  gate: "Needs approval",
  turn_done: "Turn finished",
  verify_failed: "Verify failed",
  merge_conflict: "Merge conflict",
  crashed: "Crashed",
};

/** Evidence, not opinion: a pass names the commit it was measured at, and
 *  "Not verified" is the honest default rather than a neutral blank. */
export function verifyBadge(verify: FleetVerify) {
  if (verify.state === "pass") {
    return {
      label: `Verified at ${(verify.commit ?? "").slice(0, 7)}`,
      color: "success",
      tip: verify.command ?? "Verified",
    };
  }
  if (verify.state === "fail") {
    return {
      label: "Verify failed",
      color: "danger",
      tip: verify.command ?? "The verify command exited non-zero",
    };
  }
  return {
    label: "Not verified",
    color: "neutral",
    tip: "No verify command has run at this commit",
  };
}

export function AttentionPill({ attention }: { attention: FleetAttention }) {
  return (
    <Badge size="xs" radius="sm" variant="light" color="warn" data-testid="fleet-attention">
      {ATTENTION_LABEL[attention]}
    </Badge>
  );
}

export function VerifyBadge({ verify }: { verify: FleetVerify }) {
  const badge = verifyBadge(verify);
  return (
    <Tooltip label={badge.tip} openDelay={400}>
      <Badge
        size="xs"
        radius="sm"
        variant="light"
        color={badge.color}
        data-testid="fleet-verify"
      >
        {badge.label}
      </Badge>
    </Tooltip>
  );
}

export function OverlapBadge({ overlap }: { overlap: FleetRow["overlap"] }) {
  if (overlap.length === 0) return null;
  return (
    <Tooltip label={overlap.flatMap((o) => o.files).join(", ")} openDelay={400}>
      <Badge
        size="xs"
        radius="sm"
        variant="light"
        color="neutral"
        data-testid="fleet-overlap"
      >
        {`Overlaps ${overlap.length} thread${overlap.length === 1 ? "" : "s"}`}
      </Badge>
    </Tooltip>
  );
}
