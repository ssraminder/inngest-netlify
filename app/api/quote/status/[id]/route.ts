export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { sbAdmin } from "../../../../../lib/db/server";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const quoteId = Number(params.id);
  const supabase = sbAdmin();

  const { data: files } = await supabase
    .from("quote_files")
    .select("status")
    .eq("quote_id", quoteId);
  if (!files || files.some((f) => f.status !== "ocr_complete")) {
    return NextResponse.json({ stage: "ocr" });
  }

  const { data: gj } = await supabase
    .from("glm_jobs")
    .select("status")
    .eq("quote_id", quoteId)
    .maybeSingle();
  if (!gj || gj.status === "started") {
    return NextResponse.json({ stage: "analysis" });
  }

  const { data: q } = await supabase
    .from("quotes")
    .select("status")
    .eq("quoteid", quoteId)
    .maybeSingle();

  if (q?.status === "hitl") return NextResponse.json({ stage: "hitl" });
  if (q?.status === "ready") return NextResponse.json({ stage: "ready" });

  return NextResponse.json({ stage: "pricing" });
}
