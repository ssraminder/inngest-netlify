import { NextRequest, NextResponse } from "next/server";
import { getServiceRoleClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";          // avoid Edge
export const dynamic = "force-dynamic";   // never pre-render
export const revalidate = 0;              // no ISR

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const { id } = ctx.params;
  const supabase = getServiceRoleClient();
  // TODO: paste your existing resolve logic that uses `supabase` here
  return NextResponse.json({ ok: true, id });
}

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const { id } = ctx.params;
  const supabase = getServiceRoleClient();
  // TODO: paste any read logic here
  return NextResponse.json({ ok: true, id });
}
