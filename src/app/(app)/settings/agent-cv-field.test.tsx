import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentCvField } from "./agent-cv-field";

vi.mock("@/components/toast", () => ({ toast: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe("Agent CV upload", () => {
  it("uploads a CV as form data, then removes its stored text", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn().mockResolvedValueOnce({ json: async () => ({ ok: true, name: "my-cv.txt" }) }).mockResolvedValueOnce({ json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    render(<AgentCvField initialName={null} />);
    expect(screen.getByRole("note")).toHaveTextContent("The agent needs it before it can run.");
    const file = new File(["My IT leadership experience"], "my-cv.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("Upload my CV"), file);
    await user.click(screen.getByRole("button", { name: "Save uploaded CV" }));
    await waitFor(() => expect(screen.getByText("Stored CV: my-cv.txt")).toBeInTheDocument());
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("/api/agent/cv");
    expect(options.method).toBe("POST");
    expect(options.body.get("file")).toBe(file);
    expect(screen.getByRole("button", { name: "Save uploaded CV" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove uploaded CV" }));
    await waitFor(() => expect(screen.getByRole("note")).toBeInTheDocument());
    expect(fetch).toHaveBeenLastCalledWith("/api/agent/cv", { method: "DELETE" });
  });

  it("keeps the previous CV when a replacement is rejected and explains the error", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ ok: false, error: "The CV is over 5 MB." }) }));
    render(<AgentCvField initialName="original.pdf" />);
    await user.upload(screen.getByLabelText("Replace my CV"), new File(["new"], "replacement.txt", { type: "text/plain" }));
    await user.click(screen.getByRole("button", { name: "Save uploaded CV" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The CV is over 5 MB."));
    expect(screen.getByText("Stored CV: original.pdf")).toBeInTheDocument();
    expect(screen.getByLabelText("Replace my CV")).toHaveAttribute("aria-invalid", "true");
  });

  it("recovers from a failed connection without losing the selected file", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<AgentCvField initialName={null} />);
    await user.upload(screen.getByLabelText("Upload my CV"), new File(["CV"], "my-cv.txt", { type: "text/plain" }));
    await user.click(screen.getByRole("button", { name: "Save uploaded CV" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't upload your CV. Try again."));
    expect(screen.getByRole("button", { name: "Save uploaded CV" })).toBeEnabled();
  });
});
