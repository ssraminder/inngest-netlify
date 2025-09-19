// lib/db/server.ts
import { createClient } from "@supabase/supabase-js";

export function sbAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  // If RLS requires elevated privileges for these inserts, use a service role:
  // const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}