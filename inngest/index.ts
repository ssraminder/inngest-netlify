// inngest/index.ts
// Consolidate all function exports (from /inngest/functions/* AND /inngest/workflows.ts)
// into a single `functions` array that the /api/inngest route can import.

import * as fnFiles from "./functions";
import * as workflows from "./workflows";

/**
 * Collect runtime function objects from the functions folder.
 * Each file should export a function object returned by `inngest.createFunction(...)`.
 */
const fileFns = Object.values(fnFiles).filter(Boolean) as any[];

/**
 * Collect exported items from workflows (ocrDocument, geminiAnalyze, computePricing, etc.)
 * They are also expected to be the function objects created with `inngest.createFunction`.
 */
const workflowFns = Object.values(workflows).filter(Boolean) as any[];

/**
 * Final combined array. Order matters only if you rely on a shim that invokes another function.
 * Place fileFns first, then workflowFns so explicit workflows (ocr, compute-pricing, gemini) are present.
 */
export const functions = [...fileFns, ...workflowFns];
