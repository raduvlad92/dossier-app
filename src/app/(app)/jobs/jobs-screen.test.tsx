import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import { EMPTY_QUERY, type PostingState, type ShownPosting, type StoredSearch } from "@/lib/job-search/search";

import {
  dismissFoundPosting,
  loadFullText,
  recheckJobSearch,
  removeJobSearch,
  restorePosting,
  runJobSearch,
  savePostingForLater,
  showMorePostings,
  startApplicationFrom,
  unsavePosting,
} from "./actions";
import { JobsScreen } from "./jobs-screen";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => null }));
vi.mock("next/link", () => ({ default: ({ href, ...props }: ComponentProps<"a">) => <a href={href} {...props} /> }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));
vi.mock("./actions", () => ({
  startApplicationFrom: vi.fn(),
  runJobSearch: vi.fn(),
  removeJobSearch: vi.fn(),
  showMorePostings: vi.fn(),
  recheckJobSearch: vi.fn(),
  loadFullText: vi.fn(),
  savePostingForLater: vi.fn(),
  unsavePosting: vi.fn(),
  dismissFoundPosting: vi.fn(),
  restorePosting: vi.fn(),
}));

const countries = [
  { code: "de", name: "Germany" },
  { code: "fr", name: "France" },
];
const query = { ...EMPTY_QUERY, keywords: "product designer", place: "Hamburg", country: "de" };
const state: PostingState = { postingId: null, saved: false, dismissed: false, applicationId: null, score: null };

const posting = (id: string, extra: Partial<ShownPosting> = {}): ShownPosting => ({
  source: "JSEARCH",
  externalId: id,
  title: `Designer ${id}`,
  company: `Company ${id}`,
  place: "Hamburg",
  remote: false,
  salary: "",
  postedAt: "2026-09-30T00:00:00.000Z",
  url: `https://jobs.example/${id}`,
  via: "LinkedIn",
  description: `The whole posting ${id}.`,
  complete: true,
  state,
  ...extra,
});

const stored = (postings: ShownPosting[], next: string | null = null): StoredSearch => ({ id: "run-1", source: "JSEARCH", query, ranAt: "today at 14:32", postings, next });
const recheckSuccess: Awaited<ReturnType<typeof recheckJobSearch>> = {
  ok: true,
  data: { ok: true, postings: [], next: null, filtering: { active: true, total: 0, eligible: 0, excluded: 0, unchecked: 0, reasons: [] } },
};

const screenProps: ComponentProps<typeof JobsScreen> = {
  source: "JSEARCH",
  countries,
  view: "search",
  query,
  search: null,
  counts: { searches: 0, saved: 0, dismissed: 0 },
  today: "2026-10-03T12:00:00.000Z",
};

function renderScreen(props: Partial<ComponentProps<typeof JobsScreen>> = {}) {
  return render(<JobsScreen {...screenProps} {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runJobSearch).mockResolvedValue({ ok: true, data: { ok: true, id: "run-2" } });
  vi.mocked(removeJobSearch).mockResolvedValue({ ok: true, data: null, toast: "Search removed." });
  vi.mocked(savePostingForLater).mockResolvedValue({ ok: true, data: { postingId: "p1" } });
  vi.mocked(unsavePosting).mockResolvedValue({ ok: true, data: null });
  vi.mocked(dismissFoundPosting).mockResolvedValue({ ok: true, data: { wasSaved: false } });
  vi.mocked(restorePosting).mockResolvedValue({ ok: true, data: null });
  vi.mocked(recheckJobSearch).mockResolvedValue(recheckSuccess);
});

