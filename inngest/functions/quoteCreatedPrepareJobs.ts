import { inngest } from "../client";

export const quoteCreatedPrepareJobs = inngest.createFunction(
  { id: "quote-created-prepare-jobs" },
  { event: "quote/created" },
  async ({ event }) => {
    // TODO: Implement quote preparation logic
    return { success: true };
  }
);
