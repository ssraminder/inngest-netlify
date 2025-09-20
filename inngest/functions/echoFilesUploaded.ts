import { inngest } from "@/lib/inngest/client";

export const echoFilesUploaded = inngest.createFunction(
  { id: "ocr-document" },
  { event: "files/uploaded" },
  async ({ event }) => {
    // TODO: Implement files uploaded echo logic
    return { success: true };
  }
);
