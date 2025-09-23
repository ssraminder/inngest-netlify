/**
 * inngest/constants.ts
 * Source of truth for Inngest function IDs and environment variables.
 * Import from here instead of hardcoding in functions/workflows.
 */

/**
 * Canonical Inngest Function IDs
 * (must match exactly what is registered in Inngest Cloud)
 */
export const FN_IDS = {
  COMPUTE_PRICING_SHIM: "cethos-quote-platform-compute-pricing",
  COMPUTE_PRICING: "compute-pricing",
  GEMINI_ANALYZE: "gemini-analyze",
  OCR_DOCUMENT: "ocr-document",
  PROCESS_UPLOAD: "process-upload",
  QUOTE_CREATED_PREPARE_JOBS: "quote-created-prepare-jobs",
  ECHO_FILES_UPLOADED: "echo-files-uploaded",
} as const;

/**
 * Environment Variable Names
 * (keep this list in sync with Netlify + local .env)
 */
export const ENV_VARS = {
  // Supabase
  SUPABASE_URL: "SUPABASE_URL",
  SUPABASE_SERVICE_ROLE_KEY: "SUPABASE_SERVICE_ROLE_KEY",
  SUPABASE_ANON_KEY: "SUPABASE_ANON_KEY",

  // Google Cloud (OCR / Document AI)
  GOOGLE_PROJECT_ID: "GOOGLE_PROJECT_ID",
  GOOGLE_APPLICATION_CREDENTIALS: "GOOGLE_APPLICATION_CREDENTIALS",
  GOOGLE_LOCATION: "GOOGLE_LOCATION", // e.g., us, us-central1
  GOOGLE_PROCESSOR_ID: "GOOGLE_PROCESSOR_ID", // Document AI processor

  // Gemini / Generative AI
  GEMINI_API_KEY: "GEMINI_API_KEY",

  // Brevo (Transactional email)
  BREVO_API_KEY: "BREVO_API_KEY",

  // Pricing + App Config
  BASE_RATE_CAD: "BASE_RATE_CAD",
  EXTRA_PAGE_RATE_CAD: "EXTRA_PAGE_RATE_CAD",

  // Optional: other services
  OPENAI_API_KEY: "OPENAI_API_KEY", // if used
  STRIPE_SECRET_KEY: "STRIPE_SECRET_KEY", // if/when payments are added
} as const;
