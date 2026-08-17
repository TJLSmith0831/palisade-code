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
  graphify: true,
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
  onSelectProject: vi.fn(),
};

describe("OnboardingScreen model picker", () => {
  it("labels the pill with the agent's own selected model, not 'default'", () => {
    render(<OnboardingScreen {...base} />);
    expect(screen.getByTestId("onboarding-model-pill").textContent).toContain(
      "Model 3"
    );
  });

  it("prefers the user's explicit pick over the agent's selection", () => {
    render(<OnboardingScreen {...base} model="m-9" />);
    expect(screen.getByTestId("onboarding-model-pill").textContent).toContain(
      "Model 9"
    );
  });

  it("filters a long model list by the search box", async () => {
    render(<OnboardingScreen {...base} />);
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

  it("says so when the search matches nothing", async () => {
    render(<OnboardingScreen {...base} />);
    fireEvent.click(screen.getByTestId("onboarding-model-pill"));
    fireEvent.change(await screen.findByTestId("onboarding-model-search"), {
      target: { value: "zzzz" },
    });
    expect(screen.queryAllByTestId(/^onboarding-model-opt-/)).toHaveLength(0);
    expect(screen.getByTestId("onboarding-models-no-matches")).toBeDefined();
  });

  it("clears the query when the menu is reopened", async () => {
    render(<OnboardingScreen {...base} />);
    fireEvent.click(screen.getByTestId("onboarding-model-pill"));
    fireEvent.change(await screen.findByTestId("onboarding-model-search"), {
      target: { value: "swe" },
    });
    fireEvent.click(screen.getByTestId("onboarding-model-pill"));
    fireEvent.click(screen.getByTestId("onboarding-model-pill"));
    expect(await screen.findByTestId("onboarding-model-search")).toHaveValue(
      ""
    );
  });
});

describe("OnboardingScreen recent projects", () => {
  const projects = [
    { hash: "h1", displayName: "palisade-code", root: "/w/palisade" },
    { hash: "h2", displayName: "other", root: "/w/other" },
  ] as unknown as Project[];

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
