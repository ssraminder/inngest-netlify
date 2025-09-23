// app/api/inngest/route.ts
import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";

// ⬇️ make this a **static** import, not dynamic
import { functions as workflowFunctions } from "@/inngest/workflows";

// ⬇️ include ALL functions you want to expose; spread arrays if you have more
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...workflowFunctions],
});
