import { ActionIcon, Button, CloseButton, Menu, Tabs, Tooltip } from "@mantine/core";
import {
  IconFilePlus,
  IconGitCompare,
  IconCode,
  IconEye,
  IconNotebook,
  IconPlus,
  IconSearch,
  IconTable,
  IconTerminal2,
  IconRoute,
  IconWorld,
} from "@tabler/icons-react";
import { isMarkdownPath, tabKey, type OpenTab } from "./openTabs";
import { onActivateKey } from "./a11y";

type Props = {
  tabs: OpenTab[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  /** Whether the centre pane is showing the diff rather than a file. */
  diffOpen: boolean;
  onToggleDiff: () => void;
  /** Whether the active Markdown tab shows exact source. */
  activeMdSource: boolean;
  onToggleMdSource: () => void;
  /** "+" menu: creates an untitled file at the project root (D14). */
  onNewFile: () => void;
  /** "+" menu: opens/focuses the singleton Preview tab (D13). */
  onNewPreview: () => void;
  /** "+" menu: opens a blank agent-chain tab (D16). */
  onNewChain: () => void;
  /** Opens the file palette (Cmd+P). Shown beside "+" so the quick way in is
   *  visible, not just a chord. */
  onGoToFile?: () => void;
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
      return tab.chainName ?? "New playbook";
    case "preview":
      return "Preview";
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
      return tab.chainName ? `Playbook: ${tab.chainName}` : "New playbook";
    case "preview":
      return tab.url ?? "Preview — no URL loaded";
    default:
      return tab.path;
  }
};

const tabIcons = {
  spec: IconNotebook,
  table: IconTable,
  query: IconTerminal2,
  chain: IconRoute,
  preview: IconWorld,
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
  activeMdSource,
  onToggleMdSource,
  onNewFile,
  onNewPreview,
  onNewChain,
  onGoToFile,
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
                      // also selecting the tab it's closing. Being a span, it
                      // also needs the role and tabIndex a button would have
                      // given it for free — without them the only way to close
                      // a file tab was with a mouse. Same shape as the thread
                      // tab's close in App.tsx.
                      role="button"
                      tabIndex={0}
                      onClick={(event) => {
                        event.stopPropagation();
                        onClose(key);
                      }}
                      onKeyDown={onActivateKey((event) => {
                        event.stopPropagation();
                        onClose(key);
                      })}
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

          {/* Sits inline right after the last tab, Chrome-style — not with
              the right-aligned diff/preview toggles. */}
          <Menu position="bottom-start" withinPortal>
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                aria-label="New tab"
                data-testid="new-tab"
                style={{ alignSelf: "center", flexShrink: 0 }}
              >
                <IconPlus size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconFilePlus size={14} />}
                data-testid="new-tab-file"
                onClick={onNewFile}
              >
                New File
              </Menu.Item>
              <Menu.Item
                leftSection={<IconWorld size={14} />}
                data-testid="new-tab-preview"
                onClick={onNewPreview}
              >
                New Preview
              </Menu.Item>
              <Menu.Item
                leftSection={<IconRoute size={14} />}
                data-testid="new-tab-chain"
                onClick={onNewChain}
              >
                New Playbook
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Tabs.List>
      </Tabs>

      {/* Outside the scrolling tab list, with the other right-hand controls:
          inline after the last tab it clipped off in a narrow pane. */}
      {onGoToFile && (
        <Tooltip label="Go to file (⌘P)" withinPortal>
          <ActionIcon
            variant="subtle"
            aria-label="Go to file"
            data-testid="go-to-file"
            onClick={onGoToFile}
            style={{ marginBottom: "0.25rem" }}
          >
            <IconSearch size={16} />
          </ActionIcon>
        </Tooltip>
      )}

      {isMarkdownPath(activePath) && (
        <Tooltip
          label={activeMdSource ? "Switch to Visual (⌘⇧V)" : "Switch to Markdown (⌘⇧V)"}
          withinPortal
        >
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={activeMdSource ? <IconCode size={14} /> : <IconEye size={14} />}
            aria-label={activeMdSource ? "Markdown mode; switch to Visual" : "Visual mode; switch to Markdown"}
            aria-pressed={activeMdSource}
            onClick={onToggleMdSource}
            data-testid="toggle-md-mode"
            ml="auto"
            style={{ marginBottom: "0.25rem" }}
          >
            {activeMdSource ? "Markdown" : "Visual"}
          </Button>
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
