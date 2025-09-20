import { serve } from "inngest/netlify";
import { Inngest } from "inngest";

// If you already have a shared client, import it instead.
// Example: import { inngest } from "../../lib/inngest";
const inngest = new Inngest({ name: "cethos-inngest-app" });

// Re-export all your functions from /inngest/functions/index.ts
import * as fns from "../../inngest/functions";

export const handler = serve({
  client: inngest,
  functions: Object.values(fns),
});
