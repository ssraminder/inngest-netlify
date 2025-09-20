import type { SupabaseClient } from "@supabase/supabase-js";

export type Currency = "CAD" | "USD";

export interface PricingPolicy {
  currency: Currency;
  pageWordDivisor: number;
  roundingThreshold: number;

  baseRates: Record<string, number>;
  tiers: Record<"A" | "B" | "C" | "D" | "default", number>;
  languageTierMap: Record<string, "A" | "B" | "C" | "D" | "default">;

  complexity: Record<"Easy" | "Medium" | "Hard", number>;

  certifications: Record<string, number>;
  shipping: Record<string, number>;

  tax: {
    hst: Record<string, number | boolean>;
    gstOnly: Record<string, boolean>;
    defaultGST: number;
  };

  rush: {
    percent: number;
    same_day: {
      eligibility: Array<{
        doc_type: string;
        country_of_issue?: string;
        countryOfIssue?: string;
        preset_base?: number;
      }>;
    };
  };

  extraLanguagePct: number;
}

// Safe defaults to satisfy type-checking even if DB/env has gaps
export const defaultPolicy: PricingPolicy = {
  currency: (process.env.CURRENCY as Currency) || "CAD",
  pageWordDivisor: Number(process.env.PAGE_WORD_DIVISOR ?? 300),
  roundingThreshold: Number(process.env.ROUNDING_THRESHOLD ?? 0.4),

  baseRates: { default: Number(process.env.BASE_RATE_CAD ?? 0.18) },
  tiers: { A: 1.0, B: 1.1, C: 1.25, D: 1.5, default: 1.0 },
  languageTierMap: {},

  complexity: { Easy: 1.0, Medium: 1.1, Hard: 1.25 },

  certifications: {},

  shipping: {},

  tax: {
    hst: {},
    gstOnly: {},
    defaultGST: Number(process.env.DEFAULT_GST ?? 0.05),
  },

  rush: {
    percent: Number(process.env.RUSH_PERCENT ?? 0.25),
    same_day: { eligibility: [] },
  },

  extraLanguagePct: Number(process.env.EXTRA_LANGUAGE_PCT ?? 0.1),
};

// Deep-ish merge that preserves nested objects
function mergeDeep<T extends Record<string, any>>(base: T, patch: Partial<T>): T {
  const out: any = { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = (patch as any)[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = mergeDeep(base[k] ?? {}, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function ensurePolicy(input?: Partial<PricingPolicy>): PricingPolicy {
  return mergeDeep(defaultPolicy, input ?? {});
}

// Keep call sites flexible: accept any args and return Partial
export async function loadPolicy(..._args: any[]): Promise<Partial<PricingPolicy>> {
  // Prefer JSON injected at build time if present
  try {
    const fromJson = process.env.PRICING_POLICY_JSON
      ? JSON.parse(process.env.PRICING_POLICY_JSON)
      : {};
    return fromJson;
  } catch {
    return {};
  }
}
