import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

// Proves the dashboard test harness: jsdom, React, Testing Library, jest-dom.
describe("dashboard test harness", () => {
  it("renders React into jsdom with jest-dom matchers", () => {
    render(<button disabled>Sign in</button>);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("starts each test with empty localStorage", () => {
    expect(window.localStorage.getItem("emptrack_token")).toBeNull();
  });
});
