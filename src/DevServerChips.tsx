import { Tooltip } from "@mantine/core";
import { IconWorld } from "@tabler/icons-react";
import type { DevServer } from "./devServers";

/** More than this many at once is a monorepo's worth of ports; the rest are a count. */
const MAX_CHIPS = 3;

/**
 * Dev servers that are running right now, each one click from Preview. Sits in
 * the status bar so it is there whether the terminal is open or an agent
 * started the server out of sight.
 */
export default function DevServerChips({
  servers,
  onOpen,
}: {
  servers: DevServer[];
  onOpen: (url: string) => void;
}) {
  if (servers.length === 0) return null;
  const shown = servers.slice(0, MAX_CHIPS);
  const hidden = servers.length - shown.length;
  return (
    <>
      {shown.map((server) => {
        const host = new URL(server.url).host;
        return (
          <Tooltip key={server.url} label={`Open ${host} in Preview`} withinPortal>
            <button
              className="ds-status-item ds-status-item-enter"
              onClick={() => onOpen(server.url)}
              aria-label={`Open ${host} in Preview`}
              data-testid="dev-server-chip"
              data-origin={server.origin}
            >
              <IconWorld size={12} stroke={1.5} />
              {host}
              <span className="ds-status-dot ds-status-dot-success" aria-hidden="true" />
            </button>
          </Tooltip>
        );
      })}
      {hidden > 0 && (
        <span className="ds-status-note" data-testid="dev-server-more">
          +{hidden} more
        </span>
      )}
    </>
  );
}
