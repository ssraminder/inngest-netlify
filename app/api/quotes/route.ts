// app/api/quotes/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { inngest } from "@/lib/inngest/client";  // step 1 from earlier

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  // If you use RLS with stricter inserts, swap to a server-only SERVICE_ROLE key
);

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // 1) Create the quote (simplified; use your real fields)
    const { data: quoteRow, error: quoteErr } = await supabase
      .from("quotes")
      .insert({
        // ...your fields from body (source_language, target_language, intended_use_id, etc.)
      })
      .select()
      .single();

    if (quoteErr || !quoteRow) {
      return NextResponse.json({ error: "Failed to create quote" }, { status: 400 });
    }

    // IMPORTANT: your quotes PK is an INTEGER column (e.g., "quoteid")
    // Normalize to quoteId variable:
    const quoteId = quoteRow.quoteid ?? quoteRow.id ?? quoteRow.quote_id;

    // 2) Optionally insert files here (if you do it in this route)
    //    If you already inserted files earlier in the flow, you can skip this section.
    let files: Array<{ id?: string; gcsUri: string; filename: string; bytes?: number; mime?: string }> = [];
    if (Array.isArray(body.files) && body.files.length) {
      const rows = body.files.map((f: any) => ({
        quote_id: quoteId,
        gcs_uri: f.gcsUri,          // "gs://cethos-ocr-input/path/yourfile.pdf"
        filename: f.filename,
        bytes: f.bytes ?? null,
        mime: f.mime ?? null,
        status: "uploaded",
      }));

      const { data: insertedFiles, error: filesErr } = await supabase
        .from("quote_files")
        .insert(rows)
        .select(); // returns rows with the generated UUID "id"
      if (filesErr) {
        // Not fatal for user flow; we can still emit with empty files array
        console.warn("[quotes] file insert failed (non-fatal):", filesErr.message);
      } else {
        files = insertedFiles.map((r: any) => ({
          id: r.id,
          gcsUri: r.gcs_uri,
          filename: r.filename,
          bytes: r.bytes ?? undefined,
          mime: r.mime ?? undefined,
        }));
      }
    } else {
      // If you didn’t insert files here, you can pass [] and let the workflow look them up by quoteId
      files = [];
    }

    // 3) Emit the background event (non-blocking for the user)
    try {
      await inngest.send({
        name: "quote/created",
        data: {
          quoteId, // integer in your DB
          files,   // [] is fine; workflow can fetch by quoteId
        },
      });
    } catch (e) {
      // Do not leak secrets; keep it generic
      console.warn("[quote.created] event send failed (non-fatal)");
    }

    // 4) Return the newly created quote info to the client
    return NextResponse.json({ quoteId, quote: quoteRow }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
