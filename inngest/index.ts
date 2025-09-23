/**
 * inngest/index.ts
 *
 * Collect likely Inngest function objects without invoking getConfig at build time.
 * Strategy:
 *  - Collect exports from /inngest/functions and from ./workflows (prefer explicit workflows.functions).
 *  - Filter for likely function objects (function or has getConfig property) WITHOUT calling getConfig.
 *  - Deduplicate by reference (keep first seen).
 */

import * as fnFiles from "./functions";
import * as workflows from "./workflows";

const isLikelyFn = (v: any) => !!v && (typeof v === "function" || typeof v?.getConfig === "function");

// collect from functions folder (filter conservatively)
const fileFns = Object.values(fnFiles).filter(isLikelyFn) as any[];

// prefer explicit workflows.functions if present
let workflowFns: any[] = [];
if (Array.isArray((workflows as any).functions)) {
  workflowFns = (workflows as any).functions.filter(isLikelyFn);
} else {
  workflowFns = Object.values(workflows).filter(isLikelyFn);
}

// dedupe by reference (no getConfig calls here)
const seen = new Set<any>();
const combined: any[] = [];
for (const fn of [...fileFns, ...workflowFns]) {
  if (!seen.has(fn)) {
    seen.add(fn);
    combined.push(fn);
  }
}

export const functions = combined;
