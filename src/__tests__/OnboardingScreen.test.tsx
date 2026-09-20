import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import OnboardingScreen from "../OnboardingScreen";
import type { ModelState, Preflight, Project } from "../api";

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

const flight = {
  agents: [
    { id: "claude", name: "Claude Agent" },
    { id: "devin", name: "Devin" },
  ],
  selected: "claude",
  openspec: true,
  grillApply: true,
  ponytail: true,
  ready: true,
  warnings: [],
  checkedAt: "2026-08-06T00:00:00Z",
} as unknown as Preflight;

// A provider with a long catalogue — the case that makes an unfiltered,
// uncapped dropdown unusable.
const manyModels: ModelState = {
  models: Array.from({ length: 60 }, (_, i) => ({
    id: `m-${i}`,
    name: i === 7 ? "SWE-1.7 Max" : `Model ${i}`,
  })),
  current: "m-3",
  configId: null,
} as unknown as ModelState;

const base = {
  projects: [] as Project[],
  flight,
  executor: null,
  model: null,
  models: manyModels,
  onPickExecutor: vi.fn(),
  onPickModel: vi.fn(),
  onOpenProject: vi.fn(),
  onCloneRepository: vi.fn(),
  onComposerSend: vi.fn(),
  onSelectProject: vi.fn(),
};

