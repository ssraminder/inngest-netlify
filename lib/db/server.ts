// lib/db/server.ts
import { createClient } from "@supabase/supabase-js";

export function sbAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!; // OK if RLS allows inserts via RPC; otherwise swap to service role key
  return createClient(url, key, { auth: { persistSession: false } });
}
