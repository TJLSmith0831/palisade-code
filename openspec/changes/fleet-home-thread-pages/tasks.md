## 1. Thread page chrome

- [x] 1.1 `← Fleet` button in the top bar (thread view only); opens the Fleet
  panel. Grouped with the Agent Access toggle in one pill.
- [x] 1.2 Remove the Chat toggle; rename the Threads toggle to Agent Access.

## 2. Chat is never closable

- [x] 2.1 Chat always renders; drop `chatOpen`/`toggleChat`, the collapsed strip
  and its CSS; ignore the persisted collapse flag.
- [x] 2.2 Keep the sidebar and its state; only rename it.
- [x] 2.3 Cmd+K → "Back to Fleet"; drop the chat-reclaim call sites.

## 3. Verify

- [x] 3.1 Update tests for the removed Chat toggle; add tests for the back
  button, the ignored collapse flag and the new Cmd+K.
- [x] 3.2 `tsc`, `pnpm test`, screenshots of Fleet → thread → back.
- [x] 3.3 Brooks review clean of Critical/Warning findings.
