import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";

import { saveAgentSettings } from "../agent/actions";
import { AgentSection, type AgentSettings } from "./agent-section";

vi.mock("../agent/actions", () => ({ saveAgentSettings: vi.fn(async () => ({ ok: true, data: null })) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean; error?: string }) => (result.ok ? result : (toast(result.error!), result)) }));

const initial: AgentSettings = {
  enabled: false,
  query: { keywords: "Data scientist", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" },
  hour: 7,
  minScore: 70,
  maxScores: 15,
  maxDrafts: 3,
  autoDraft: false,
};
const countries = [
  { code: "de", name: "Germany" },
  { code: "nl", name: "Netherlands" },
];
const open = (props: Partial<Parameters<typeof AgentSection>[0]> = {}) =>
  render(<AgentSection initial={initial} source="JSEARCH" aiReady countries={countries} timeZone="Europe/Berlin" {...props} />);

beforeEach(() => vi.clearAllMocks());

describe("Settings → Job agent (E16-7)", () => {
  it("is off until it's turned on, and turns on with the search, saved with it", async () => {
    const user = userEvent.setup();
    open();
    const toggle = screen.getByRole("switch", { name: "Run the job agent" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription("Off. Nothing is searched or scored until it's on.");
    await user.click(toggle);
    expect(saveAgentSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, query: initial.query, queries: [initial.query], intervalHours: 3 }));
    expect(toggle).toHaveAccessibleDescription(/^On\. It checks your saved searches every 3 hours\./);
  });

  it("needs keywords and a country to turn on", async () => {
    const user = userEvent.setup();
    const query = { ...initial.query, keywords: "", country: "" };
    open({ initial: { ...initial, query, queries: [query] } });
    await user.click(screen.getByRole("switch", { name: "Run the job agent" }));
    expect(saveAgentSettings).not.toHaveBeenCalled();
    expect(screen.getByLabelText("What")).toHaveAccessibleDescription("Type what the agent should look for.");
    expect(screen.getByLabelText("Country")).toHaveAccessibleDescription("Choose a country.");
    expect(screen.getByRole("switch", { name: "Run the job agent" })).toHaveAttribute("aria-checked", "false");
  });

  it("saves the search once typing pauses, and the other choices at once", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("What"), " NLP");
    const query = { ...initial.query, keywords: "Data scientist NLP" };
    await waitFor(() => expect(saveAgentSettings).toHaveBeenLastCalledWith({ queries: [query], query }), { timeout: 2000 });
    expect(screen.queryByLabelText("Runs after")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Check for new jobs"), "Every day");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ intervalHours: 24 });
    await user.selectOptions(screen.getByLabelText("Runs after"), "09:00");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ hour: 9 });
    await user.selectOptions(screen.getByLabelText("Minimum score"), "80 of 100");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ minScore: 80 });
    await user.selectOptions(screen.getByLabelText("Postings checked per run"), "20");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ maxScores: 20 });
  });

  it("prepares no drafts on its own unless asked, and then up to the cap", async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByLabelText("Drafts per run, at most")).toBeDisabled();
    const toggle = screen.getByRole("switch", { name: "Prepare drafts on its own" });
    expect(toggle).toHaveAccessibleDescription("Off. You choose which postings get a draft with Prepare draft.");
    await user.click(toggle);
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ autoDraft: true });
    await user.selectOptions(screen.getByLabelText("Drafts per run, at most"), "5");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ maxDrafts: 5 });
    expect(toggle).toHaveAccessibleDescription(/up to 5 drafts/);
  });

  it("explains the limits in plain words", () => {
    open();
    expect(screen.getByText(/^Each run searches up to 1 result page across 1 search and checks up to 15 postings\./)).toHaveTextContent("at most 12 runs in 24 hours, including manual runs");
  });

  it("seeds the requested roles only when no previous search exists, without turning on", () => {
    open({ initial: { ...initial, query: { ...initial.query, keywords: "" }, queries: [] } });
    expect(screen.getAllByLabelText("What").map((input) => (input as HTMLInputElement).value)).toEqual(["Head of IT", "TechOps Lead", "IT Manager"]);
    expect(screen.getAllByLabelText("Where").every((input) => (input as HTMLInputElement).value === "Berlin")).toBe(true);
    expect(screen.getByRole("switch", { name: "Run the job agent" })).toHaveAttribute("aria-checked", "false");
    expect(saveAgentSettings).not.toHaveBeenCalled();
  });

  it("edits and removes independent targets and validates every search", async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("button", { name: "Add another search" }));
    const second = screen.getByRole("group", { name: "Search 2" });
    await user.click(screen.getByRole("switch", { name: "Run the job agent" }));
    expect(within(second).getByLabelText("What")).toHaveAccessibleDescription("Type what the agent should look for.");
    expect(screen.getByRole("switch", { name: "Run the job agent" })).toHaveAttribute("aria-checked", "false");
    await user.type(within(second).getByLabelText("What"), "IT Manager");
    await user.click(screen.getByRole("switch", { name: "Run the job agent" }));
    expect(saveAgentSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, queries: [initial.query, { ...initial.query, keywords: "IT Manager" }] }));
    await user.click(screen.getByRole("button", { name: "Remove search 1" }));
    expect(screen.getByLabelText("What")).toHaveValue("IT Manager");
    await waitFor(() => expect(saveAgentSettings).toHaveBeenLastCalledWith({ query: { ...initial.query, keywords: "IT Manager" }, queries: [{ ...initial.query, keywords: "IT Manager" }] }));
  });

  it("limits the watch to ten searches", () => {
    open({ initial: { ...initial, queries: Array.from({ length: 10 }, (_, i) => ({ ...initial.query, keywords: `Role ${i + 1}` })) } });
    expect(screen.getByRole("button", { name: "Add another search" })).toBeDisabled();
    expect(screen.getAllByRole("group")).toHaveLength(10);
  });

  it("defaults to English ads, English or Italian requirements and consultancy exclusions", async () => {
    const user = userEvent.setup();
    open();
    expect(screen.getByRole("switch", { name: "Only postings written in English" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Allowed required languages")).toHaveValue("English, Italian");
    expect(screen.getByRole("switch", { name: "Exclude consultancy groups" })).toHaveAttribute("aria-checked", "true");
    expect((screen.getByLabelText("Excluded companies") as HTMLTextAreaElement).value).toContain("KPMG\nDeloitte");
    await user.click(screen.getByRole("switch", { name: "Exclude consultancy groups" }));
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ exclusions: expect.objectContaining({ englishOnly: true, allowedLanguages: ["English", "Italian"], excludeConsultancies: false, companies: expect.arrayContaining(["KPMG", "Deloitte"]) }) });
    await user.clear(screen.getByLabelText("Excluded companies"));
    await user.type(screen.getByLabelText("Excluded companies"), "KPMG\nDeloitte, Example Group");
    await user.tab();
    await waitFor(() => expect(saveAgentSettings).toHaveBeenLastCalledWith({ exclusions: expect.objectContaining({ companies: ["KPMG", "Deloitte", "Example Group"], excludeConsultancies: false }) }));
  });

  it("lets the user choose their profile, uploaded CV or Dossier base CV", async () => {
    const user = userEvent.setup();
    open({ uploadedCvName: "my-cv.pdf" });
    expect(screen.getByLabelText("Use as my CV")).toHaveValue("profile");
    await user.selectOptions(screen.getByLabelText("Use as my CV"), "generated");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ cvSource: "generated" });
    expect(screen.getByRole("link", { name: "Base resume" })).toHaveAttribute("href", "/resume");
    await user.selectOptions(screen.getByLabelText("Use as my CV"), "uploaded");
    expect(saveAgentSettings).toHaveBeenLastCalledWith({ cvSource: "uploaded" });
    expect(screen.getByText("Stored CV: my-cv.pdf")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save uploaded CV" })).toBeDisabled();
  });

  it("points to the source or AI provider while one isn't set up", () => {
    const { unmount } = open({ source: null });
    expect(screen.getByRole("note")).toHaveTextContent("The agent searches the source you choose in Settings → Job search, which is off. Choose one first.");
    expect(screen.getByRole("link", { name: "Settings → Job search" })).toHaveAttribute("href", "/settings?section=jobs");
    unmount();
    open({ aiReady: false });
    expect(screen.getByRole("link", { name: "Settings → AI provider" })).toHaveAttribute("href", "/settings?section=ai");
  });

  it("switches back and says why when a change isn't saved", async () => {
    const user = userEvent.setup();
    vi.mocked(saveAgentSettings).mockResolvedValueOnce({ ok: false, error: "Type what the agent should look for before turning it on." });
    open();
    await user.click(screen.getByRole("switch", { name: "Run the job agent" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Run the job agent" })).toHaveAttribute("aria-checked", "false"));
    expect(toast).toHaveBeenCalledWith("Type what the agent should look for before turning it on.");
  });
});
