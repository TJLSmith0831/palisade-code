# Run/Debug Buttons Decision Log

## D1: Should LSP and run/debug be separate changes or combined?
- **Decision**: Separate changes - LSP integration first, run/debug buttons second
- **Why**: LSP integration is a foundational editor capability that affects the entire codebase (editor extensions, IPC commands, settings). Run/debug buttons are UI workflow enhancements that can build on top of a working editor. Separating them allows for independent testing, validation, and rollout.
- **Source**: grill-explore

## D2: What should the run/debug button actually do in Floo's context?
- **Decision**: Run button executes configured commands in the terminal pane, not traditional debugger attachment
- **Why**: Floo is an agent harness, not a traditional debugger. The terminal pane already exists and can run commands. Traditional debugging (breakpoints, step-through) would require debugger protocol adapters (DAP) which is a separate complex system. The run button should be a shortcut to run common project commands (dev server, tests, build) in the existing terminal, similar to Replit's run button or JetBrains' npm script configurations.
- **Source**: grill-explore

## D3: How should run commands be configured and stored?
- **Decision**: Extend `.project-settings.json` with a `run` field (HashMap<String, String>) similar to existing `verify` field
- **Why**: Floo already has the pattern in place with `verify` commands. Adding a `run` field follows the same structure: command name → shell command. This keeps project-specific run commands with the project, version-controlled, and discoverable. The UI can present these as a dropdown or split-button similar to VS Code's run/debug patterns.
- **Source**: grill-explore

## D4: Where should the run button be placed in the UI?
- **Decision**: Run button in the editor tab bar (next to file name), similar to VS Code's editor title run button
- **Why**: VS Code's pattern places run/debug actions in the editor title bar for contextual access to the current file's run configurations. Floo already has a tab bar (TabBar.tsx) that shows file names. Adding a run button there provides contextual access without cluttering the main toolbar. This follows the established IDE pattern while fitting Floo's existing layout.
- **Source**: grill-explore

## D5: Should the run button be a split button (run + dropdown) or simple button?
- **Decision**: Split button with primary action and dropdown for alternative commands
- **Why**: VS Code's research showed split buttons are superior for multiple actions - one click for the default, dropdown for alternatives. Floo's `run` configuration may have multiple commands (dev, test, build). A split button allows quick access to the most-used command while keeping others accessible. This matches the established IDE pattern and handles the common case of multiple run targets.
- **Source**: grill-explore

## D6: What should be the non-goals for run/debug buttons?
- **Decision**: No debugger protocol (DAP), no LSP server installation management, no full extension ecosystem
- **Why**: Traditional debugging (breakpoints, step-through, watch variables) requires DAP integration which is a separate complex system beyond the scope of adding basic IDE pieces. LSP server installation should be user-managed (npm install, pip install, cargo install) - Floo should detect and use, not manage. Full extension ecosystem (like VS Code) is out of scope - Floo is an agent harness, not a general-purpose IDE platform.
- **Source**: grill-explore

## D7: Why implement run/debug buttons now? What's the timing driver?

- **Decision**: Workflow efficiency and user expectation - developers expect quick access to run common commands without manually typing them in the terminal every time
- **Why**: The timing is right because the terminal pane already exists and works well, so adding run buttons is a UI enhancement that builds on existing infrastructure. This makes Floo feel more like a complete development environment rather than just an agent interface.
- **Source**: recommended-accepted

## D8: Who benefits from run/debug buttons and what's the primary user-facing impact?

- **Decision**: Developers who use Floo as their daily editor and need to frequently run project commands (dev servers, test suites, builds)
- **Why**: The impact is threefold: (1) Velocity - one-click access to common commands instead of typing them repeatedly, (2) Consistency - standardized run configurations across team members via version-controlled .project-settings.json, (3) Discoverability - new team members can see available run commands without knowing project-specific conventions. This reduces friction in the development workflow.
- **Source**: recommended-accepted

## D9: What's the explicit scope boundary for this change - what's definitively in vs out?

- **Decision**: IN - Run button in editor tab bar (split button with primary action + dropdown), run commands stored in .project-settings.json as HashMap<String, String>, commands execute in existing TerminalPane, UI shows available run commands from configuration, primary action remembers last-used command. OUT - Traditional debugger integration (breakpoints, step-through), command output parsing/visualization, command history/recall UI, environment variable configuration per command, complex command chaining/pipelines.
- **Why**: This keeps the change focused on quick command execution while avoiding scope creep into full IDE debugger territory. The terminal pane already handles command execution, so we're adding UI shortcuts rather than building new command infrastructure.
- **Source**: recommended-accepted

## D10: What does "done" look like for this change - how will we know run/debug buttons are working?

- **Decision**: Done means: (1) Run button appears in editor tab bar next to file names, (2) Clicking primary action executes configured command in terminal pane (output visible), (3) Clicking dropdown shows all configured run commands from .project-settings.json, (4) Selecting alternative command from dropdown executes it and updates primary action for next time, (5) Run configuration is respected when defined in .project-settings.json, (6) When no run configuration exists, button is hidden or shows sensible default (no crash).
- **Why**: This covers the core user experience plus configuration handling. The definition is concrete and testable - we can verify each criterion with manual testing or automated tests.
- **Source**: recommended-accepted

## D11: What are the common run button usage patterns from other IDEs?

- **Decision**: VS Code uses split button in editor title bar with dropdown, remembers last-used action as default, shows tooltip indicating what it will run, extensions contribute run configurations. JetBrains uses run/debug configurations (named sets of startup properties), temporary vs permanent configurations, run widget on toolbar with configuration selector, auto-creates configurations from context.
- **Why**: These patterns represent industry-standard UX for run buttons. VS Code's split button approach is particularly relevant for Floo's simpler command execution model. JetBrains' configuration concept maps well to Floo's .project-settings.json approach.
- **Source**: web research (VS Code GitHub issues, JetBrains documentation)

## D12: What should happen when no run configuration exists in .project-settings.json?

- **Decision**: Show run button, and when clicked, work with the user to create a simple "run current file" configuration rather than hiding the button
- **Why**: Hiding the button makes the feature undiscoverable. Showing it and helping users create their first configuration provides better onboarding and makes the feature's existence clear. This follows JetBrains' pattern of auto-creating configurations from context.
- **Source**: user feedback, web research (JetBrains auto-creation patterns)

## D13: What are the key integration points for run/debug buttons in the existing codebase?

- **Decision**: Main integration points: (1) TabBar.tsx - add run button (split button with dropdown) next to file name, (2) src-tauri/src/settings.rs - add run field to ProjectSettings struct, (3) src-tauri/src/terminal.rs - add IPC command to write commands to the PTY, (4) src-tauri/src/lib.rs - register terminal IPC command, (5) src/api.ts - add TypeScript wrapper for terminal write command
- **Why**: This follows Floo's existing pattern and minimizes the files touched. The terminal already has PTY write functionality, so we're adding IPC access rather than building new infrastructure.
- **Source**: codebase analysis, recommended-accepted

## D14: What's the riskiest part of this change that we should tackle first?

- **Decision**: Riskiest part is TabBar.tsx UI integration because it involves adding a split button component with careful Mantine component usage, integration with existing tab state and file context, dynamic dropdown population from configuration, and the "no config" onboarding flow which requires good UX design
- **Why**: UI bugs are often harder to debug than backend logic, and getting the button placement and interaction right is critical for user acceptance. The terminal and settings parts are straightforward data structure additions, but the UI integration requires careful component composition and state management.
- **Source**: recommended-accepted
