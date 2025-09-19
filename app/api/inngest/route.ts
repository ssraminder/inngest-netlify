import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { functions } from "@/inngest/workflows";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});