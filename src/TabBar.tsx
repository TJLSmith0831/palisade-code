import { ActionIcon, CloseButton, Tabs, Tooltip } from "@mantine/core";
import { IconGitCompare } from "@tabler/icons-react";
import type { OpenTab } from "./openTabs";

type Props = {
  tabs: OpenTab[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** Whether the centre pane is showing the diff rather than a file. */
  diffOpen: boolean;
  onToggleDiff: () => void;
};

/** `src/components/Foo.tsx` -> `Foo.tsx`. The full path is the tooltip. */
export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The open files, and a way into the diff.
 *
 * The diff deliberately isn't a peer tab: once the editor is the main
 * surface, a co-equal "Code Change Diff" tab costs a slot the file you're
 * editing should have. It's a toggle pinned to the right instead.
 */
export default function TabBar({
  tabs,
  activePath,
  onSelect,
  onClose,
  diffOpen,
  onToggleDiff,
}: Props) {
  return (
    <div className="ds-editor-tabs" data-testid="editor-tabs">
      <Tabs
        value={diffOpen ? null : activePath}
        onChange={(value) => value && onSelect(value)}
        variant="default"
        style={{ flex: 1, minWidth: 0 }}
      >
        <Tabs.List style={{ flexWrap: "nowrap", overflowX: "auto" }}>
          {tabs.map((tab) => (
            <Tooltip key={tab.path} label={tab.path} openDelay={600} withinPortal>
              <Tabs.Tab
                value={tab.path}
                className="ds-tab"
                data-testid="file-tab"
                data-path={tab.path}
                data-dirty={tab.dirty || undefined}
                // Middle-click closes, the same as every browser and editor.
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  onClose(tab.path);
                }}
                rightSection={
                  <CloseButton
                    component="span"
                    size={14}
                    aria-label={`Close ${tab.path}`}
                    data-testid="file-tab-close"
                    // The tab is a button; a nested button would be invalid
                    // markup, so this is a span that stops the click from
                    // also selecting the tab it's closing.
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose(tab.path);
                    }}
                  />
                }
              >
                {tab.dirty && (
                  <span className="ds-tab-dirty" data-testid="file-tab-dirty" aria-label="Unsaved changes">
                    ●
                  </span>
                )}
                {basename(tab.path)}
              </Tabs.Tab>
            </Tooltip>
          ))}
        </Tabs.List>
      </Tabs>

      <Tooltip label={diffOpen ? "Back to editor" : "Review changes"} withinPortal>
        <ActionIcon
          variant={diffOpen ? "filled" : "subtle"}
          aria-label={diffOpen ? "Back to editor" : "Review changes"}
          aria-pressed={diffOpen}
          onClick={onToggleDiff}
          data-testid="toggle-diff"
          ml="auto"
        >
          <IconGitCompare size={16} />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}
