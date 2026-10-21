import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun } from "@/lib/settings";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { nextAgentRun, resetInterruptedDrafts, scheduledRunDue, startDueRun } from "./schedule";
import { runLimitProblem } from "./runs";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const zone = vi.hoisted(() => ({ value: "Europe/Berlin" }));
vi.mock("@/lib/time-zone", () => ({ lastKnownTimeZone: async () => zone.value }));
vi.mock("@/lib/ai/config", () => ({ isAiConfigured: async () => true }));
vi.mock("@/lib/agent/cv", async () => {
  const { demoProfile } = await import("@/lib/demo-profile");
  return { loadAgentProfile: async () => demoProfile() };
});
vi.mock("@/lib/job-search/config", () => ({
  loadJobSearchConfig: async () => ({ source: "JSEARCH" }),
  credentialsFor: () => ({ key: "key", host: "openwebninja" }),
}));
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "agent-job"),
}));

const prisma = () => db.client!;
const run = (at: string, manual = false): AgentRun => ({ at, manual, message: null });

beforeEach(async () => {
  zone.value = "Europe/Berlin";
  await resetDatabase(prisma());
  await saveSettings({ agentQuery: { keywords: "IT Manager", country: "de", place: "", radiusKm: 25, remoteOnly: false, postedWithin: "any" } });
});
afterAll(() => prisma().$disconnect());

describe("when the daily run is due (E16-4)", () => {
  it("reads the hour and the day in the user's time zone, not the server's", () => {
    // 05:30 UTC is 07:30 in Berlin: due at 7 there, though UTC hasn't reached 7.
    expect(scheduledRunDue(new Date("2026-10-20T05:30:00Z"), 7, "Europe/Berlin", [])).toBe(true);
    expect(scheduledRunDue(new Date("2026-10-20T04:30:00Z"), 7, "Europe/Berlin", [])).toBe(false);
    expect(scheduledRunDue(new Date("2026-10-20T05:30:00Z"), 7, "UTC", [])).toBe(false);
    // Kolkata is UTC+5:30, with no daylight saving.
    expect(scheduledRunDue(new Date("2026-10-20T01:30:00Z"), 7, "Asia/Kolkata", [])).toBe(true);
    expect(scheduledRunDue(new Date("2026-10-20T01:29:00Z"), 7, "Asia/Kolkata", [])).toBe(false);
  });

  it("runs once a day: any run that day in the user's zone, scheduled or not, counts", () => {
    // 23:30 UTC on the 19th is 01:30 on the 20th in Berlin.
    expect(scheduledRunDue(new Date("2026-10-20T06:00:00Z"), 7, "Europe/Berlin", [run("2026-10-19T23:30:00Z", true)])).toBe(false);
    expect(scheduledRunDue(new Date("2026-10-20T06:00:00Z"), 7, "UTC", [run("2026-10-19T23:30:00Z", true)])).toBe(false);
    expect(scheduledRunDue(new Date("2026-10-20T07:00:00Z"), 7, "UTC", [run("2026-10-19T23:30:00Z", true)])).toBe(true);
  });

  it("keeps the hour across daylight saving changes", () => {
    // Berlin leaves summer time on 25 October 2026: 07:00 is 05:00 UTC the day before, 06:00 UTC that day.
    const ranSaturday = [run("2026-10-24T05:00:00Z")];
    expect(nextAgentRun(new Date("2026-10-24T09:00:00Z"), 7, "Europe/Berlin", ranSaturday).toISOString()).toBe("2026-10-25T06:00:00.000Z");
    // New York leaves it on 1 November 2026.
    const ranOn31st = [run("2026-10-31T11:00:00Z")];
    expect(nextAgentRun(new Date("2026-10-31T15:00:00Z"), 7, "America/New_York", ranOn31st).toISOString()).toBe("2026-11-01T12:00:00.000Z");
    // And Berlin goes back to summer time on 28 March 2027.
    expect(nextAgentRun(new Date("2027-03-27T10:00:00Z"), 7, "Europe/Berlin", [run("2027-03-27T06:00:00Z")]).toISOString()).toBe("2027-03-28T05:00:00.000Z");
  });

  it("says the next run is today's while it's still to come, and soon when it's overdue", () => {
    expect(nextAgentRun(new Date("2026-10-20T03:00:00Z"), 7, "Europe/Berlin", []).toISOString()).toBe("2026-10-20T05:00:00.000Z");
    expect(nextAgentRun(new Date("2026-10-20T05:07:30Z"), 7, "Europe/Berlin", []).toISOString()).toBe("2026-10-20T05:08:00.000Z");
  });
});

