import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import AccountPreview from "../AccountPreview";

it("walks through sign-in, recoverable import, expiry, and safe account switching without leaking profile state", async () => {
  render(
    <MantineProvider>
      <AccountPreview />
    </MantineProvider>
  );
  expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish signing in in your browser"
  );
  fireEvent.click(screen.getByRole("button", { name: "Simulate failure" }));
  expect(screen.getByText("Sign-in didn’t finish")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Try sign-in again" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Simulate successful sign-in" })
  );
  fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
  expect(
    screen.getByText("No projects yet. Your new workspace is ready.")
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Import existing workspace" })
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Import into this profile" })
  );
  expect(screen.getByText("Palisade Code")).toBeVisible();
  expect(screen.getByRole("group", { name: "Appearance" })).toBeVisible();
  expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  fireEvent.click(
    screen.getByRole("switch", { name: "Simulate offline connection" })
  );
  expect(screen.getByText("You can keep working offline")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Expired session" }));
  fireEvent.click(screen.getByRole("button", { name: "Save current work" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "No real files were written"
  );
  fireEvent.click(screen.getByRole("button", { name: "Verify in browser" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Simulate successful sign-in" })
  );
  fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
  expect(
    await screen.findByRole("button", { name: "Restart & switch" })
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Cancel account switch" })
  ).toBeInTheDocument();
  expect(document.querySelector(".account-preview-body")).toHaveAttribute(
    "inert"
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("alex@example.com")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
  fireEvent.click(screen.getByRole("button", { name: "Save all" }));
  expect(
    await screen.findByRole("button", { name: "Restart & switch" })
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Stop agent safely" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Restart & switch" })
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue in browser" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Simulate successful sign-in" })
  );
  expect(screen.getByText("jamie@example.com")).toBeVisible();
  expect(screen.getByText("Studio website")).toBeVisible();
  expect(screen.queryByText("Palisade Code")).not.toBeInTheDocument();
});
