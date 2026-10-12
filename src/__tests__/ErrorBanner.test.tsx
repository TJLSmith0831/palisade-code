import "@testing-library/jest-dom/vitest";
import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ErrorBanner from "../ErrorBanner";

it("summarizes a failed verification and preserves the readable full log", () => {
  const onDismiss = vi.fn();
  const message = "Couldn't complete that — Verification test failed.\n\u001b[31m> test\u001b[0m\n✖ failed check\nAssertionError: expected 1, received 0";
  render(<MantineProvider><ErrorBanner message={message} tone="error" onDismiss={onDismiss} /></MantineProvider>);
  expect(screen.getByRole("alert")).toHaveTextContent("Verification failed");
  expect(screen.getByText(/Fix the failing check/)).toBeInTheDocument();
  const details = screen.getByText("Details").closest("details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("pre")?.textContent).toContain("> test\n✖ failed check\nAssertionError");
  expect(details.querySelector("pre")?.textContent).not.toContain("\u001b");
  fireEvent.click(screen.getByText("Details"));
  expect(onDismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("keeps short warnings concise and uses a named close control", () => {
  render(<MantineProvider><ErrorBanner message="Another thread is running here." tone="warn" onDismiss={() => {}} /></MantineProvider>);
  expect(screen.getByRole("status")).toHaveTextContent("Another thread is running here.");
  expect(screen.queryByText("Details")).toBeNull();
  expect(screen.getByRole("button", { name: "Dismiss warning" })).toBeInTheDocument();
});

it("keeps a long single-line diagnostic reachable without a giant banner", () => {
  const message = "Long path: " + "segment/".repeat(60);
  render(<MantineProvider><ErrorBanner message={message} tone="error" onDismiss={() => {}} /></MantineProvider>);
  expect(screen.getByRole("alert").querySelector("p")?.textContent?.length).toBeLessThanOrEqual(221);
  expect(screen.getByLabelText("Diagnostic details").textContent).toBe(message);
});
