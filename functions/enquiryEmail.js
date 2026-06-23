/**
 * ════════════════════════════════════════════════════════════════════════
 *  Noyo — Enquiry → Email (Resend) Cloud Function
 *  ----------------------------------------------------------------------
 *  Fires automatically whenever the front-end writes a new document to the
 *  Firestore `enquiries` collection, and emails the lead to you via Resend.
 *
 *  Why a Firestore trigger (not a client call)?
 *   • The lead is already saved before this runs — email is a pure side
 *     effect, so a mail failure never loses a lead.
 *   • Server-side: doesn't depend on the customer's browser staying open.
 *   • Uses your DKIM-authenticated noyo.com.au domain on Resend → inbox,
 *     not spam. No BCC blasting.
 *
 *  ── SETUP (one-time) ───────────────────────────────────────────────────
 *  1. In your functions/ folder, make sure package.json has:
 *        "firebase-functions": "^5.0.0",
 *        "firebase-admin": "^12.0.0"
 *     (Node 18+ has global fetch, so no 'resend' package needed.)
 *
 *  2. Store your Resend API key as a secret (you enter it — never in code):
 *        firebase functions:secrets:set RESEND_API_KEY
 *
 *  3. Paste this file's contents into functions/index.js (or import it).
 *
 *  4. Set the two addresses below (TO_EMAIL / FROM_EMAIL).
 *
 *  5. Deploy:
 *        npx firebase deploy --only functions:emailNewEnquiry --project liftmatchpro-e3c7b
 *
 *  FROM_EMAIL must be on a domain you've verified in Resend (noyo.com.au is
 *  already DKIM'd), e.g. "Noyo Enquiries <enquiries@noyo.com.au>".
 * ════════════════════════════════════════════════════════════════════════
 */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// ── Configure these two ──────────────────────────────────────────────────
const TO_EMAIL = "sales@noyo.com.au"; // ← where leads land
const FROM_EMAIL = "Noyo Enquiries <enquiries@noyo.com.au>"; // verified Resend domain

exports.emailNewEnquiry = onDocumentCreated(
  {
    document: "enquiries/{enquiryId}",
    region: "us-central1",
    secrets: [RESEND_API_KEY],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() || {};
    const id = event.params.enquiryId;

    const isHire = d.intent === "hire";
    const line = (label, val) =>
      val ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b;font-weight:600;white-space:nowrap">${label}</td><td style="padding:4px 0;color:#0f172a">${escapeHtml(val)}</td></tr>` : "";

    const attach =
      Array.isArray(d.attachmentsNeeded) && d.attachmentsNeeded.length
        ? d.attachmentsNeeded.join(", ")
        : "";

    const jr = d.jobRequirements || {};
    const jrLines = Object.keys(jr)
      .map((k) => line(prettify(k), formatVal(jr[k])))
      .join("");

    const subject = `${isHire ? "🔧 HIRE" : "🏷️ BUY"} enquiry — ${d.machineName || "machine"} — ${d.name || "customer"}`;

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
        <div style="background:#0052CC;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
          <div style="font-size:13px;opacity:.85;font-weight:700;letter-spacing:.05em">NEW ${isHire ? "HIRE" : "BUY"} ENQUIRY</div>
          <div style="font-size:18px;font-weight:800;margin-top:2px">${escapeHtml(d.machineName || "—")}</div>
        </div>
        <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:18px 20px">
          <table style="border-collapse:collapse;font-size:14px;line-height:1.5">
            ${line("Name", d.name)}
            ${line("Company", d.company)}
            ${line("Email", d.email)}
            ${line("Phone", d.phone)}
            ${line("Intent", isHire ? "Hire" : "Buy")}
            ${line("Machine", d.machineName)}
            ${line("Category", d.machineCategory)}
            ${isHire ? line("Site address", d.siteAddress) : ""}
            ${isHire ? line("Needed from", d.neededDate) : ""}
            ${isHire ? line("Duration", d.duration) : ""}
            ${isHire ? line("Attachments", attach) : ""}
            ${isHire ? line("Delivery/pickup", d.deliveryPickup) : ""}
            ${!isHire ? line("When buying", d.buyWhen) : ""}
            ${!isHire ? line("New/used", d.condition) : ""}
            ${!isHire ? line("Budget", d.budget) : ""}
            ${!isHire ? line("Finance", d.financeNeeded) : ""}
            ${!isHire ? line("Delivery location", d.deliveryLocation) : ""}
            ${line("Message", d.message)}
          </table>
          ${jrLines ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid #f1f5f9"><div style="font-size:12px;font-weight:800;color:#64748b;margin-bottom:6px">JOB SPEC (from search)</div><table style="border-collapse:collapse;font-size:13px;line-height:1.5">${jrLines}</table></div>` : ""}
          <div style="margin-top:16px">
            <a href="mailto:${escapeHtml(d.email || "")}?subject=Re: your Noyo enquiry"
               style="display:inline-block;background:#0052CC;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:10px 18px;border-radius:9px">Reply to ${escapeHtml(d.name || "customer")}</a>
          </div>
          <div style="margin-top:14px;font-size:11px;color:#94a3b8">Enquiry ID: ${id} · saved to Firestore enquiries</div>
        </div>
      </div>`;

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY.value()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [TO_EMAIL],
          reply_to: d.email || undefined,
          subject,
          html,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        console.error("[Noyo] Resend send failed:", res.status, t);
      } else {
        console.log("[Noyo] Enquiry email sent for", id);
      }
    } catch (err) {
      console.error("[Noyo] Enquiry email error:", err && err.message);
    }
  }
);

// ── helpers ──────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function prettify(k) {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
}
function formatVal(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return v;
}
