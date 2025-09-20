import { inngest } from "@/lib/inngest/client";

export const echoFilesUploaded = inngest.createFunction(
  { id: "echo-files-uploaded" },
  { event: "files/uploaded" },
  async ({ event }) => {
    // TODO: Implement files uploaded echo logic
    return { success: true };
  }
);
