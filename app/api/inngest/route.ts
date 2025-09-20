import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";

// Functions exported from the small functions folder
import {
  echoFilesUploaded,
  processUpload,
  quoteCreatedPrepareJobs as functionsQuoteCreatedPrepareJobs,
} from "@/inngest/functions";

// Functions defined in the workflows file
import {
  ocrDocument,
  geminiAnalyze,
  computePricing,
  quoteCreatedPrepareJobs as workflowsQuoteCreatedPrepareJobs,
} from "@/inngest/workflows";

/**
 * Build a single list of functions to register.
 * Use functions/ version if present, otherwise workflows/ version.
 * Then dedupe by function id to avoid duplicate registration errors.
 */
const raw = [
  echoFilesUploaded,
  processUpload,
  // prefer the functions/ version if present, otherwise the workflows version
  functionsQuoteCreatedPrepareJobs ?? workflowsQuoteCreatedPrepareJobs,
  // workflow functions:
  ocrDocument,
  geminiAnalyze,
  computePricing,
].filter(Boolean);

// Deduplicate by function ID (use function.id if available)
const seen = new Set<string>();
const registeredFunctions = raw.filter((fn: any) => {
  // Try to read .id property or fallback to .name or toString
  const id = (fn && (fn.id || fn.name || (fn?.options && fn.options.id)))?.toString();
  if (!id) return true; // keep if no id found (edge-case)
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
});

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: registeredFunctions,
});
