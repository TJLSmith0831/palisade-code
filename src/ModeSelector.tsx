import { SegmentedControl } from "@mantine/core";
import { IconBolt, IconListCheck } from "@tabler/icons-react";
import type { Mode } from "./api";
import { MODE_SELECTOR_STYLES } from "./modeSelectorStyles";

const OPTIONS = [
  {
    value: "spec",
    label: (
      <>
        <IconListCheck size={16} stroke={2} aria-hidden="true" />
        <span className="mode-selector-text">Spec</span>
      </>
    ),
  },
  {
    value: "go",
    label: (
      <>
        <IconBolt size={16} stroke={2} aria-hidden="true" />
        <span className="mode-selector-text">Go</span>
      </>
    ),
  },
];

type Props = {
  value: Mode;
  onChange: (mode: Mode) => void;
  disabled?: boolean;
  testId: string;
  ariaLabel: string;
};

export function ModeSelector({
  value,
  onChange,
  disabled,
  testId,
  ariaLabel,
}: Props) {
  return (
    <SegmentedControl
      className="ds-mode-selector"
      value={value}
      onChange={(next) => onChange(next as Mode)}
      disabled={disabled}
      data={OPTIONS}
      aria-label={ariaLabel}
      data-testid={testId}
      size="xs"
      styles={MODE_SELECTOR_STYLES}
      classNames={{
        control: "mode-selector-control",
        label: "mode-selector-label",
      }}
    />
  );
}
