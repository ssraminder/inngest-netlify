/**
 * inngest/index.ts
 * Consolidate runtime function objects from /inngest/functions/* and /inngest/workflows.ts
 * Filter to valid Inngest functions and deduplicate by function id (keep first seen).
 * Call getConfig with the function as "this" to avoid destructuring errors in some impls.
 */

import * as fnFiles from "./functions";
import * as workflows from "./workflows";

function isInngestFunction(v: any): boolean {
  return !!v && typeof v.getConfig === "function";
}

const fileFns = Object.values(fnFiles).filter(isInngestFunction) as any[];
const workflowFns = Object.values(workflows).filter(isInngestFunction) as any[];

// build map by id to dedupe (keep first seen)
const seen = new Map<string, any>();
for (const fn of [...fileFns, ...workflowFns]) {
  try {
    // Call getConfig with explicit `this` to support implementations that rely on it
    const cfg = typeof fn.getConfig === "function" ? fn.getConfig.call(fn) : undefined;
    const id = cfg?.id || cfg?.name || (fn && fn.name) || undefined;
    if (!id) continue;
    if (!seen.has(id)) {
      seen.set(id, fn);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`inngest/index: duplicate function id "${id}" skipped (one already registered)`);
    }
  } catch (err) {
    // ignore items that fail to report config
    // eslint-disable-next-line no-console
    console.warn("inngest/index: skipping non-conforming export", err?.message ?? err);
  }
}

export const functions = Array.from(seen.values());
