// The Spec/Go segmented control's accent styling, shared by the main
// composer (App.tsx) and the Fleet board's new-run row so the two controls
// read as one.
export const MODE_SELECTOR_STYLES = {
  root: {
    // Flexible, not fixed: 190px is the comfortable size, but a rigid block
    // here is what forced the controls row to wrap in a narrow chat pane.
    width: "var(--mode-selector-width, 190px)",
    minWidth: "var(--mode-selector-min-width, 104px)",
    height: "var(--mode-selector-height, 36px)",
    padding: 2,
    gap: 0,
    background: "transparent",
    border: "1px solid color-mix(in oklab, var(--accent), transparent 80%)",
    borderRadius: 999,
    boxSizing: "border-box" as const,
    overflow: "hidden",
  },
  indicator: {
    background: "var(--accent)",
    borderRadius: 999,
    boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.15)",
  },
  control: {
    flex: "1 1 0",
    width: "var(--mode-control-width, 50%)",
    minWidth: 0,
    height: "var(--mode-control-height, 32px)",
    minHeight: "var(--mode-control-height, 32px)",
    padding: 0,
    border: 0,
    borderRadius: 999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    color: "inherit",
  },
};
