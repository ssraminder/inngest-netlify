import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";

import { quoteCreatedPrepareJobs } from "@/inngest/functions/quoteCreatedPrepareJobs";
import { processUpload } from "@/inngest/functions/processUpload";
import { echoFilesUploaded } from "@/inngest/functions/echoFilesUploaded";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    quoteCreatedPrepareJobs, // listens "quote/created"
    processUpload,           // listens "files/uploaded"
    echoFilesUploaded,       // logs "files/uploaded"
  ],
});
