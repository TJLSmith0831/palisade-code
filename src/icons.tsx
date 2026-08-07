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

export const NewFileIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 12v6M9 15h6" />
  </svg>
);

export const NewFolderIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4.5l2 3H19a2 2 0 0 1 2 2Z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v6M9 14h6" />
  </svg>
);
