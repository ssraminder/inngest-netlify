// inngest/functions/echoFilesUploaded.ts
import { inngest } from "@/inngest/client";

export const echoFilesUploaded = inngest.createFunction(
  { id: "ocr-document" },            // <-- set to the stable ID Inngest expects
  { event: "files/uploaded" },
  async ({ event }) => {
    console.log("files/uploaded payload:", event.data);
    // ...existing handler logic...
  }
);
