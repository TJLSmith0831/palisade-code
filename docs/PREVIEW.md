# Preview a project

Ask your agent to run or preview the application. Palisade bundles the
`palisade-preview` instructions for every interactive ACP agent, including
resumed sessions and agent handoffs. No skill installation is required.

The agent should use your project's development command, verify the running
server, and print its actual `http://localhost:…` or `http://127.0.0.1:…` URL in
tool output. Palisade detects that output and opens the Preview tab. Commands
run in Palisade's terminals use the same detection path.

You can also open Preview from the new-tab menu and enter a URL directly.
Reload refreshes the embedded page. Use the external-browser control when a
site's security policy prevents embedding. Native desktop applications run in
their own window rather than inside this web preview.

If preview does not open, check the server's startup output and permissions.
A URL mentioned only in the agent's chat response does not trigger automatic
opening. A failed server startup needs to be resolved before its URL will work.
