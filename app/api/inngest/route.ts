export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { serve } from "inngest/next";
// IMPORTANT: do not create Supabase clients at module scope here.
// Your workflows can call sbAdmin() inside step.run() bodies.
import { inngest } from "../../../lib/inngest/client";
import { functions } from "../../../inngest/workflows";

export const { GET, POST, PUT } = serve({ client: inngest, functions });
