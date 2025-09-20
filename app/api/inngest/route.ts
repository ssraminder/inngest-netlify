// app/api/inngest/route.ts
import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";

// Import the list exported by your workflows file
import { functions as workflowFunctions } from "@/inngest/workflows";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: workflowFunctions,
});
