import "server-only";

import { z } from "zod";

import { getAiProvider } from "@/lib/ai";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { scorePosting } from "@/lib/ai/tasks";
import { fullText } from "@/lib/job-search/find";
import { requireEligiblePosting } from "@/lib/job-search/eligibility";
import { foundPostingSchema, postingKey, postingText, type FoundPosting } from "@/lib/job-search/search";
import { saveScore } from "@/lib/posting-scores";
import { loadProfile } from "@/lib/profile-data";

import { defineJob } from "./runner";

/** The key of a posting's scoring job, so a second click follows the one under way. */
export const scoreJobKey = (posting: Pick<FoundPosting, "source" | "externalId">) => `posting-score:${postingKey(posting)}`;

/**
 * Score in Find jobs (#208): how well one posting fits the profile, as the
 * job agent scores them (score-posting). A source that sent only the start
 * of it is asked for the rest first. The score is kept with the posting.
 */
export const scorePostingJob = defineJob({
  type: "posting-score",
  input: z.object({ posting: foundPostingSchema }),
  result: z.object({ score: z.number().int(), reasons: z.array(z.string()), redFlags: z.array(z.string()) }),
  async run({ posting }, { step, signal }) {
    await step("Checking your posting rules");
    let eligible = await requireEligiblePosting(posting, signal);
    if (!eligible.complete) {
      await step("Getting the whole posting");
      const description = await fullText(eligible);
      if (description) eligible = { ...eligible, description, complete: true };
    }
    await step("Scoring it against your profile");
    const [provider, options, profile] = await Promise.all([getAiProvider(), loadTaskOptions(), loadProfile()]);
    const { data, promptVersion } = await scorePosting(
      provider,
      { posting: postingText(eligible), title: eligible.title, company: eligible.company, place: eligible.place, remote: eligible.remote, salary: eligible.salary, profile },
      { ...options, signal },
    );
    // A queued or running job must not publish a score after its policy changes.
    await requireEligiblePosting(eligible, signal);
    await saveScore(eligible, data, promptVersion);
    return data;
  },
});
