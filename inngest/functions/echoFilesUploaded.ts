// inngest/functions/echoFilesUploaded.ts
import { inngest } from "@/lib/inngest/client";

export const echoFilesUploaded = inngest.createFunction(
  { id: "echo-files-uploaded" },            // <-- set to the stable ID Inngest expects
  { event: "files/uploaded" },
  async ({ event }) => {
    console.log("files/uploaded payload:", event.data);
    // ...existing handler logic...
  }
);
