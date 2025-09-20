//  lib/inngest/client.ts
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "cethos-quote-platform",      // stable, lowercase, no spaces
  name: "Cethos Quote Platform",    // human-friendly label for dashboard/logs
  eventKey: process.env.INNGEST_SIGNING_KEY,
});