describe("the limits (E16-4)", () => {
  const now = new Date("2026-10-20T12:00:00Z");

  it("lets Run now go an hour after the previous run of either kind", () => {
    expect(runLimitProblem([], now, { manual: true })).toBeNull();
    expect(runLimitProblem([run("2026-10-20T11:35:00Z")], now, { manual: true })).toBe("The agent ran less than an hour ago. Try again in 35 minutes.");
    expect(runLimitProblem([run("2026-10-20T10:59:00Z", true)], now, { manual: true })).toBeNull();
    // A scheduled run only minds the daily limit.
    expect(runLimitProblem([run("2026-10-20T11:35:00Z")], now, { manual: false })).toBeNull();
  });

  it("allows twelve runs in any 24 hours, including eight scheduled scans and extra manual ones", () => {
    const twelve = [...Array.from({ length: 11 }, (_, index) => run(new Date(now.getTime() - (index + 1) * 3600000).toISOString())), run("2026-10-19T13:00:00Z")];
    expect(runLimitProblem(twelve, now, { manual: false })).toBe("The agent has run 12 times in the past 24 hours, as many as it may. Try again in 1 hour.");
    expect(runLimitProblem(twelve, new Date("2026-10-20T13:00:01Z"), { manual: false })).toBeNull();
    expect(runLimitProblem(twelve.slice(0, 11), now, { manual: false })).toBeNull();
  });
});

describe("the schedule (E16-4)", () => {
  it("does not queue repeated setup failures while an enabled search is incomplete", async () => {
    const { startJob } = await import("@/lib/jobs/runner");
    vi.mocked(startJob).mockClear();
    await saveSettings({ agentEnabled: true, agentQueries: [{ keywords: "Head of IT", country: "", place: "", radiusKm: 25, remoteOnly: false, postedWithin: "any" }] });
    expect(await startDueRun(new Date("2026-10-20T06:00:00Z"))).toBeNull();
    expect(await startDueRun(new Date("2026-10-20T06:01:00Z"))).toBeNull();
    expect(startJob).not.toHaveBeenCalled();
    expect(await prisma().job.count()).toBe(0);
  });

  it("starts the day's run when it's due and the agent is on, once", async () => {
    const { startJob } = await import("@/lib/jobs/runner");
    const due = new Date("2026-10-20T06:00:00Z");
    expect(await startDueRun(due)).toBeNull();
    await saveSettings({ agentEnabled: true, agentIntervalHours: 24 });
    expect(await startDueRun(due)).toBe("agent-job");
    expect(startJob).toHaveBeenCalledWith(expect.objectContaining({ type: "agent-scan" }), { manual: false }, { key: "agent" });

    // Not while one is queued or running, nor before the hour, nor after today's.
    vi.mocked(startJob).mockClear();
    await prisma().job.create({ data: { type: "agent-scan", key: "agent", status: "RUNNING", input: { manual: false } } });
    expect(await startDueRun(due)).toBeNull();
    await prisma().job.deleteMany();
    expect(await startDueRun(new Date("2026-10-20T04:00:00Z"))).toBeNull();
    await saveSettings({ agentRuns: [run("2026-10-20T05:00:00Z")] });
    expect(await startDueRun(due)).toBeNull();
    expect(startJob).not.toHaveBeenCalled();
  });

  it("catches up once after downtime, then waits a full three hours from that run", async () => {
    const due = new Date("2026-10-20T06:00:00Z");
    const old = [run("2026-10-18T06:00:00Z")];
    expect(scheduledRunDue(due, 7, "Europe/Berlin", old, 3)).toBe(true);
    expect(nextAgentRun(due, 7, "Europe/Berlin", old, 3)).toEqual(due);
    const caughtUp = [run(due.toISOString()), ...old];
    expect(scheduledRunDue(new Date("2026-10-20T08:59:59Z"), 7, "Europe/Berlin", caughtUp, 3)).toBe(false);
    expect(scheduledRunDue(new Date("2026-10-20T09:00:00Z"), 7, "Europe/Berlin", caughtUp, 3)).toBe(true);
    expect(nextAgentRun(due, 7, "Europe/Berlin", caughtUp, 3).toISOString()).toBe("2026-10-20T09:00:00.000Z");
  });

  it("does not queue repeated attempts while the daily allowance is full", async () => {
    const { startJob } = await import("@/lib/jobs/runner");
    vi.mocked(startJob).mockClear();
    const now = new Date("2026-10-20T23:00:00Z");
    await saveSettings({ agentEnabled: true, agentIntervalHours: 3, agentRuns: Array.from({ length: 12 }, (_, index) => run(new Date(now.getTime() - (index + 4) * 3600000).toISOString())) });
    expect(await startDueRun(now)).toBeNull();
    expect(await startDueRun(new Date(now.getTime() + 15 * 60000))).toBeNull();
    expect(startJob).not.toHaveBeenCalled();
  });

  it("sends drafts a restart interrupted back to the queue, saying so", async () => {
    await prisma().agentCandidate.create({ data: { source: "JSEARCH", externalId: "job-1", dedupeKey: "k1", status: "DRAFTING" } });
    await prisma().agentCandidate.create({ data: { source: "JSEARCH", externalId: "job-2", dedupeKey: "k2", status: "DRAFTED" } });
    expect(await resetInterruptedDrafts()).toBe(1);
    expect(await prisma().agentCandidate.findMany({ orderBy: { externalId: "asc" }, select: { status: true, error: true } })).toEqual([
      { status: "SCORED", error: "Drafting was interrupted. Try again." },
      { status: "DRAFTED", error: null },
    ]);
  });
});
