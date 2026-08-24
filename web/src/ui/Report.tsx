/**
 * Report flow UI (protocol §9, M7): a reusable inline dialog used by
 * Profile ("Report account"), Feed/Posts ("Report" on a rendered post — no
 * plaintext, ever, for public content), and Messages ("Decline & report" in
 * the DM request tray, plus scoped-post reports — both pass `plaintext`,
 * the recipient's own decrypted copy of an encrypted record, per §9.2).
 *
 * When `plaintext` is supplied this is the one place that copy leaves the
 * device: the dialog gates it behind an explicit consent screen — quote the
 * text, state plainly what happens, require an explicit checkbox — never
 * submitted silently. Mirrors docs/explainers tone: this is the reporter's
 * own copy and their right as a recipient to share it, made accountable.
 *
 * Reports are private end-to-end (protocol §9.1): the subject is never told
 * who reported them, and this UI never claims otherwise.
 */
import { useState } from "react";
import { REPORT_COMMENT_MAX, REPORT_REASONS, type ReportReason } from "@runa/core";
import { ApiError } from "../api/client.js";
import { submitReport } from "../moderation/report.js";
import { shortId, styles } from "./theme.js";
import type { Session } from "./session.js";

const REASON_LABELS: Record<ReportReason, string> = {
  spam: "Spam",
  harassment: "Harassment",
  illegal: "Illegal content",
  other: "Other",
};

type Step = "form" | "confirm" | "submitting" | "done" | "error";

export function ReportDialog({
  session,
  subject,
  record,
  plaintext,
  contentLabel = "content",
  onClose,
  onSubmitted,
}: {
  session: Session;
  /** Account being reported. */
  subject: string;
  /** The specific record complained about, if any. */
  record?: string;
  /**
   * The reporter's own decrypted copy of `record` (dm or scoped-post only,
   * protocol §9.2). Never pass this for a public post — the server rejects
   * plaintext on any record type other than dm/scoped-post, and the point of
   * public content is that there's nothing to forward.
   */
  plaintext?: string;
  /** What to call `plaintext` in the consent copy — "message", "post", … */
  contentLabel?: string;
  onClose: () => void;
  onSubmitted?: () => void;
}) {
  const [step, setStep] = useState<Step>("form");
  const [reason, setReason] = useState<ReportReason>("spam");
  const [comment, setComment] = useState("");
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setStep("submitting");
    setError(null);
    try {
      await submitReport(session.root.account, session.device, {
        subject,
        record,
        reason,
        comment,
        plaintext,
      });
      setStep("done");
      onSubmitted?.();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e),
      );
      setStep("error");
    }
  };

  if (step === "done") {
    return (
      <div style={styles.noticeCard}>
        <strong>Report sent.</strong>
        <div style={{ marginTop: "0.25rem" }}>
          Thank you — this is only visible to the instance operator, never to the reported account or
          anyone else.
        </div>
        <button style={{ ...styles.button, marginTop: "0.5rem" }} onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <h4 style={{ marginTop: 0 }}>Report {shortId(subject)}</h4>

      {step === "form" && (
        <>
          <div style={{ display: "grid", gap: "0.35rem", marginBottom: "0.75rem" }}>
            {REPORT_REASONS.map((r) => (
              <label key={r} style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <input type="radio" name="report-reason" checked={reason === r} onChange={() => setReason(r)} />
                {REASON_LABELS[r]}
              </label>
            ))}
          </div>
          <textarea
            style={styles.textarea}
            rows={3}
            placeholder="Optional comment for the reviewer…"
            value={comment}
            maxLength={REPORT_COMMENT_MAX}
            onChange={(e) => setComment(e.target.value)}
          />
          <p style={{ ...styles.muted, marginTop: "0.25rem" }}>
            {comment.length}/{REPORT_COMMENT_MAX}
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button style={styles.primaryButton} onClick={() => setStep("confirm")}>
              Continue
            </button>
            <button style={styles.button} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}

      {(step === "confirm" || step === "submitting") && (
        <>
          {plaintext !== undefined ? (
            <div style={styles.noticeCard}>
              <strong>This forwards your copy of this {contentLabel}</strong>
              <div style={{ marginTop: "0.35rem" }}>
                Declining with a report sends the instance operator <em>your own decrypted copy</em> of
                this {contentLabel} for review, along with your reason. This is the one place your
                decrypted content leaves this device. It's your copy and your right as a recipient to
                share it — this is just its accountable form. The sender is never told you reported
                them.
              </div>
              <div
                style={{
                  ...styles.mono,
                  whiteSpace: "pre-wrap",
                  marginTop: "0.5rem",
                  padding: "0.5rem",
                  background: "#fff",
                  border: "1px solid #b8cfe8",
                  borderRadius: 6,
                  maxHeight: 200,
                  overflowY: "auto",
                }}
              >
                {plaintext}
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginTop: "0.5rem" }}>
                <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} />
                I understand this forwards my decrypted copy of this {contentLabel} to the instance
                operator for review.
              </label>
            </div>
          ) : (
            <p style={styles.muted}>
              Send this report to the instance operator? It is never shown to the reported account or
              anyone else.
            </p>
          )}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              style={styles.primaryButton}
              disabled={step === "submitting" || (plaintext !== undefined && !consented)}
              onClick={() => submit()}
            >
              {step === "submitting" ? "Sending…" : "Send report"}
            </button>
            <button style={styles.button} disabled={step === "submitting"} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}

      {step === "error" && (
        <>
          <p style={{ color: "crimson" }}>Could not send report: {error}</p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button style={styles.primaryButton} onClick={() => setStep("confirm")}>
              Try again
            </button>
            <button style={styles.button} onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Low-prominence trigger for post-level reports (Feed/Posts/PostPage): a
 * muted text link, matching the "view thread" affordance style — never a
 * primary button, since reporting is a secondary action on someone else's
 * content. `buildReport`'s self-report guard means this is simply omitted
 * for the viewer's own posts by every call site.
 */
export function ReportLink({ onClick }: { onClick: () => void }) {
  return (
    <a
      href="#"
      style={styles.muted}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      Report
    </a>
  );
}
