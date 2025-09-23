import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { functions as inngestFunctions } from "@/inngest";

if (!Array.isArray(inngestFunctions) || inngestFunctions.length === 0) {
  // eslint-disable-next-line no-console
  console.warn("inngest: workflows array is empty or not exported. Check /inngest index.");
}

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...inngestFunctions],
});
