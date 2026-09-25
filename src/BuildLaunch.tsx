import { useState } from "react";
import { IconBolt, IconCompass, IconWriting } from "@tabler/icons-react";
import { Text } from "@mantine/core";
import { buildTarget } from "./skillLabel";

// A handoff arms its flourish for a few seconds; only a row for that handoff
// that first mounts inside the window plays it, so reopening a thread,
// re-rendering, or switching to another thread's row never does.
const WINDOW_MS = 4000;
let armed = { target: null as string | null, until: 0 };
const arm = (target: string) => {
  armed = { target, until: Date.now() + WINDOW_MS };
};
const useFreshSend = (target: string) =>
  useState(() => target === armed.target && Date.now() < armed.until)[0];

// Explore and Propose have no change name yet, so they arm under keys no
// Build target can be.
const PROPOSE = "\0propose";
const EXPLORE = "\0explore";

export const armBuildLaunch = (change: string | null | undefined) =>
  arm(buildTarget(`grill-apply ${change ?? ""}`)!);
export const armProposeHandoff = () => arm(PROPOSE);
export const armExploreHandoff = () => arm(EXPLORE);

/** An Explore turn opens the spec flow: the agent starts looking around before
 * anything is written, so the compass needle swings and settles once when it
 * is sent. `target` is the spec type the user framed it as. The row is fully
 * legible without the motion. */
export function ExploreHandoff({ target }: { target: string }) {
  const play = useFreshSend(EXPLORE);
  return (
    <div className="ds-launch ds-handoff-explore" data-testid="explore-handoff" data-play={play || undefined}>
      <span className="ds-launch-bolt" aria-hidden="true">
        <IconCompass size={16} stroke={2} />
      </span>
      <Text span fz="sm" c="dimmed" fw={500}>Explore</Text>
      <Text span fz="sm" fw={700} truncate>{target || "the idea"}</Text>
    </div>
  );
}

/** A Build turn is the moment an agent is dispatched into its own worktree, so
 * it reads as a launch: a charged bolt, and one light sweep across the row when
 * it is sent. The row is fully legible without the motion. */
export function BuildLaunch({ target }: { target: string }) {
  const play = useFreshSend(target);
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

/** A Propose turn is the exploration being written down as a change, so it
 * reads as writing: the pen dips, and the line is inked on left to right once
 * when it is sent. The row is fully legible without the motion. */
export function ProposeHandoff() {
  const play = useFreshSend(PROPOSE);
  return (
    <div className="ds-launch ds-handoff-propose" data-testid="propose-handoff" data-play={play || undefined}>
      <span className="ds-launch-bolt" aria-hidden="true">
        <IconWriting size={16} stroke={2} />
      </span>
      <span className="ds-handoff-ink">
        <Text span fz="sm" c="dimmed" fw={500}>Propose</Text>
        <Text span fz="sm" fw={700}>what we explored</Text>
      </span>
    </div>
  );
}
