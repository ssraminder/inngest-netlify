*** Begin Patch
*** Update File: app/api/inngest/route.ts
@@
-import { serve } from "inngest/next";
-import { inngest } from "@/lib/inngest/client";
-
-// Import unified list (deduped) from inngest/index.ts
-import { functions as inngestFunctions } from "@/inngest";
-
-export const { GET, POST, PUT } = serve({
-  client: inngest,
-  functions: inngestFunctions,
-});
+import { serve } from "inngest/next";
+import { inngest } from "@/lib/inngest/client";
+
+// statically import the workflows list so Next.js / Netlify build can bundle them
+import { functions as inngestFunctions } from "@/inngest"; // ensure this path exists and exports `functions`
+
+if (!Array.isArray(inngestFunctions) || inngestFunctions.length === 0) {
+  // keep this guard; it helps debug empty exports during CI builds
+  // eslint-disable-next-line no-console
+  console.warn("inngest: workflows array is empty or not exported. Check /inngest index.");
+}
+
+export const { GET, POST, PUT } = serve({
+  client: inngest,
+  functions: [...inngestFunctions],
+});
*** End Patch
