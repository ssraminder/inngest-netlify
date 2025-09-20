import { inngest } from "../client";

export const echoFilesUploaded = inngest.createFunction(
  { id: "echo-files-uploaded" },
  { event: "files/uploaded" },
  async ({ event, logger }) => {
    logger.info("echo: files/uploaded", { data: event.data });
    return { ok: true, data: event.data };
  }
);
