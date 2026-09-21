import { createContext, useContext } from "react";
import { Loader } from "@mantine/core";
import { IconArchive } from "@tabler/icons-react";

/** Thread ids whose archive is in flight. Archiving prunes a worktree and
 *  re-reads the thread list, so it can take a beat — every Archive control
 *  shows that beat instead of looking dead. A context, because the controls
 *  sit three components deep in unrelated lists. */
export const ArchivingContext = createContext<ReadonlySet<string>>(new Set());

export const useIsArchiving = (threadId: string) => useContext(ArchivingContext).has(threadId);

export const ArchivingSpinner = () => (
  <Loader size={12} className="ds-archive-busy" aria-label="Archiving" />
);

/** The archive glyph, or a spinner while that thread's archive is running. */
export function ArchiveIcon({ threadId }: { threadId: string }) {
  return useIsArchiving(threadId) ? <ArchivingSpinner /> : <IconArchive size={13} />;
}
