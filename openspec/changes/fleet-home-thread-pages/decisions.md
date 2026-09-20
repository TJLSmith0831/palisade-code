# Decision log — fleet-home-thread-pages

## D1: Chat becomes a thread's page; the sidebar becomes Fleet's quick access
Chat is the transcript of one thread, so it is the destination of a Fleet row,
not a peer view of the board. The sidebar is not a second, competing list: it
is the same fleet rows in compact form, kept as quick access from inside a
thread. (An earlier draft removed it; reversed on review — it is wanted.)

## D2: Chat cannot be closed
"Collapsing chat would leave the editor alone on screen, which is a different
app" (App.tsx). Removing the toggle makes the zero-pane blank canvas
unreachable by construction. Editor and terminal remain toggles.

## D3: Cmd+K is "Back to Fleet"
It was "Toggle chat panel" (`view.chat`). With chat not closable the chord is
free; the palette entry is renamed and the chord kept.

## D4: Workbench rail works from Fleet with no thread open
Yes — unchanged. Explorer/Search/Git open beside the chat pane, which shows its
starter card while no thread is selected.

## D5: The chat starter card stays
"How do you want to start?" still shows for a thread created outside Fleet.

## D6: A saved "chat collapsed" flag is ignored
The old collapse flag persists in localStorage. It is no longer read, so a user
who had collapsed chat does not land in a thread with no way to reopen it.

## D7: "Threads" is renamed "Agent Access", icon-only
The label named a concept (threads); the button is quick access to the fleet
from inside a thread. It drops its text and carries an "Agent Access" tooltip,
so the pill reads `← Fleet` + one icon. `← Fleet` and Agent Access share one pill.
