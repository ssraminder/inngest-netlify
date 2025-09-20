import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";

// If you have an index exporting all functions:
import {
  echoFilesUploaded,
  processUpload,
  quoteCreatedPrepareJobs,
} from "../../../../inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    echoFilesUploaded,
    processUpload,
    quoteCreatedPrepareJobs,
  ],
});
