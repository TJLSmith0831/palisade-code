import { useState } from "react";
import { IconBolt } from "@tabler/icons-react";
import { Text } from "@mantine/core";
import { buildTarget } from "./skillLabel";

// Apply arms the flourish for one change for a few seconds; only a row for
// that change that first mounts inside the window plays it, so reopening a
// thread, re-rendering, or switching to another thread's Build row never does.
const WINDOW_MS = 4000;
let armed = { target: null as string | null, until: 0 };
export const armBuildLaunch = (change: string | null | undefined) => {
  armed = { target: buildTarget(`grill-apply ${change ?? ""}`), until: Date.now() + WINDOW_MS };
};

/** A Build turn is the moment an agent is dispatched into its own worktree, so
 * it reads as a launch: a charged bolt, and one light sweep across the row when
 * it is sent. The row is fully legible without the motion. */
export function BuildLaunch({ target }: { target: string }) {
  const [play] = useState(() => target === armed.target && Date.now() < armed.until);
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
