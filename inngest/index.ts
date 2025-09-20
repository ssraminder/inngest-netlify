// inngest/index.ts
// Central index that exports a deduplicated list of all functions
// (imported from the functions folder + workflows file)

import * as funcs from "./functions"; // note: TS path resolves to importing from files in the folder
import { functions as workflowFunctions } from "./workflows";

// Collect functions exported individually from /inngest/functions files.
// Because there isn't an index.ts inside /inngest/functions in the repo
// we import everything from "./functions" — the bundler will include the files.
const fileExports: any = funcs || {};

// Build an array of candidate functions from named exports in /inngest/functions
const fileFunctions = Object.values(fileExports).filter(Boolean);

/**
 * workflowFunctions is exported from workflows.ts as `export const functions = [ ... ]`
 * so it should be an array already.
 */
const wfFunctions: any[] = Array.isArray(workflowFunctions) ? workflowFunctions : [];

/**
 * Combine and dedupe by function id. Different versions of the SDK attach the
 * ID in different places; we'll check common properties and use whichever exists.
 */
function getFunctionId(fn: any): string | undefined {
  if (!fn) return undefined;
  // common locations checked in order:
  return fn.id ?? fn.name ?? (fn?.options && fn.options.id) ?? (fn?.meta && fn.meta.id);
}

const all = [...fileFunctions, ...wfFunctions];

// Deduplicate preserving first occurrence
const seen = new Set<string>();
const deduped = [];
for (const f of all) {
  const id = getFunctionId(f);
  if (!id) {
    // include functions without id (shouldn't happen), but keep them
    deduped.push(f);
    continue;
  }
  if (!seen.has(id)) {
    seen.add(id);
    deduped.push(f);
  } else {
    // duplicate - skip
    // (if you want the workflow version to take precedence, swap the order above)
  }
}

export const functions = deduped;
export default functions;