// Amendment 9 (shape brief, 2026-08-24): project creation is the primary
// action; the composer (with its executor/model pickers) is secondary and
// collapsed until asked for.
describe("OnboardingScreen project-first layout", () => {
  it("leads with New Project as the primary tile", () => {
    render(<OnboardingScreen {...base} />);
    const tile = screen.getByTestId("add-project");
    expect(tile).toHaveTextContent("New Project");
    expect(tile.className).toContain("primary");
  });

  it("keeps the composer collapsed behind a quiet toggle until asked for", () => {
    render(<OnboardingScreen {...base} />);
    expect(screen.queryByTestId("onboarding-composer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("onboarding-agent-pill")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("onboarding-composer-toggle"));
    expect(screen.getByTestId("onboarding-composer")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-agent-pill")).toBeInTheDocument();
  });

  it("sends the typed request through onComposerSend, not onOpenProject", () => {
    const onComposerSend = vi.fn();
    render(<OnboardingScreen {...base} onComposerSend={onComposerSend} />);
    fireEvent.click(screen.getByTestId("onboarding-composer-toggle"));
    fireEvent.change(screen.getByTestId("onboarding-composer"), {
      target: { value: "Add dark mode toggle" },
    });
    fireEvent.click(screen.getByTestId("onboarding-send"));
    expect(onComposerSend).toHaveBeenCalledWith("Add dark mode toggle");
    expect(base.onOpenProject).not.toHaveBeenCalled();
  });

  it("gives the missing-agent state a distinct, warn-toned status pill", () => {
    render(
      <OnboardingScreen
        {...base}
        flight={{ ...flight, selected: null } as unknown as Preflight}
      />,
    );
    const status = screen.getByTestId("onboarding-status");
    expect(status.className).toContain("bad");
    expect(status).toHaveTextContent(/No coding agent found/i);
  });

  it("shows a checking state instead of a false 'no agent found' while preflight is still in flight", () => {
    render(<OnboardingScreen {...base} flight={null} />);
    const status = screen.getByTestId("onboarding-status");
    expect(status.className).toContain("loading");
    expect(status.className).not.toContain("bad");
    expect(status).toHaveTextContent(/Checking for installed agents/i);
    expect(status).not.toHaveTextContent(/No coding agent found/i);
  });
});

// The chip only reports whether an agent binary was found on PATH — it used
// to say "Detected: Claude Agent" even when that agent's own login had
// expired, which read as an all-clear right up until a session failed to
// start. It's now a dropdown listing every installed agent's own probed
// status, with a retry action wherever that status looks like an expired
// login, so a user can tell "installed" from "actually usable" at a glance.
describe("OnboardingScreen detection chip dropdown", () => {
  it("opens a dropdown listing every installed agent, marking the default one", async () => {
    render(<OnboardingScreen {...base} />);
    fireEvent.click(screen.getByTestId("onboarding-status"));
    expect(await screen.findByTestId("onboarding-status-menu")).toBeDefined();
    expect(
      screen.getByTestId("onboarding-agent-status-claude"),
    ).toHaveTextContent("Claude Agentdefault");
    expect(
      screen.getByTestId("onboarding-agent-status-devin"),
    ).toHaveTextContent("Devin");
  });

  // Checking an agent means spawning its own CLI, and that spawn is not
  // always read-only — probing an unauthenticated Devin CLI kicked off its
  // own reauth flow as a side effect of merely opening this dropdown to
  // look. Nothing gets checked without an explicit click on that row.
  it("never probes any agent on mount or on opening the dropdown", () => {
    const onProbeAgent = vi.fn();
    render(<OnboardingScreen {...base} onProbeAgent={onProbeAgent} />);
    expect(onProbeAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("onboarding-status"));
    expect(onProbeAgent).not.toHaveBeenCalled();
  });

  it("shows an unchecked agent with an explicit Check status action, not an auto-run probe", async () => {
    const onProbeAgent = vi.fn();
    render(<OnboardingScreen {...base} onProbeAgent={onProbeAgent} />);
    fireEvent.click(screen.getByTestId("onboarding-status"));

    const claudeRow = await screen.findByTestId(
      "onboarding-agent-status-claude",
    );
    expect(claudeRow.className).toContain("status-unknown");
    fireEvent.click(screen.getByTestId("onboarding-check-claude"));
    expect(onProbeAgent).toHaveBeenCalledTimes(1);
    expect(onProbeAgent).toHaveBeenCalledWith("claude");
    // Only the row that was actually clicked — not every installed agent.
    expect(onProbeAgent).not.toHaveBeenCalledWith("devin");
  });

  it("shows a per-agent auth error as a reauth row, distinct from a generic issue", async () => {
    render(
      <OnboardingScreen
        {...base}
        agentModels={{
          claude: { error: "Couldn't complete that — please log in again" },
          devin: { error: "agent has no path" },
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("onboarding-status"));

    const claudeRow = await screen.findByTestId(
      "onboarding-agent-status-claude",
    );
    expect(claudeRow.className).toContain("status-reauth");
    // The failure text used to live only in a `title` tooltip — invisible on
    // touch and to a screen reader. It's shown outright now.
    expect(claudeRow).toHaveTextContent(
      "Couldn't complete that — please log in again",
    );
    expect(screen.getByTestId("onboarding-reauth-claude")).toHaveTextContent(
      "Reauthenticate",
    );

    const devinRow = screen.getByTestId("onboarding-agent-status-devin");
    expect(devinRow.className).toContain("status-error");
    expect(devinRow).toHaveTextContent("Issue");
    expect(devinRow).toHaveTextContent("agent has no path");
    // A non-auth issue gets a plain retry, not the reauth-specific action.
    expect(
      screen.queryByTestId("onboarding-reauth-devin"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("onboarding-retry-devin")).toHaveTextContent(
      "Retry",
    );
  });

  it("clicking Retry on a non-auth issue re-probes that agent", async () => {
    const onProbeAgent = vi.fn();
    render(
      <OnboardingScreen
        {...base}
        onProbeAgent={onProbeAgent}
        agentModels={{ devin: { error: "agent has no path" } }}
      />,
    );
    fireEvent.click(screen.getByTestId("onboarding-status"));
    fireEvent.click(await screen.findByTestId("onboarding-retry-devin"));
    expect(onProbeAgent).toHaveBeenCalledWith("devin");
  });

  it("warn-tones the chip itself when the default agent needs reauth", () => {
    render(
      <OnboardingScreen
        {...base}
        agentModels={{ claude: { error: "session expired" } }}
      />,
    );
    expect(screen.getByTestId("onboarding-status").className).toContain(
      "bad",
    );
  });

  it("re-probes the agent when its row's Reauthenticate button is clicked", async () => {
    const onProbeAgent = vi.fn();
    render(
      <OnboardingScreen
        {...base}
        onProbeAgent={onProbeAgent}
        agentModels={{ claude: { error: "not authenticated" } }}
      />,
    );
    fireEvent.click(screen.getByTestId("onboarding-status"));
    onProbeAgent.mockClear();
    fireEvent.click(await screen.findByTestId("onboarding-reauth-claude"));
    expect(onProbeAgent).toHaveBeenCalledWith("claude");
  });
});

describe("OnboardingScreen composer picker", () => {
  it("labels the pill with the agent's own selected model, not 'default'", () => {
    render(<OnboardingScreen {...base} />);
    fireEvent.click(screen.getByTestId("onboarding-composer-toggle"));
    expect(screen.getByTestId("onboarding-model-pill").textContent).toContain(
      "Model 3"
    );
  });

  it("filters a long model list by the search box", async () => {
    render(<OnboardingScreen {...base} />);
    fireEvent.click(screen.getByTestId("onboarding-composer-toggle"));
    fireEvent.click(screen.getByTestId("onboarding-model-pill"));
    expect(
      (await screen.findAllByTestId(/^onboarding-model-opt-/)).length
    ).toBeGreaterThan(50);

    fireEvent.change(screen.getByTestId("onboarding-model-search"), {
      target: { value: "swe" },
    });
    const shown = screen.getAllByTestId(/^onboarding-model-opt-/);
    expect(shown).toHaveLength(1);
    expect(shown[0].textContent).toContain("SWE-1.7 Max");
  });
});

describe("OnboardingScreen recent projects", () => {
  const projects = [
    {
      hash: "h1",
      displayName: "palisade-code",
      root: "/w/palisade",
      lastAccessedAt: "2026-08-24T00:00:00Z",
    },
    {
      hash: "h2",
      displayName: "other",
      root: "/w/other",
      lastAccessedAt: "2026-08-23T00:00:00Z",
    },
  ] as unknown as Project[];

  it("greets a first-timer differently from a returning user", () => {
    const { rerender } = render(<OnboardingScreen {...base} />);
    expect(screen.getByText("Welcome to Palisade")).toBeInTheDocument();
    rerender(
      <MantineProvider>
        <OnboardingScreen {...base} projects={projects} />
      </MantineProvider>,
    );
    expect(screen.getByText("Welcome back")).toBeInTheDocument();
  });

  it("shows an empty-state line instead of an empty table on first run", () => {
    render(<OnboardingScreen {...base} />);
    expect(screen.getByText(/No projects yet/i)).toBeInTheDocument();
  });

  it("shows the row is opening rather than looking dead while the switch runs", () => {
    render(<OnboardingScreen {...base} projects={projects} openingHash="h1" />);
    const rows = screen.getAllByTestId("recent-project");
    expect(rows[0]).toHaveAttribute("aria-busy", "true");
    expect(rows[1]).not.toHaveAttribute("aria-busy", "true");
  });

  it("ignores a second click while one project is already opening", () => {
    const onSelectProject = vi.fn();
    render(
      <OnboardingScreen
        {...base}
        projects={projects}
        openingHash="h1"
        onSelectProject={onSelectProject}
      />,
    );
    fireEvent.click(screen.getAllByTestId("recent-project")[1]);
    expect(onSelectProject).not.toHaveBeenCalled();
  });
});

// Pre-release: no pitch copy, no "Local" execution-target tag (there is only
// one target), and no sign-in claim — account gating is coming, so promising
// its absence would become a lie the moment it ships. A plain greeting
// ("Welcome back" / "Welcome to Palisade") makes no such claim and is the
// headline DESIGN.md's reserved display step was waiting for.
describe("OnboardingScreen header and footer", () => {
  it("makes no pitch or billing claim", () => {
    render(<OnboardingScreen {...base} />);
    expect(
      screen.queryByText(/Drive your own coding agent/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/no bundled model, no per-usage billing/i),
    ).not.toBeInTheDocument();
  });

  it("drops the Local execution-target tag", () => {
    render(<OnboardingScreen {...base} />);
    expect(screen.queryByText("Local")).not.toBeInTheDocument();
  });

  it("makes no no-account claim", () => {
    render(<OnboardingScreen {...base} />);
    expect(screen.queryByText(/No account, no sign-in/i)).not.toBeInTheDocument();
  });
});
