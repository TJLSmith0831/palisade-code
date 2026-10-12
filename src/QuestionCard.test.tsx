import "@testing-library/jest-dom/vitest";
import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { QuestionCard } from "./QuestionCard";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
const event = { id: "question-1", sessionId: "owning-session", message: "Choose a behavior", fields: [{ id: "scroll", title: "Scroll to results?", description: null, options: [{ value: "yes", label: "Yes", description: "Show results immediately" }, { value: "no", label: "No", description: null }], required: true, secret: false }] };
beforeEach(() => { invoke.mockReset(); });
it("requires an answer and routes it to the owning session", async () => {
  invoke.mockResolvedValue(undefined);
  render(<MantineProvider><QuestionCard event={event} resolved={false} /></MantineProvider>);
  expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
  expect(screen.getByText("Show results immediately")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("answer_question_prompt", { sessionId: "owning-session", requestId: "question-1", answers: { scroll: "yes" } }));
  expect(await screen.findByText("Answer sent")).toBeInTheDocument();
});
it("keeps failed submissions available for retry", async () => {
  invoke.mockRejectedValue("Session is still busy");
  render(<MantineProvider><QuestionCard event={event} resolved={false} /></MantineProvider>);
  fireEvent.click(screen.getByRole("radio", { name: "No" }));
  fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Session is still busy");
  expect(screen.getByRole("radio", { name: "No" })).toBeChecked();
});
it("closes without retaining the instruction to answer", () => {
  render(<MantineProvider><QuestionCard event={event} resolved={true} /></MantineProvider>);
  expect(screen.getByText("Question closed")).toBeInTheDocument();
  expect(screen.queryByText("Choose a behavior")).not.toBeInTheDocument();
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
});
it("moves selection and focus between option rows with the keyboard", () => {
  render(<MantineProvider><QuestionCard event={event} resolved={false} /></MantineProvider>);
  const yes = screen.getByRole("radio", { name: "Yes" });
  fireEvent.click(yes);
  yes.focus();
  fireEvent.keyDown(yes, { key: "ArrowDown", code: "ArrowDown" });
  expect(screen.getByRole("radio", { name: "No" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "No" })).toHaveFocus();
});
