// lib/inngest/client.ts
import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "cethos-quote-platform",       // stable, lowercase, no spaces
  name: "Cethos Quote Platform",     // nice human-readable label
  eventKey: process.env.INNGEST_SIGNING_KEY,
});
