import { FN_IDS } from "@/inngest/constants";
import { inngest } from "@/lib/inngest/client";

export const processUpload = inngest.createFunction(
  { id: FN_IDS.PROCESS_UPLOAD },
  { event: "upload/process" },
  async ({ event }) => {
    // TODO: Implement upload processing logic
    return { success: true };
  }
);
