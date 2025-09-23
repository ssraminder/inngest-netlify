/**
 * inngest/index.ts
 * Consolidate runtime function objects from /inngest/functions/* and /inngest/workflows.ts
 * Filter to valid Inngest functions and deduplicate by function id (keep first seen).
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
    const cfg = fn.getConfig?.();
    const id = cfg?.id || cfg?.name || String(cfg);
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
    console.warn("inngest/index: skipping non-conforming export", err);
  }
}

export const functions = Array.from(seen.values());
