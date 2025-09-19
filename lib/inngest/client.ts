import { Inngest } from "inngest";

// Option A: give your app a stable ID (recommended)
export const inngest = new Inngest({
  id: "cethos-quote-platform",
});

// Option B: if you don't care about naming, you can also do:
// export const inngest = new Inngest();
