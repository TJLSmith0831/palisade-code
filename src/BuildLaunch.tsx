import { useState } from "react";
import { IconBolt } from "@tabler/icons-react";
import { Text } from "@mantine/core";

// Apply arms the flourish for a few seconds; only a row that first mounts
// inside that window plays it, so reopening a thread or re-rendering never does.
const WINDOW_MS = 4000;
let armedUntil = 0;
export const armBuildLaunch = () => {
  armedUntil = Date.now() + WINDOW_MS;
};

/** A Build turn is the moment an agent is dispatched into its own worktree, so
 * it reads as a launch: a charged bolt, and one light sweep across the row when
 * it is sent. The row is fully legible without the motion. */
export function BuildLaunch({ target }: { target: string }) {
  const [play] = useState(() => Date.now() < armedUntil);
  return (
    <div className="ds-launch" data-testid="build-launch" data-play={play || undefined}>
      <span className="ds-launch-bolt" aria-hidden="true">
        <IconBolt size={16} stroke={2} />
      </span>
      <Text span fz="sm" c="dimmed" fw={500}>Build</Text>
      <Text span fz="sm" fw={700}>{target || "the proposal"}</Text>
    </div>
  );
}
