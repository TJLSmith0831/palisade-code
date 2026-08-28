import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SessionsPanel from "../SessionsPanel";
import * as api from "../api";
import type { ThreadMeta } from "../api";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

vi.mock("../api", () => ({
  listSessions: vi.fn(),
  executorStatus: vi.fn(),
}));

const mocked = api as unknown as {
  listSessions: ReturnType<typeof vi.fn>;
  executorStatus: ReturnType<typeof vi.fn>;
};

const thread: ThreadMeta = {
  id: "t1",
  projectHash: "h",
  title: "Fix the parser",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  currentMode: "go",
  openSpecChangeName: null,
};

beforeEach(() => {
  mocked.listSessions.mockReset().mockResolvedValue([]);
  mocked.executorStatus.mockReset().mockResolvedValue([]);
});

describe("SessionsPanel", () => {
  it("lists a thread's sessions with busy/idle state and agent attribution", async () => {
    mocked.executorStatus.mockResolvedValue([
      { id: "s1", threadId: "t1", agentId: "claude-code", mode: "go", busy: true },
    ]);
    mocked.listSessions.mockResolvedValue([
      {
        id: "s1",
        threadId: "t1",
        projectHash: "h",
        agentId: "claude-code",
        mode: "go",
        providerHandle: "abc",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: null,
        outcome: null,
        gitHeadBefore: null,
        gitHeadAfter: null,
      },
    ]);

    render(<SessionsPanel projectHash="h" threads={[thread]} />);
    fireEvent.click(await screen.findByText("Fix the parser"));

    await waitFor(() => expect(screen.getByTestId("session-s1")).toBeTruthy());
    expect(screen.getByText(/claude-code/)).toBeTruthy();
    expect(screen.getByText(/busy/i)).toBeTruthy();
  });

  it("shows a session as idle when it is not in the live executor status", async () => {
    mocked.executorStatus.mockResolvedValue([]);
    mocked.listSessions.mockResolvedValue([
      {
        id: "s2",
        threadId: "t1",
        projectHash: "h",
        agentId: "codex",
        mode: "spec",
        providerHandle: null,
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:05:00Z",
        outcome: "done",
        gitHeadBefore: null,
        gitHeadAfter: null,
      },
    ]);

    render(<SessionsPanel projectHash="h" threads={[thread]} />);
    fireEvent.click(await screen.findByText("Fix the parser"));

    await waitFor(() => expect(screen.getByTestId("session-s2")).toBeTruthy());
    expect(screen.getByText(/codex/)).toBeTruthy();
    expect(screen.getByText(/done/i)).toBeTruthy();
  });
});
