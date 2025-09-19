// app/api/quotes/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "../../../lib/inngest/client";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // 1) Insert the quote (use your real fields)
    const { data: quoteRow, error: quoteErr } = await supabase
      .from("quotes")
      .insert({
        // ... map fields from body ...
      })
      .select()
      .single();

    if (quoteErr || !quoteRow) {
      return NextResponse.json({ error: "Failed to create quote" }, { status: 400 });
    }

    // Your quotes PK is integer (e.g., quoteid)
    const quoteId = quoteRow.quoteid ?? quoteRow.id ?? quoteRow.quote_id;

    // 2) If you also insert quote_files here, do it now and collect file rows; otherwise leave [].
    const files: Array<{ id?: string; gcsUri?: string; filename?: string; bytes?: number; mime?: string }> = [];

    // 3) Emit background event (non-blocking)
    try {
      await inngest.send({
        name: "quote/created",
        data: { quoteId, files },
      });
    } catch {
      console.warn("[quote.created] event send failed (non-fatal)");
    }

    // 4) Respond to client
    return NextResponse.json({ quoteId, quote: quoteRow }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
