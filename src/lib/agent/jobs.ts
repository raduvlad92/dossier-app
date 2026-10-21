import "server-only";

import { z } from "zod";

import { defineJob } from "@/lib/jobs/runner";

import { agentScanResultSchema, runAgentScan } from "./run";

/** Keyed so the schedule and Run now find a run that's queued or running. */
export const AGENT_JOB_KEY = "agent";

/** One bounded pass through every configured search, then scores and optional drafts. */
export const agentScanJob = defineJob({
  type: "agent-scan",
  input: z.object({ manual: z.boolean() }),
  result: agentScanResultSchema,
  run: (input, context) => runAgentScan(input, context),
});

const globalForLaunch = globalThis as unknown as { agentLaunchLock?: Promise<void> };

/** Serialize Run now and timer checks in this single-instance installation. */
export async function withAgentRunLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = globalForLaunch.agentLaunchLock ?? Promise.resolve();
  let release!: () => void;
  globalForLaunch.agentLaunchLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
