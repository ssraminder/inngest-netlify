import { inngest } from "@/lib/inngest/client";

export const processUpload = inngest.createFunction(
  { id: "process-upload" },
  { event: "upload/process" },
  async ({ event }) => {
    // TODO: Implement upload processing logic
    return { success: true };
  }
);
