export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { sbAdmin } from "../../../../../lib/db/server";
import { inngest } from "../../../../../lib/inngest/client";



export async function POST(_: Request, { params }: { params: { id: string } }) {
  const quoteId = Number(params.id);
  const supabase = sbAdmin();

  await supabase.from("quotes").update({ status: "hitl" }).eq("quoteid", quoteId);

  // optional: emit for ops queue
  await inngest.send({ name: "quote/manual-review-required", data: { quote_id: quoteId, reason: "user_requested" } });

  return NextResponse.json({ ok: true, quote_id: quoteId });
}
