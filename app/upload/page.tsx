"use client";

import { useState, type FormEvent } from "react";

export default function UploadPage() {
  const [quoteId, setQuoteId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);

    try {
      const form = event.currentTarget;
      const formData = new FormData(form);

      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const result = await response.json();
      if (!response.ok) {
        setMessage(result?.error ?? "Upload failed");
      } else {
        setMessage(`Uploaded file ${result.file_id} for quote ${result.quote_id}`);
        setQuoteId(String(result.quote_id ?? ""));
        form.reset();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unexpected error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main style={{ padding: "2rem", maxWidth: 480 }}>
      <h1>Upload quote file</h1>
      <form onSubmit={handleSubmit}>
        <label style={{ display: "block", marginBottom: "1rem" }}>
          Quote ID
          <input
            type="number"
            name="quote_id"
            value={quoteId}
            onChange={(event) => setQuoteId(event.target.value)}
            required
            style={{ display: "block", marginTop: "0.25rem", width: "100%" }}
          />
        </label>
        <label style={{ display: "block", marginBottom: "1rem" }}>
          File
          <input type="file" name="file" required style={{ display: "block", marginTop: "0.25rem" }} />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? "Uploading..." : "Upload"}
        </button>
      </form>
      {message ? <p style={{ marginTop: "1rem" }}>{message}</p> : null}
    </main>
  );
}
