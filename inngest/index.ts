/**
 * inngest/index.ts
 * Consolidate runtime function objects from /inngest/functions/* and /inngest/workflows.ts
 * Only export items that look like Inngest function objects (they expose getConfig()).
 */

import * as fnFiles from "./functions";
import * as workflows from "./workflows";

function isInngestFunction(v: any): boolean {
  return !!v && typeof v.getConfig === "function";
}

const fileFns = Object.values(fnFiles).filter(isInngestFunction) as any[];
const workflowFns = Object.values(workflows).filter(isInngestFunction) as any[];

// Export combined list — order: fileFns then workflowFns
export const functions = [...fileFns, ...workflowFns];
