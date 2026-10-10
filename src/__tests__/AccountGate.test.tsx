import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { beforeEach, expect, test, vi } from "vitest";
import AccountGate from "../AccountGate";
import * as api from "../api";
vi.mock("../api", () => ({
  accountStatus: vi.fn(),
  accountRefresh: vi.fn(),
  accountBeginSignIn: vi.fn(),
  accountCancelSignIn: vi.fn(),
  accountPrepareWorkspace: vi.fn(),
  accountReopenSignIn: vi.fn(),
  accountOpenBrowserAccount: vi.fn(),
  accountRequestRestart: vi.fn(),
  accountStopWork: vi.fn(),
  accountCancelRestart: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../profileStorage", () => ({
  bindProfileStorage: vi.fn(),
  hasImportedPreferences: vi.fn(() => false),
}));
const signedOut: api.AccountStatus = {
  state: "signedOut",
  identity: null,
  profileKey: null,
  offlineUntil: null,
  message: null,
  workspaceReady: false,
  legacyAvailable: false,
};
const online: api.AccountStatus = {
  ...signedOut,
  state: "online",
  identity: {
    sub: "user_a",
    email: "test@example.com",
    name: "Test",
    picture: null,
  },
  profileKey: "a".repeat(64),
  offlineUntil: 2_000_000_000,
  workspaceReady: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.accountStatus).mockResolvedValue(signedOut);
  vi.mocked(api.accountRefresh).mockResolvedValue(online);
});
const mount = () =>
  render(
    <MantineProvider>
      <AccountGate>
        <input aria-label="Open editor buffer" defaultValue="unsaved work" />
      </AccountGate>
    </MantineProvider>
  );
test("workspace remains closed until native profile permission and binding are ready", async () => {
  mount();
  expect(await screen.findByText("Sign in to Palisade")).toBeInTheDocument();
  expect(screen.queryByLabelText("Open editor buffer")).toBeNull();
  vi.mocked(api.accountStatus).mockResolvedValue(online);
  vi.mocked(api.accountBeginSignIn).mockResolvedValue({
    identity: online.identity!,
    accessTokenExpiresIn: 86400,
    refreshTokenIssued: true,
  });
  fireEvent.click(screen.getByText("Continue in browser"));
  expect(await screen.findByLabelText("Open editor buffer")).toHaveValue(
    "unsaved work"
  );
});
test("expiry retains the existing buffer and same-account verification resumes it", async () => {
  vi.mocked(api.accountStatus).mockResolvedValue(online);
  mount();
  const buffer = await screen.findByLabelText("Open editor buffer");
  fireEvent.change(buffer, { target: { value: "still here" } });
  vi.mocked(api.accountRefresh).mockResolvedValue({
    ...online,
    state: "expired",
  });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(
    await screen.findByText("Account access needs attention")
  ).toBeInTheDocument();
  expect(buffer).toHaveValue("still here");
  expect(buffer.closest("[inert]")).not.toBeNull();
  vi.mocked(api.accountRefresh).mockResolvedValue(online);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() =>
    expect(screen.queryByText("Account access needs attention")).toBeNull()
  );
  expect(buffer).toHaveValue("still here");
});

test("browser account management opens separately and does not start desktop sign-in", async () => {
  vi.mocked(api.accountOpenBrowserAccount).mockResolvedValue(undefined);
  mount();
  fireEvent.click(await screen.findByText("Open browser account"));
  expect(api.accountOpenBrowserAccount).toHaveBeenCalledOnce();
  expect(api.accountBeginSignIn).not.toHaveBeenCalled();
});
