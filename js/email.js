/**
 * js/email.js — Noyo email helper module
 * ============================================================
 *
 * Sends emails by writing template-based documents into the `mail`
 * Firestore collection. The Firebase "Trigger Email" extension
 * picks them up and sends via Resend SMTP.
 *
 * Templates referenced live in the `email_templates` Firestore
 * collection — see install-email-templates-v2.html.
 *
 * Public functions:
 *   emailQuoteRequestReceived(enquiry)
 *   emailQuoteAcceptedCustomer(enquiry, winningQuote)
 *   emailQuoteAcceptedSupplier(enquiry, winningQuote, supplierEmail)
 *
 * Cloud Functions handle the rest (new-job-to-supplier,
 * quote-response-received, expiry, reminder, daily summary).
 *
 * Requires: firebase-firestore (compat or modular). Auto-detects.
 * ============================================================ */

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // Firestore handle (auto-detect compat vs modular SDK)
  // ─────────────────────────────────────────────────────────────
  function getDb() {
    if (typeof firebase !== 'undefined' && firebase.firestore) {
      return firebase.firestore();
    }
    if (window.db) return window.db;
    if (window.firestoreDb) return window.firestoreDb;
    console.error('[Noyo email] Firestore handle not found. Expected `firebase.firestore()` or `window.db`.');
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // Core: write a template-based message to the mail collection
  // ─────────────────────────────────────────────────────────────
  async function sendMail(templateName, recipientEmail, templateData) {
    if (!recipientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipientEmail)) {
      console.warn('[Noyo email] Skipped — invalid recipient:', recipientEmail);
      return null;
    }

    const db = getDb();
    if (!db) return null;

    const payload = {
      to: recipientEmail,
      template: {
        name: templateName,
        data: templateData || {}
      },
      _noyo: {
        createdAt: new Date().toISOString(),
        templateName: templateName
      }
    };

    try {
      // Compat SDK
      if (db.collection) {
        const ref = await db.collection('mail').add(payload);
        console.log('[Noyo email] Queued:', templateName, '→', recipientEmail, 'doc:', ref.id);
        return ref.id;
      }
      // Modular SDK fallback (rare in vanilla apps)
      if (window.firebase_firestore && window.firebase_firestore.addDoc) {
        const colRef = window.firebase_firestore.collection(db, 'mail');
        const ref = await window.firebase_firestore.addDoc(colRef, payload);
        console.log('[Noyo email] Queued:', templateName, '→', recipientEmail, 'doc:', ref.id);
        return ref.id;
      }
      console.error('[Noyo email] Could not find a way to write to Firestore.');
      return null;
    } catch (e) {
      console.error('[Noyo email] Failed to queue', templateName, '→', recipientEmail, e);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────
  async function lookupCustomerName(email, fallback) {
    if (!email) return fallback || 'there';
    try {
      const db = getDb();
      if (!db || !db.collection) return fallback || (email.split('@')[0] || 'there');
      const snap = await db.collection('users').where('email', '==', email).limit(1).get();
      if (!snap.empty) {
        const u = snap.docs[0].data();
        if (u.fullName) return u.fullName;
      }
    } catch (e) {
      console.warn('[Noyo email] User lookup failed:', e.message);
    }
    return fallback || (email.split('@')[0] || 'there');
  }

  function formatMachineList(machines) {
    if (!Array.isArray(machines) || !machines.length) return 'machines';
    return machines.map(m => {
      const qty = m.quantity > 1 ? `${m.quantity}× ` : '';
      return `${qty}${m.name || 'Unnamed machine'}`;
    }).join(', ');
  }

  function getMachineCount(machines) {
    if (!Array.isArray(machines)) return 0;
    return machines.reduce((sum, m) => sum + (m.quantity || 1), 0);
  }

  function getDurationLabel(machines) {
    // Pick the longest duration across machines (rough but useful)
    if (!Array.isArray(machines) || !machines.length) return 'Not specified';
    const durations = machines.map(m => m.duration).filter(Boolean);
    if (!durations.length) return 'Not specified';
    return durations[0].replace(/-/g, ' ');
  }

  function formatExpiry(tsMs) {
    if (!tsMs) return 'soon';
    try {
      const d = new Date(Number(tsMs));
      return d.toLocaleString('en-AU', {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: 'Australia/Brisbane'
      });
    } catch (e) {
      return 'soon';
    }
  }

  function formatMoney(value) {
    if (value === null || value === undefined) return 'Quote pending';
    if (typeof value === 'string' && value.includes('$')) return value;
    const num = Number(value);
    if (isNaN(num)) return String(value);
    return '$' + num.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' inc. GST';
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Quote request received — to the customer
  //    Call right after the enquiry is written to shared_enquiries
  // ─────────────────────────────────────────────────────────────
  async function emailQuoteRequestReceived(enquiry) {
    if (!enquiry || !enquiry.email) {
      console.warn('[Noyo email] No enquiry email — skipping quote_request_received');
      return null;
    }

    const customerName = await lookupCustomerName(enquiry.email, enquiry.customer);
    const count = getMachineCount(enquiry.machines);

    return sendMail('quote_request_received', enquiry.email, {
      customerName: customerName,
      quoteRef: enquiry.ref || enquiry.id || 'your enquiry',
      machineCount: String(count),
      machineWord: count === 1 ? 'machine' : 'machines',
      suburb: enquiry.suburb || enquiry.city || 'your area',
      state: enquiry.state || '',
      expiryDate: formatExpiry(enquiry.expires)
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Quote accepted — to the customer (booking confirmation)
  //    Call right after acceptedBy is set on the enquiry
  // ─────────────────────────────────────────────────────────────
  async function emailQuoteAcceptedCustomer(enquiry, winningQuote) {
    if (!enquiry || !enquiry.email) {
      console.warn('[Noyo email] No enquiry email — skipping quote_accepted_customer');
      return null;
    }

    const customerName = await lookupCustomerName(enquiry.email, enquiry.customer);
    const supplierCompany = (winningQuote && winningQuote.company) || enquiry.acceptedBy || 'the rental company';
    const total = winningQuote && (winningQuote.price || winningQuote.grandTotal);

    return sendMail('quote_accepted_customer', enquiry.email, {
      customerName: customerName,
      supplierCompany: supplierCompany,
      quoteRef: enquiry.ref || enquiry.id || '',
      quoteTotal: formatMoney(total),
      siteAddress: enquiry.siteAddress || `${enquiry.suburb || ''}, ${enquiry.state || ''}`,
      supplierContact: (winningQuote && winningQuote.contactInfo) || `${supplierCompany} (contact details to follow)`
    });
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Quote accepted — to the supplier (you won the job)
  //    Call right after acceptedBy is set, supplier email looked up
  // ─────────────────────────────────────────────────────────────
  async function emailQuoteAcceptedSupplier(enquiry, winningQuote, supplierEmail, supplierName) {
    if (!supplierEmail) {
      console.warn('[Noyo email] No supplier email — skipping quote_accepted_supplier');
      return null;
    }

    const customerName = await lookupCustomerName(enquiry.email, enquiry.customer);
    const total = winningQuote && (winningQuote.price || winningQuote.grandTotal);

    return sendMail('quote_accepted_supplier', supplierEmail, {
      supplierName: supplierName || (winningQuote && winningQuote.company) || 'there',
      quoteRef: enquiry.ref || enquiry.id || '',
      customerName: customerName,
      customerEmail: enquiry.email || '',
      customerMobile: enquiry.mobile || 'not provided',
      siteAddress: enquiry.siteAddress || `${enquiry.suburb || ''}, ${enquiry.state || ''}`,
      machineList: formatMachineList(enquiry.machines),
      duration: getDurationLabel(enquiry.machines),
      quoteTotal: formatMoney(total)
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Public surface
  // ─────────────────────────────────────────────────────────────
  window.NoyoEmail = {
    sendMail,
    emailQuoteRequestReceived,
    emailQuoteAcceptedCustomer,
    emailQuoteAcceptedSupplier,
    // Helpers exposed for testing
    _helpers: {
      lookupCustomerName,
      formatMachineList,
      getMachineCount,
      getDurationLabel,
      formatExpiry,
      formatMoney
    }
  };

  console.log('[Noyo email] Module loaded — NoyoEmail available on window.');
})();
