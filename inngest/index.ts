/**
 * inngest/index.ts
 * Consolidate runtime function objects from /inngest/functions/* and /inngest/workflows.ts
 * Strategy:
 * 1) Collect functions exported from inngest/functions (fileFns).
 * 2) Prefer an explicit `functions` array exported by ./workflows (workflowFns), if present.
 * 3) Otherwise fall back to collecting workflow exports individually (with safe getConfig.call).
 * 4) Deduplicate by runtime id (keep first seen).
 */

import * as fnFiles from "./functions";
import * as workflows from "./workflows";

function isInngestFunction(v: any): boolean {
  return !!v && typeof v.getConfig === "function";
}

const fileFns = Object.values(fnFiles).filter(isInngestFunction) as any[];

// Prefer an explicit exported `functions` array from workflows.ts if available
let workflowFns: any[] = [];

if (Array.isArray((workflows as any).functions)) {
  // Use the explicit list, but filter to valid Inngest function objects
  workflowFns = (workflows as any).functions.filter(isInngestFunction);
} else {
  // Fallback: collect named exports that look like Inngest functions
  workflowFns = Object.values(workflows).filter(isInngestFunction);
}

// build map by id to dedupe (keep first seen). Call getConfig with .call(fn)
const seen = new Map<string, any>();
for (const fn of [...fileFns, ...workflowFns]) {
  try {
    const cfg = typeof fn.getConfig === "function" ? fn.getConfig.call(fn) : undefined;
    const id = cfg?.id || cfg?.name || (fn && fn.name) || undefined;
    if (!id) continue;
    if (!seen.has(id)) {
      seen.set(id, fn);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`inngest/index: duplicate function id "${id}" skipped (one already registered)`);
    }
  } catch (err: any) {
    // ignore items that fail to report config; log a short message
    // eslint-disable-next-line no-console
    console.warn("inngest/index: skipping non-conforming export", err?.message || String(err));
  }
}

export const functions = Array.from(seen.values());
