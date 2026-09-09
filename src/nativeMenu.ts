/**
 * The single frontend seam for native-menu events. The Rust menu is only an
 * adapter: it sends a stable id here and receives this derived state back.
 */
export type CommandId = string;

export type CommandState = {
  enabled: boolean;
  checked?: boolean;
  label?: string;
};

export type CommandHandler = CommandState & { run: () => void };

export const approvedTopLevelMenus = [
  "Palisade", "File", "Edit", "View", "Go", "Run", "Window", "Help",
] as const;

export function createCommandBridge(commands: Record<CommandId, CommandHandler>) {
  return {
    dispatchCommand(id: CommandId): boolean {
      const command = commands[id];
      if (!command || !command.enabled) return false;
      command.run();
      return true;
    },
    menuState(): Record<CommandId, CommandState> {
      return Object.fromEntries(
        Object.entries(commands).map(([id, command]) => {
          const { enabled, checked, label } = command;
          return [id, { enabled, ...(checked === undefined ? {} : { checked }), ...(label ? { label } : {}) }];
        })
      );
    },
  };
}
