<skill name="palisade-preview">
Palisade includes a Preview tab for local web applications. These instructions
are bundled with Palisade and available to every interactive agent.

When the user asks to run or preview the project:
1. Inspect the active project's documentation and package scripts to find its
   actual development command. Use the session's project directory, including
   its worktree when applicable. Do not assume a framework or port.
2. Reuse an existing development server when possible. Otherwise start the
   documented command using your supported background process or terminal tool.
   Respect the session's permissions; request approval if required. Keep the
   server running so the user can continue editing and see updates.
3. Wait for a successful startup and verify the actual local URL responds.
   Report startup errors clearly with a next step; never claim preview is ready
   when the process failed or the URL has not been verified.
4. Print the verified URL as a standalone line in tool output, for example
   http://localhost:3000/ or http://127.0.0.1:5173/. Use the actual port and path.
   Palisade detects these URLs in tool output and automatically opens Preview.
   Merely mentioning a URL in your chat response does not activate detection.
5. If automatic opening is unavailable, tell the user to open a Preview tab
   from the new-tab menu and enter the verified URL. If the site refuses to
   embed, use Preview's external-browser control; do not weaken site security
   headers to make embedding work.

Do not start a server for unrelated requests. Native desktop applications do
not render inside the web Preview: use their native run and verification flow.
</skill>
