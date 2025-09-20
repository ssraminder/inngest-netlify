export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { sbAdmin } from "../../../../../lib/db/server";
import { inngest } from "../../../../../lib/inngest/client";



export async function POST(req: Request, { params }: { params: { id: string } }) {
  const quoteId = Number(params.id);
  const supabase = sbAdmin();
  const body = await req.json().catch(() => ({} as any));

  // Optional: accept corrections from PM
  // { complexity?: "Easy"|"Medium"|"Hard"; doc_type?: string|null; country_of_issue?: string|null; billable_words?: number|null; names?: string[] }
  // You can persist them into glm_pages (roll-up) or an admin_notes table if you prefer.

  // Clear HITL and let frontend re-submit quote/submitted or trigger a small resumable event here.
  await supabase.from("quotes").update({ status: "analysis_ok" }).eq("quoteid", quoteId);

  // kick pricing again via event (your Step-3 submit can also do this)
  await inngest.send({ name: "quote/submitted", data: { quote_id: quoteId, intended_use: "general", languages: [], billing: { country: "CA", currency: "CAD" } } });

  return NextResponse.json({ ok: true, quote_id: quoteId });
}
