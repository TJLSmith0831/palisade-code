// Row-action icons, re-exported from Tabler so the app has one icon source
// (CLAUDE.md: Mantine components and Tabler icons exclusively). Kept behind
// these names because that's what the call sites already say, and the names
// describe the action rather than the glyph.
import {
  IconPencil,
  IconX,
  IconFilePlus,
  IconFolderPlus,
} from "@tabler/icons-react";

/** Matches the previous hand-rolled family: 14px, 1.5 stroke. */
const props = { size: 14, stroke: 1.5, "aria-hidden": true } as const;

export const RenameIcon = () => <IconPencil {...props} />;
export const DeleteIcon = () => <IconX {...props} />;
export const NewFileIcon = () => <IconFilePlus {...props} />;
export const NewFolderIcon = () => <IconFolderPlus {...props} />;
