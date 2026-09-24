import { Button } from "@mantine/core";
import type { SpecStage } from "./stage";

const STEPS = [
  "Exploring",
  "Proposing",
  "Ready to apply",
  "Implementing",
] as const;
const STAGES: SpecStage[] = [
  "exploring",
  "proposing",
  "ready_to_apply",
  "implementing",
];

type Props = {
  stage: SpecStage;
  busy: boolean;
  canApply: boolean;
  onApply: () => void;
};

export function SpecProgress({ stage, busy, canApply, onApply }: Props) {
  const current = STAGES.indexOf(stage);
  if (current < 0) return null;

  return (
    <div className="ds-spec-progress" data-testid="spec-progress">
      <ol aria-label="Spec progress">
        {STEPS.map((label, index) => (
          <li
            key={label}
            data-state={
              index < current
                ? "done"
                : index === current
                  ? "current"
                  : "upcoming"
            }
            aria-current={index === current ? "step" : undefined}
          >
            <span className="ds-spec-step-number" aria-hidden="true">
              {index < current ? "✓" : index + 1}
            </span>
            <span className="ds-spec-step-label">{label}</span>
          </li>
        ))}
      </ol>
      <span className="sr-only" role="status">
        Spec progress: {STEPS[current]}
      </span>
      {stage === "ready_to_apply" && (
        <Button
          data-testid="apply-skill"
          size="xs"
          disabled={busy || !canApply}
          onClick={onApply}
        >
          Apply proposal
        </Button>
      )}
    </div>
  );
}
