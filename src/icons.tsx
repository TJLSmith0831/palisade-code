// Shared inline row-action icons — 24x24 viewBox, 1.5 stroke, matching
// App.tsx's SettingsIcon weight (the family used for small inline actions,
// as distinct from the 16x16/1.3 panel-toggle icon family).
export const RenameIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M18 2a2.83 2.83 0 1 1 4 4L7 21l-4 1 1-4L18 2Z" />
  </svg>
);

export const DeleteIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
  </svg>
);
