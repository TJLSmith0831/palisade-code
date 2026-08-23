import { ActionIcon, CloseButton, Tabs, Tooltip } from "@mantine/core";
import {
  IconGitCompare,
  IconMarkdown,
  IconNotebook,
  IconTable,
  IconTerminal2,
  IconRoute,
} from "@tabler/icons-react";
import { isMarkdownPath, tabKey, type OpenTab } from "./openTabs";

type Props = {
  tabs: OpenTab[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** Whether the centre pane is showing the diff rather than a file. */
  diffOpen: boolean;
  onToggleDiff: () => void;
  /** Whether the active Markdown tab is showing its preview pane. */
  activeMdPreview: boolean;
  onToggleMdPreview: () => void;
};

/** `src/components/Foo.tsx` -> `Foo.tsx`. The full path is the tooltip. */
export const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** What the tab says. Short enough to fit a tab; the tooltip carries the rest. */
export const tabLabel = (tab: OpenTab): string => {
  switch (tab.type) {
    case "spec":
      return tab.specName;
    case "table":
      return tab.table;
    case "query":
      return `SQL — ${tab.connectionName}`;
    case "chain":
      return tab.chainName ?? "New chain";
    default:
      return basename(tab.path);
  }
};

const tabTooltip = (tab: OpenTab): string => {
  switch (tab.type) {
    case "spec":
      return `OpenSpec change: ${tab.specName}`;
    case "table":
      return tab.schema ? `${tab.schema}.${tab.table}` : tab.table;
    case "query":
      return `SQL editor for ${tab.connectionName}`;
    case "chain":
      return tab.chainName ? `Agent chain: ${tab.chainName}` : "New agent chain";
    default:
      return tab.path;
  }
};

const tabIcons = {
  spec: IconNotebook,
  table: IconTable,
  query: IconTerminal2,
  chain: IconRoute,
} as const;

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
  activeMdPreview,
  onToggleMdPreview,
}: Props) {
  return (
    <div className="ds-editor-tabs" data-testid="editor-tabs">
      <Tabs
        value={diffOpen ? null : activePath}
        onChange={(value) => value && onSelect(value)}
        variant="default"
        style={
          {
            flex: 1,
            minWidth: 0,
            "--tab-border-color": "transparent",
          } as React.CSSProperties
        }
      >
        <Tabs.List style={{ flexWrap: "nowrap", overflowX: "auto" }}>
          {tabs.map((tab) => {
            const key = tabKey(tab);
            const label = tabLabel(tab);
            const tooltip = tabTooltip(tab);
            return (
              <Tooltip key={key} label={tooltip} openDelay={600} withinPortal>
                <Tabs.Tab
                  value={key}
                  className="ds-tab"
                  data-testid="file-tab"
                  data-path={key}
                  data-dirty={tab.dirty || undefined}
                  data-tab-type={tab.type}
                  // Middle-click closes, the same as every browser and editor.
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    onClose(key);
                  }}
                  leftSection={(() => {
                    const Icon = tabIcons[tab.type as keyof typeof tabIcons];
                    return Icon ? (
                      <Icon size={14} style={{ flexShrink: 0 }} />
                    ) : undefined;
                  })()}
                  rightSection={
                    <CloseButton
                      component="span"
                      size={14}
                      aria-label={`Close ${label}`}
                      data-testid="file-tab-close"
                      // The tab is a button; a nested button would be invalid
                      // markup, so this is a span that stops the click from
                      // also selecting the tab it's closing.
                      onClick={(event) => {
                        event.stopPropagation();
                        onClose(key);
                      }}
                    />
                  }
                >
                  {tab.dirty && (
                    <span
                      className="ds-tab-dirty"
                      data-testid="file-tab-dirty"
                      aria-label="Unsaved changes"
                    >
                      ●
                    </span>
                  )}
                  {label}
                </Tabs.Tab>
              </Tooltip>
            );
          })}
        </Tabs.List>
      </Tabs>

      {isMarkdownPath(activePath) && (
        <Tooltip
          label={activeMdPreview ? "Hide preview" : "Show preview"}
          withinPortal
        >
          <ActionIcon
            variant={activeMdPreview ? "filled" : "subtle"}
            aria-label={activeMdPreview ? "Hide preview" : "Show preview"}
            aria-pressed={activeMdPreview}
            onClick={onToggleMdPreview}
            data-testid="toggle-md-preview"
            ml="auto"
            style={{ marginBottom: "0.25rem" }}
          >
            <IconMarkdown size={16} />
          </ActionIcon>
        </Tooltip>
      )}

      <Tooltip
        label={diffOpen ? "Back to editor" : "Review changes"}
        withinPortal
      >
        <ActionIcon
          variant={diffOpen ? "filled" : "subtle"}
          aria-label={diffOpen ? "Back to editor" : "Review changes"}
          aria-pressed={diffOpen}
          onClick={onToggleDiff}
          data-testid="toggle-diff"
          ml={isMarkdownPath(activePath) ? undefined : "auto"}
          style={{ marginBottom: "0.25rem" }}
        >
          <IconGitCompare size={16} />
        </ActionIcon>
      </Tooltip>
    </div>
  );
}
