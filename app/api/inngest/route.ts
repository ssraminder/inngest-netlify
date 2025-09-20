import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";

// Functions exported from the small functions folder
import {
  echoFilesUploaded,
  processUpload,
  quoteCreatedPrepareJobs as functionsQuoteCreatedPrepareJobs,
} from "@/inngest/functions";

// Functions defined in the workflows file (these were previously not imported / registered)
import {
  ocrDocument,
  geminiAnalyze,
  computePricing,
  quoteCreatedPrepareJobs as workflowsQuoteCreatedPrepareJobs,
} from "@/inngest/workflows";

// Build a single list of functions to register. Avoid duplicate entries.
const registeredFunctions = [
  echoFilesUploaded,
  processUpload,
  // prefer the functions/ version if present, otherwise the workflows version
  functionsQuoteCreatedPrepareJobs ?? workflowsQuoteCreatedPrepareJobs,
  // add the workflow functions that were missing previously:
  ocrDocument,
  geminiAnalyze,
  computePricing,
].filter(Boolean);

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: registeredFunctions,
});
