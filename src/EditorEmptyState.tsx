import { Group, Kbd, Stack, Text, UnstyledButton } from "@mantine/core";
import { formatChord, type Command } from "./commands";

/** The actions worth teaching on an empty editor, in the order a new user
 * needs them. Anything missing from the registry (a disabled command) is
 * simply not listed. */
const SHOWN = [
  "file.open",
  "file.search",
  "view.explorer",
  "file.new",
  "view.terminal",
  "help.commands",
];

type Props = { commands: Command[] };

/** Zed-style empty editor: the shortcuts that get you into a file, each one
 * clickable. Reads from the command registry so a rebound chord shows its
 * new key here without a second edit. */
export default function EditorEmptyState({ commands }: Props) {
  const rows = SHOWN.map((id) => commands.find((c) => c.id === id)).filter(
    (c): c is Command => !!c && c.enabled !== false
  );
  return (
    <div className="editor-empty" data-testid="editor-empty">
      <Stack gap={2} className="editor-empty-list">
        {rows.map((command) => (
          <UnstyledButton
            key={command.id}
            className="editor-empty-row"
            onClick={command.run}
          >
            <Group justify="space-between" gap="md" wrap="nowrap">
              <Text size="sm" c="dimmed">
                {command.label}
              </Text>
              {command.chord && (
                <Kbd size="xs" className="editor-empty-kbd">
                  {formatChord(command.chord)}
                </Kbd>
              )}
            </Group>
          </UnstyledButton>
        ))}
      </Stack>
    </div>
  );
}