describe("the search form", () => {
  it("points to Settings while job search is off", () => {
    renderScreen({ source: null });
    expect(screen.getByRole("heading", { name: "Choose where to search" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up job search" })).toHaveAttribute("href", "/settings?section=jobs");
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });

  it("starts from the search it's given, and says which source it searches", () => {
    renderScreen();
    expect(screen.getByText("Search JSearch for postings near you, then start an application from the one you like.")).toBeInTheDocument();
    const form = screen.getByRole("search", { name: "Search postings" });
    expect(within(form).getByLabelText("What")).toHaveValue("product designer");
    expect(within(form).getByLabelText("Where")).toHaveValue("Hamburg");
    expect(within(form).getByLabelText("Country")).toHaveValue("de");
    expect(within(form).getByLabelText("Within")).toHaveValue("25");
    expect(screen.getByText(/Search for a role, a skill or a company/)).toBeInTheDocument();
  });

  it("runs the search, which is kept, and opens it (E14-10)", async () => {
    renderScreen();
    await userEvent.selectOptions(screen.getByLabelText("Within"), "50");
    await userEvent.click(screen.getByLabelText("Remote only"));
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(runJobSearch).toHaveBeenCalledWith({ query: { ...query, radiusKm: 50, remoteOnly: true } });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/jobs?search=run-2", { scroll: false }));
  });

  it("shows what went wrong, with Try again when the source isn't answering", async () => {
    vi.mocked(runJobSearch).mockResolvedValue({ ok: true, data: { ok: false, problem: "unavailable", message: "JSearch isn't answering right now." } });
    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("JSearch isn't answering right now.");
    expect(router.push).not.toHaveBeenCalled();

    vi.mocked(runJobSearch).mockResolvedValue({ ok: true, data: { ok: true, id: "run-3" } });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/jobs?search=run-3", { scroll: false }));
    expect(runJobSearch).toHaveBeenCalledTimes(2);
  });

  it("toasts a failure of the action itself", async () => {
    vi.mocked(runJobSearch).mockResolvedValue({ ok: false, error: "Something went wrong on the server. Please try again." });
    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Something went wrong on the server. Please try again."));
  });

  it("says when the search in the URL is no longer kept", () => {
    renderScreen({ missingSearch: true });
    expect(screen.getByText("That search is no longer kept. Search again, or open one from Past searches.")).toBeInTheDocument();
  });

  it("asks for keywords and a country first", async () => {
    renderScreen({ query: EMPTY_QUERY });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByText("Type what you're looking for.")).toBeInTheDocument();
    expect(screen.getByText("Choose a country.")).toBeInTheDocument();
    expect(runJobSearch).not.toHaveBeenCalled();
    // Without a place, the radius has nothing to go by.
    expect(screen.getByLabelText("Within")).toBeDisabled();
  });

  it("says when the source doesn't cover the country", async () => {
    renderScreen({ source: "ARBEITSAGENTUR" });
    await userEvent.selectOptions(screen.getByLabelText("Country"), "fr");
    expect(screen.getByText("Bundesagentur für Arbeit doesn't list jobs in France.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(runJobSearch).not.toHaveBeenCalled();
  });

  it("warns that Adzuna can only add 'remote' to the words", async () => {
    renderScreen({ source: "ADZUNA" });
    await userEvent.click(screen.getByLabelText("Remote only"));
    expect(screen.getByText("Adzuna has no remote filter, so this adds “remote” to your search.")).toBeInTheDocument();
  });

  it("follows the URL's search on Back and forward", () => {
    const { rerender } = renderScreen();
    rerender(<JobsScreen {...screenProps} query={{ ...query, keywords: "nurse" }} />);
    expect(screen.getByLabelText("What")).toHaveValue("nurse");
  });

  it("shows the current manual and scheduled search rules independently of the schedule", () => {
    renderScreen({ filterRules: ["English-only postings", "Required languages limited to English or Italian", "No consultancy groups"] });
    expect(screen.getByText(/Your current rules apply to Find jobs searches and the Job agent/)).toHaveTextContent("even when its schedule is off");
    expect(screen.getByText(/English-only postings · Required languages limited to English or Italian · No consultancy groups/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change search rules" })).toHaveAttribute("href", "/settings?section=agent");
  });

  it("announces a pending search and safely handles a lost action response", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(runJobSearch).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("search")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Searching…" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => reject(new Error("private network detail")));
    expect(screen.getByRole("alert")).toHaveTextContent("The search couldn't be completed. Try again.");
    expect(screen.queryByText("private network detail")).not.toBeInTheDocument();
  });
});

describe("current-rule filtering", () => {
  const filtered = (overrides: Partial<NonNullable<StoredSearch["filtering"]>> = {}): NonNullable<StoredSearch["filtering"]> => ({
    active: true, total: 5, eligible: 0, excluded: 3, unchecked: 2, reasons: [], ...overrides,
  });
  const filteredSearch = (overrides: Partial<StoredSearch> = {}): StoredSearch => ({ ...stored([], "cursor:2"), filtering: filtered(), ...overrides });

  it("keeps Show more when every source result was excluded, and replaces cumulative counts", async () => {
    vi.mocked(showMorePostings).mockResolvedValueOnce({ ok: true, data: { ok: true, postings: [], next: "cursor:3", filtering: filtered({ total: 8, excluded: 8, unchecked: 0 }) } });
    renderScreen({ search: filteredSearch({ filtering: filtered({ excluded: 5, unchecked: 0 }) }) });
    expect(screen.getByText(/No results match your current rules/)).toBeInTheDocument();
    expect(screen.queryByText(/^No postings for/)).not.toBeInTheDocument();
    expect(screen.getByText("0 eligible postings of 5 source results from JSearch, more to come · searched today at 14:32")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recheck saved results" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
    expect(screen.getByText("0 eligible · 8 excluded · 0 unchecked · 8 source results")).toBeInTheDocument();
    expect(screen.queryByText(/13 source results/)).not.toBeInTheDocument();
  });

  it("distinguishes unchecked descriptions from excluded results without checking on mount", () => {
    renderScreen({ search: filteredSearch({ filtering: filtered({ reasons: [{ reason: "The description is not in English.", count: 3 }] }) }) });
    expect(screen.getByText("0 eligible · 3 excluded · 2 unchecked · 5 source results")).toBeInTheDocument();
    expect(screen.getByText(/Unchecked results stay hidden until they are verified/)).toBeInTheDocument();
    expect(screen.getByText(/This does not run a new search of job sources/)).toHaveTextContent("your AI provider");
    expect(screen.getByText("The description is not in English. (3)")).toBeInTheDocument();
    expect(recheckJobSearch).not.toHaveBeenCalled();
    expect(runJobSearch).not.toHaveBeenCalled();
    expect(showMorePostings).not.toHaveBeenCalled();
  });

  it("uses source totals separately from the displayed eligible list", () => {
    renderScreen({ search: filteredSearch({ postings: [posting("a")], next: null, filtering: filtered({ eligible: 1, excluded: 2 }) }) });
    expect(screen.getByText("1 eligible posting of 5 source results from JSearch · searched today at 14:32")).toBeInTheDocument();
    expect(screen.getByText("1 eligible · 2 excluded · 2 unchecked · 5 source results")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Postings" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("keeps the genuine no-source-results message for an empty source response", () => {
    renderScreen({ search: filteredSearch({ next: null, filtering: filtered({ total: 0, excluded: 0, unchecked: 0 }) }) });
    expect(screen.getByText(/^No postings for/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recheck saved results" })).not.toBeInTheDocument();
  });

  it("explicitly rechecks once, announces pending work and refreshes only after success", async () => {
    let finish!: (result: Awaited<ReturnType<typeof recheckJobSearch>>) => void;
    vi.mocked(recheckJobSearch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderScreen({ search: filteredSearch() });
    await userEvent.click(screen.getByRole("button", { name: "Recheck saved results" }));
    const pending = screen.getByRole("button", { name: "Rechecking saved results…" });
    expect(pending).toBeDisabled();
    expect(pending.closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("status").some((status) => status.textContent === "Rechecking saved results…")).toBe(true);
    expect(screen.getByRole("button", { name: "Show more" })).toBeDisabled();
    await userEvent.click(pending);
    expect(recheckJobSearch).toHaveBeenCalledTimes(1);
    expect(recheckJobSearch).toHaveBeenCalledWith({ searchId: "run-1" });
    expect(router.refresh).not.toHaveBeenCalled();
    await act(async () => finish(recheckSuccess));
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(runJobSearch).not.toHaveBeenCalled();
    expect(showMorePostings).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false as const, error: "Choose an AI provider first." },
    { ok: true as const, data: { ok: false as const, problem: "unavailable" as const, message: "The saved results could not be checked." } },
  ])("shows a recheck failure and keeps retry available: $ok", async (result) => {
    vi.mocked(recheckJobSearch).mockResolvedValueOnce(result);
    renderScreen({ search: filteredSearch() });
    await userEvent.click(screen.getByRole("button", { name: "Recheck saved results" }));
    expect(screen.getByRole("alert")).toHaveTextContent(result.ok ? result.data.message : result.error);
    expect(screen.getByRole("button", { name: "Recheck saved results" })).toBeEnabled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("recovers safely when recheck rejects without exposing error details", async () => {
    vi.mocked(recheckJobSearch).mockRejectedValueOnce(new Error("private provider detail"));
    renderScreen({ search: filteredSearch() });
    await userEvent.click(screen.getByRole("button", { name: "Recheck saved results" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Saved results couldn't be rechecked. Try again.");
    expect(screen.queryByText("private provider detail")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Recheck saved results" }));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("immediately replaces stale rows, detail and cursor when the same search refreshes", () => {
    const { rerender } = renderScreen({ search: stored([posting("german")], "cursor:2") });
    expect(screen.getByRole("heading", { name: "Designer german" })).toBeInTheDocument();
    rerender(<JobsScreen {...screenProps} search={filteredSearch({ next: null })} />);
    expect(screen.queryByRole("list", { name: "Postings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Designer german" })).not.toBeInTheDocument();
    expect(screen.queryByText("The whole posting german.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    expect(screen.getByText("0 eligible · 3 excluded · 2 unchecked · 5 source results")).toBeInTheDocument();
  });

  it("does not restore old rows when an old page request finishes after refreshed props", async () => {
    let finish!: (result: Awaited<ReturnType<typeof showMorePostings>>) => void;
    vi.mocked(showMorePostings).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = renderScreen({ search: stored([posting("german")], "cursor:2") });
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Loading more…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Loading more…" }).closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    rerender(<JobsScreen {...screenProps} search={filteredSearch({ next: null })} />);
    await act(async () => finish({ ok: true, data: { ok: true, postings: [posting("old-page")], next: null } }));
    expect(screen.queryByRole("list", { name: "Postings" })).not.toBeInTheDocument();
    expect(screen.queryByText("The whole posting old-page.")).not.toBeInTheDocument();
  });

  it("removes a previously shown German posting when Show more returns only current English results", async () => {
    vi.mocked(showMorePostings).mockResolvedValueOnce({ ok: true, data: {
      ok: true,
      postings: [posting("english")],
      next: "cursor:3",
      filtering: filtered({ total: 2, eligible: 1, excluded: 1, unchecked: 0 }),
    } });
    renderScreen({ search: stored([posting("german")], "cursor:2") });
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.queryByRole("button", { name: /^Designer german/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Designer german" })).not.toBeInTheDocument();
    expect(screen.queryByText("The whole posting german.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Designer english" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Postings" })).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("1 eligible · 1 excluded · 0 unchecked · 2 source results")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show more" })).toBeEnabled();
  });

  it("updates a retained posting's detail from the complete Show more snapshot", async () => {
    vi.mocked(showMorePostings).mockResolvedValueOnce({ ok: true, data: { ok: true, postings: [posting("a", { description: "New verified description." })], next: null } });
    renderScreen({ search: stored([posting("a")], "cursor:2") });
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("New verified description.")).toBeInTheDocument();
    expect(screen.queryByText("The whole posting a.")).not.toBeInTheDocument();
  });

  it("updates a retained posting's description on same-search refresh and Back", () => {
    const initial = stored([posting("a")]);
    const { rerender } = renderScreen({ search: initial });
    rerender(<JobsScreen {...screenProps} search={stored([posting("a", { description: "New verified description." })])} />);
    expect(screen.getByText("New verified description.")).toBeInTheDocument();
    expect(screen.queryByText("The whole posting a.")).not.toBeInTheDocument();
    rerender(<JobsScreen {...screenProps} search={initial} />);
    expect(screen.getByText("The whole posting a.")).toBeInTheDocument();
  });

  it("safely recovers from a pagination network error", async () => {
    vi.mocked(showMorePostings).mockRejectedValueOnce(new Error("private source detail"));
    renderScreen({ search: filteredSearch() });
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("alert")).toHaveTextContent("More results couldn't be loaded. Try again.");
    expect(screen.getByRole("button", { name: "Show more" })).toBeEnabled();
    expect(screen.queryByText("private source detail")).not.toBeInTheDocument();
  });

  it.each(["saved", "dismissed"] as const)("keeps %s postings as history and explains current action rules", (view) => {
    renderScreen({ view, kept: [posting("historical", { state: { ...state, saved: view === "saved", dismissed: view === "dismissed" } })] });
    expect(screen.getByRole("heading", { name: "Designer historical" })).toBeInTheDocument();
    expect(screen.getByText(/Saved and dismissed postings remain here for your history/)).toHaveTextContent("Scoring and starting an application check your current rules.");
    expect(screen.getByRole("link", { name: "current rules" })).toHaveAttribute("href", "/settings?section=agent");
  });
});

describe("the results", () => {
  it("lists the postings and shows the first one's whole text", () => {
    renderScreen({ search: stored([posting("a", { salary: "EUR 70,000 a year", remote: true }), posting("b")], "cursor:2") });
    expect(screen.getByText("2 postings from JSearch, more to come · searched today at 14:32")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Postings" });
    const items = within(list).getAllByRole("button", { name: /^Designer/ });
    expect(items.map((item) => item.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(items[0]).toHaveTextContent("Company a · Hamburg · Remote");
    expect(items[0]).toHaveTextContent("3 days ago · via LinkedIn · EUR 70,000 a year");
    expect(screen.getByRole("heading", { level: 2, name: "Designer a" })).toBeInTheDocument();
    expect(screen.getByText("The whole posting a.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open posting/ })).toHaveAttribute("href", "https://jobs.example/a");
    expect(screen.getByRole("link", { name: /Open posting/ })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows another posting when it's picked, and moves with the arrow keys", async () => {
    renderScreen({ search: stored([posting("a"), posting("b"), posting("c")]) });
    await userEvent.click(screen.getByRole("button", { name: /^Designer b/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Designer b" })).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /^Designer c/ })).toHaveFocus();
    expect(screen.getByRole("heading", { level: 2, name: "Designer c" })).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("heading", { level: 2, name: "Designer a" })).toBeInTheDocument();
  });

  it("saves a posting and takes it out of Saved again", async () => {
    renderScreen({ search: stored([posting("a")]) });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const { state: _ignored, ...sent } = posting("a");
    void _ignored;
    expect(savePostingForLater).toHaveBeenCalledWith({ posting: sent });
    expect(screen.getByRole("button", { name: "Saved" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("list", { name: "Postings" })).getByText("Saved")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Saved" }));
    expect(unsavePosting).toHaveBeenCalledWith({ source: "JSEARCH", externalId: "a" });
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("dismisses a posting, with Undo, and can show the dismissed ones", async () => {
    vi.mocked(dismissFoundPosting).mockResolvedValue({ ok: true, data: { wasSaved: true } });
    renderScreen({ search: stored([posting("a", { state: { ...state, saved: true } }), posting("b")]) });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: /^Designer a/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Designer b" })).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith("Dismissed. It won't show in your searches.", { action: { label: "Undo", onClick: expect.any(Function) } });

    await userEvent.click(screen.getByRole("button", { name: "1 dismissed posting hidden · Show" }));
    expect(screen.getByRole("button", { name: /^Designer a/ })).toHaveTextContent("Dismissed");

    vi.mocked(toast).mock.calls[0][1]!.action!.onClick();
    await waitFor(() => expect(restorePosting).toHaveBeenCalledWith({ source: "JSEARCH", externalId: "a", saved: true }));
    expect(await screen.findByRole("heading", { level: 2, name: "Designer a" })).toBeInTheDocument();
  });

  it("brings back a dismissed posting from the list", async () => {
    renderScreen({ search: stored([posting("a", { state: { ...state, dismissed: true } })]) });
    expect(screen.getByText("You've dismissed every posting here.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "1 dismissed posting hidden · Show" }));
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));
    expect(restorePosting).toHaveBeenCalledWith({ source: "JSEARCH", externalId: "a", saved: false });
  });

  it("says when a dismiss didn't work", async () => {
    vi.mocked(dismissFoundPosting).mockResolvedValue({ ok: false, error: "Something went wrong on the server. Please try again." });
    renderScreen({ search: stored([posting("a")]) });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(toast).toHaveBeenCalledWith("Something went wrong on the server. Please try again.");
    expect(screen.getByRole("button", { name: /^Designer a/ })).toBeInTheDocument();
  });

  it("replaces the kept search with its complete current list, once each", async () => {
    vi.mocked(showMorePostings).mockResolvedValue({ ok: true, data: { ok: true, postings: [posting("a"), posting("b"), posting("c")], next: null } });
    renderScreen({ search: stored([posting("a"), posting("b")], "cursor:2") });
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(showMorePostings).toHaveBeenCalledWith({ searchId: "run-1" });
    expect(within(screen.getByRole("list", { name: "Postings" })).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("runs the same search again, as a new one", async () => {
    renderScreen({ search: stored([posting("a")]) });
    await userEvent.click(screen.getByRole("button", { name: "Search again" }));
    expect(runJobSearch).toHaveBeenCalledWith({ query });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/jobs?search=run-2", { scroll: false }));
  });

  it("says when the next page didn't come", async () => {
    vi.mocked(showMorePostings).mockResolvedValue({ ok: true, data: { ok: false, problem: "quota", message: "No searches left." } });
    renderScreen({ search: stored([posting("a")], "cursor:2") });
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(toast).toHaveBeenCalledWith("No searches left.");
  });

  it("explicitly checks and loads full text once, keeping the snippet visible while pending", async () => {
    let finish!: (result: Awaited<ReturnType<typeof loadFullText>>) => void;
    vi.mocked(loadFullText).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const partial = posting("a", { complete: false, description: "The start…" });
    renderScreen({ search: stored([partial]) });
    expect(screen.getByText("The start…")).toBeInTheDocument();
    expect(screen.getByText(/This checks your current rules and may use your AI provider and job source/)).toBeInTheDocument();
    expect(loadFullText).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Check and load full text" }));
    const pending = screen.getByRole("button", { name: "Checking and loading…" });
    expect(pending).toBeDisabled();
    expect(screen.getByRole("region", { name: "Posting text" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Checking your current rules and loading the full posting…")).toHaveAttribute("role", "status");
    expect(screen.getByText("The start…")).toBeInTheDocument();
    await userEvent.click(pending);
    expect(loadFullText).toHaveBeenCalledTimes(1);
    const { state: _ignored, ...sent } = partial;
    void _ignored;
    expect(loadFullText).toHaveBeenCalledWith({ posting: sent });
    await act(async () => finish({ ok: true, data: { text: "Everything about the role." } }));
    expect(screen.getByText("Everything about the role.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check and load full text" })).not.toBeInTheDocument();
  });

  it.each(["search", "saved", "dismissed"] as const)("never automatically loads incomplete %s postings on mount, selection, refresh or reload", async (view) => {
    vi.mocked(loadFullText).mockResolvedValue({ ok: true, data: { text: "A provider response." } });
    const partials = ["a", "b"].map((id) => posting(id, {
      complete: false,
      description: `The start of ${id}…`,
      state: { ...state, saved: view === "saved", dismissed: view === "dismissed" },
    }));
    const props = { view, search: view === "search" ? stored(partials) : null, kept: partials };
    const { rerender, unmount } = renderScreen(props);
    await act(async () => {});
    expect(loadFullText).not.toHaveBeenCalled();
    expect(screen.getByText("The start of a…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Designer b/ }));
    expect(screen.getByText("The start of b…")).toBeInTheDocument();
    expect(loadFullText).not.toHaveBeenCalled();
    const refreshed = partials.map((entry) => ({ ...entry }));
    rerender(<JobsScreen {...screenProps} {...props} search={view === "search" ? stored(refreshed) : null} kept={refreshed} />);
    await act(async () => {});
    expect(screen.getByText("The start of a…")).toBeInTheDocument();
    expect(loadFullText).not.toHaveBeenCalled();
    unmount();
    renderScreen(props);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Check and load full text" })).toBeEnabled();
    expect(loadFullText).not.toHaveBeenCalled();
    expect(runJobSearch).not.toHaveBeenCalled();
    expect(showMorePostings).not.toHaveBeenCalled();
    expect(recheckJobSearch).not.toHaveBeenCalled();
  });

  it.each(["selection", "same-search refresh"])("ignores a full-text response after %s changes the detail", async (change) => {
    let finish!: (result: Awaited<ReturnType<typeof loadFullText>>) => void;
    vi.mocked(loadFullText).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = renderScreen({ search: stored([posting("a", { complete: false, description: "The start…" }), posting("b")]) });
    await userEvent.click(screen.getByRole("button", { name: "Check and load full text" }));
    if (change === "selection") await userEvent.click(screen.getByRole("button", { name: /^Designer b/ }));
    else rerender(<JobsScreen {...screenProps} search={stored([posting("a", { description: "New verified description." })])} />);
    await act(async () => finish({ ok: true, data: { text: "Old provider response." } }));
    expect(screen.queryByText("Old provider response.")).not.toBeInTheDocument();
    expect(screen.queryByText("The start…")).not.toBeInTheDocument();
    expect(screen.getByText(change === "selection" ? "The whole posting b." : "New verified description.")).toBeInTheDocument();
    expect(loadFullText).toHaveBeenCalledTimes(1);
  });

  it.each([null, ""])("keeps the start and offers retry when the rest can't be had: %s", async (text) => {
    vi.mocked(loadFullText).mockResolvedValueOnce({ ok: true, data: { text } });
    renderScreen({ search: stored([posting("a", { complete: false, description: "The start…" })]) });
    await userEvent.click(screen.getByRole("button", { name: "Check and load full text" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The full text isn't available right now. Try again or open the posting's page.");
    expect(screen.getByText(/This is only the start of the posting/)).toBeInTheDocument();
    expect(screen.getByText("The start…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check and load full text" })).toBeEnabled();
  });

  it("keeps the snippet after a rules failure and loads successfully on explicit retry", async () => {
    vi.mocked(loadFullText)
      .mockResolvedValueOnce({ ok: false, error: "Choose an AI provider to check your current rules." })
      .mockResolvedValueOnce({ ok: true, data: { text: "Everything about the role." } });
    renderScreen({ search: stored([posting("a", { complete: false, description: "The start…" })]) });
    await userEvent.click(screen.getByRole("button", { name: "Check and load full text" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose an AI provider to check your current rules.");
    expect(screen.getByText("The start…")).toBeInTheDocument();
    expect(loadFullText).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Check and load full text" }));
    expect(screen.getByText("Everything about the role.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(loadFullText).toHaveBeenCalledTimes(2);
  });

  it("recovers from a rejected full-text request without exposing private details", async () => {
    vi.mocked(loadFullText)
      .mockRejectedValueOnce(new Error("private provider detail"))
      .mockResolvedValueOnce({ ok: true, data: { text: "Everything about the role." } });
    renderScreen({ search: stored([posting("a", { complete: false, description: "The start…" })]) });
    await userEvent.click(screen.getByRole("button", { name: "Check and load full text" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The full text couldn't be loaded. Try again.");
    expect(screen.queryByText("private provider detail")).not.toBeInTheDocument();
    expect(screen.getByText("The start…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check and load full text" }));
    expect(screen.getByText("Everything about the role.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("starts an application from the selected posting (E14-8)", async () => {
    vi.mocked(startApplicationFrom).mockResolvedValue({ ok: true, data: { postingId: "p 1" } });
    renderScreen({ search: stored([posting("a"), posting("b")]) });
    await userEvent.click(screen.getByRole("button", { name: /^Designer b/ }));
    await userEvent.click(screen.getByRole("button", { name: "Start application →" }));
    const { state: _ignored, ...sent } = posting("b");
    void _ignored;
    expect(startApplicationFrom).toHaveBeenCalledWith({ posting: sent });
    expect(router.push).toHaveBeenCalledWith("/new?posting=p%201");
    expect(screen.getByRole("button", { name: "Starting…" })).toHaveAttribute("aria-disabled", "true");
  });

  it("stays put when starting doesn't work", async () => {
    vi.mocked(startApplicationFrom).mockResolvedValue({ ok: false, error: "Something went wrong on the server. Please try again." });
    renderScreen({ search: stored([posting("a")]) });
    await userEvent.click(screen.getByRole("button", { name: "Start application →" }));
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Start application →" })).toBeInTheDocument();
  });

  it("links a posting you've applied for to its application", () => {
    renderScreen({ search: stored([posting("a", { state: { ...state, applicationId: "app-1" } })]) });
    expect(within(screen.getByRole("list", { name: "Postings" })).getByText("Applied")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the application" })).toHaveAttribute("href", "/applications/app-1");
  });

  it("says when nothing was found", () => {
    renderScreen({ search: stored([]) });
    expect(screen.getByText("No postings for “product designer” within 25 km of Hamburg. Try a bigger radius or fewer words.")).toBeInTheDocument();
  });

  it("names the source's attribution when it asks for one", () => {
    renderScreen({ source: "ADZUNA", search: stored([posting("a", { source: "ADZUNA" })]) });
    expect(screen.getByText("Jobs by Adzuna")).toBeInTheDocument();
  });
});

describe("problems", () => {
  const failWith = async (problem: "key" | "quota", message: string) => {
    vi.mocked(runJobSearch).mockResolvedValue({ ok: true, data: { ok: false, problem, message } });
    renderScreen({ search: stored([posting("a")]) });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    return screen.findByRole("alert");
  };

  it("sends key problems to Settings, in place of the results", async () => {
    expect(await failWith("key", "JSearch didn't accept your key.")).toHaveTextContent("JSearch didn't accept your key.");
    expect(screen.getByRole("link", { name: "Open Settings → Job search" })).toHaveAttribute("href", "/settings?section=jobs");
    expect(screen.queryByRole("list", { name: "Postings" })).not.toBeInTheDocument();
  });

  it("just says so when the quota is used up", async () => {
    const alert = await failWith("quota", "No searches left.");
    expect(alert).toHaveTextContent("No searches left.");
    expect(within(alert).queryByRole("link")).not.toBeInTheDocument();
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("past searches (E14-10)", () => {
  const history = [
    {
      day: "Today",
      searches: [
        { id: "s1", source: "JSEARCH" as const, query: { ...query, radiusKm: 50 as const, remoteOnly: true, postedWithin: "week" as const }, found: 16, time: "14:32" },
        { id: "s2", source: "JSEARCH" as const, query: { ...query, keywords: "researcher", place: "" }, found: 1, time: "09:05" },
      ],
    },
    { day: "Mon 28 Sep", searches: [{ id: "s3", source: "ADZUNA" as const, query: { ...query, keywords: "writer" }, found: 0, time: "10:00" }] },
  ];

  it("lists them by day, each opening without asking the source again", () => {
    renderScreen({ view: "history", history, counts: { searches: 3, saved: 0, dismissed: 0 } });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    const today = screen.getByRole("region", { name: "Today" });
    expect(within(today).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["product designer · Hamburg, 50 km · Remote only · Past week14:32 · 16 postings · JSearch", "/jobs?search=s1"],
      ["researcher · Germany09:05 · 1 posting · JSearch", "/jobs?search=s2"],
    ]);
    expect(within(screen.getByRole("region", { name: "Mon 28 Sep" })).getByRole("link")).toHaveTextContent("writer · Hamburg, 25 km10:00 · 0 postings · Adzuna");
  });

  it("removes a search", async () => {
    renderScreen({ view: "history", history });
    await userEvent.click(screen.getByRole("button", { name: "Remove the search “researcher · Germany” from 09:05" }));
    expect(removeJobSearch).toHaveBeenCalledWith({ id: "s2" });
    expect(screen.queryByRole("link", { name: /researcher/ })).not.toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("puts a search back when removing it didn't work", async () => {
    vi.mocked(removeJobSearch).mockResolvedValue({ ok: false, error: "Something went wrong on the server. Please try again." });
    renderScreen({ view: "history", history });
    await userEvent.click(screen.getByRole("button", { name: /Remove the search “researcher/ }));
    expect(await screen.findByRole("link", { name: /researcher/ })).toBeInTheDocument();
  });

  it("says when there are none", () => {
    renderScreen({ view: "history", history: [] });
    expect(screen.getByText(/No searches yet\. Each search you run is kept here/)).toBeInTheDocument();
  });
});

describe("the Saved and Dismissed views (E14-7)", () => {
  it("has tabs for the search, past searches and the kept postings, with how many each holds", () => {
    renderScreen({ counts: { searches: 4, saved: 3, dismissed: 1 } });
    const tabs = within(screen.getByRole("navigation", { name: "Find jobs views" })).getAllByRole("link");
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("href"), tab.getAttribute("aria-current")])).toEqual([
      ["Search", "/jobs", "page"],
      ["Past searches4", "/jobs?view=history", null],
      ["Saved3", "/jobs?view=saved", null],
      ["Dismissed1", "/jobs?view=dismissed", null],
    ]);
  });

  it("lists the saved postings, without the search form, even with job search off", () => {
    renderScreen({ source: null, view: "saved", kept: [posting("a", { state: { ...state, saved: true } })], counts: { searches: 0, saved: 1, dismissed: 0 } });
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(screen.queryByText("Choose where to search")).not.toBeInTheDocument();
    expect(screen.getByText("1 saved posting")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Designer a" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start application →" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Find jobs views" })).getByRole("link", { name: /Saved/ })).toHaveAttribute("aria-current", "page");
  });

  it("takes an unsaved posting out of Saved, with Undo", async () => {
    renderScreen({ view: "saved", kept: [posting("a", { state: { ...state, saved: true } }), posting("b", { state: { ...state, saved: true } })] });
    await userEvent.click(screen.getByRole("button", { name: "Saved" }));
    expect(unsavePosting).toHaveBeenCalledWith({ source: "JSEARCH", externalId: "a" });
    expect(screen.queryByRole("button", { name: /^Designer a/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Designer b" })).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith("Removed from Saved.", { action: { label: "Undo", onClick: expect.any(Function) } });

    vi.mocked(toast).mock.calls[0][1]!.action!.onClick();
    expect(await screen.findByRole("button", { name: /^Designer a/ })).toBeInTheDocument();
    expect(savePostingForLater).toHaveBeenCalled();
  });

  it("says when there's nothing saved or dismissed", () => {
    const { unmount } = renderScreen({ view: "saved", kept: [] });
    expect(screen.getByText("Nothing saved yet. Save a posting from your search results to keep it here.")).toBeInTheDocument();
    unmount();
    renderScreen({ view: "dismissed", kept: [] });
    expect(screen.getByText("Nothing dismissed. Postings you dismiss stay out of your searches and wait here.")).toBeInTheDocument();
  });

  it("brings a dismissed posting back into the searches", async () => {
    renderScreen({ view: "dismissed", kept: [posting("a", { state: { ...state, dismissed: true } })] });
    expect(screen.getByText("1 dismissed posting, kept out of your searches")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start application →" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Bring back" }));
    expect(restorePosting).toHaveBeenCalledWith({ source: "JSEARCH", externalId: "a", saved: false });
    expect(toast).toHaveBeenCalledWith("Brought back. It'll show in your searches again.");
    expect(screen.queryByRole("button", { name: /^Designer a/ })).not.toBeInTheDocument();
  });
});
