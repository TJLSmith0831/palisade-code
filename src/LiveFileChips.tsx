import { useMemo, useState } from "react";
import { Card, Group, Pill, ScrollArea, Text } from "@mantine/core";

import type { ExecutorEvent } from "./api";
import DiffRows from "./DiffRows";
import { rowsFromChange } from "./diffLines";

/** One file the running turn has touched, latest state wins. */
export type TouchedFile = {
  path: string;
  before: string;
  after: string;
  added: number;
  removed: number;
};

/** The files this turn has edited, in first-touched order, folded to one
 *  entry per path.
 *
 *  Folding is the point: an agent that rewrites the same file four times has
 *  edited one file, and a chip row that grew a chip per write would say
 *  something false about the size of the turn. The counts are per file and
 *  cumulative — `before` stays the first version seen, `after` the latest, so
 *  expanding a chip shows the whole turn's effect on that file, not its last
 *  keystroke. */
export function touchedFiles(events: ExecutorEvent[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>();
  for (const event of events) {
    if (event.kind !== "fileEdit") continue;
    const existing = byPath.get(event.path);
    const before = existing ? existing.before : event.before;
    const rows = rowsFromChange(before, event.after);
    byPath.set(event.path, {
      path: event.path,
      before,
      after: event.after,
      added: rows.filter((r) => r.type === "add").length,
      removed: rows.filter((r) => r.type === "remove").length,
    });
  }
  return [...byPath.values()];
}

type Props = {
  /** This turn's events, newest last. */
  live: ExecutorEvent[];
  /** An agent is mid-turn: the file it touched last is the one it is on. */
  busy: boolean;
};

/** A one-line row of the files the running turn is touching, above the
 *  composer, so review happens without leaving the thread.
 *
 *  It scrolls on its own axis rather than wrapping — a twenty-file turn stays
 *  one line tall, and the composer never gets pushed off screen by an agent
 *  having a productive minute. */
export default function LiveFileChips({ live, busy }: Props) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const files = useMemo(() => touchedFiles(live), [live]);
  const open = files.find((f) => f.path === openPath) ?? null;
  if (files.length === 0) return null;
  // Whichever file was written last is the one being worked on right now.
  const current = busy ? files[files.length - 1]?.path : undefined;

  return (
    <div data-testid="live-file-chips">
      <ScrollArea type="hover" scrollbarSize={6} offsetScrollbars={false}>
        <Group gap={6} wrap="nowrap" py={2}>
          {files.map((file) => {
            const name = file.path.split("/").pop() ?? file.path;
            return (
              <Pill
                key={file.path}
                size="sm"
                withRemoveButton={false}
                onClick={() =>
                  setOpenPath((p) => (p === file.path ? null : file.path))
                }
                title={file.path}
                data-testid="file-chip"
                data-active={file.path === current ? "true" : undefined}
                style={{ cursor: "pointer", fontFamily: "var(--mono, monospace)" }}
              >
                {file.path === current ? "● " : ""}
                <Text span c="teal" size="xs">
                  +{file.added}
                </Text>{" "}
                {file.removed > 0 && (
                  <>
                    <Text span c="red" size="xs">
                      −{file.removed}
                    </Text>{" "}
                  </>
                )}
                {name}
              </Pill>
            );
          })}
        </Group>
      </ScrollArea>
      {open && (
        <Card withBorder radius="md" p={0} mt={6} data-testid="file-chip-diff">
          <Text size="xs" ff="monospace" c="dimmed" px={9} py={6}>
            {open.path}
          </Text>
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            <DiffRows rows={rowsFromChange(open.before, open.after)} />
          </div>
        </Card>
      )}
    </div>
  );
}
