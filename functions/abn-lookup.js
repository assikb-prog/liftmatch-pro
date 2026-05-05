// ────────────────────────────────────────────────────────────────────────
//  Noyo — ABR Web Services Proxy
//  /functions/api/abn-lookup.js
//
//  ⚠️  IMPORTANT — DEPLOYED ROUTE NOTE
//  Despite living at /functions/api/abn-lookup.js in the source tree,
//  this function is deployed by Cloudflare Pages at the route:
//        /abn-lookup
//  (NOT /api/abn-lookup). This is because the v131 direct-upload to
//  Cloudflare Pages was done with the contents of /functions/api/
//  rather than /functions/, which collapsed the path one level. The
//  front-end was updated in v131 to call /abn-lookup directly.
//
//  If you re-upload with the correct folder structure later (i.e.
//  drag the /functions/ folder itself into Cloudflare), the route
//  will become /api/abn-lookup — at which point you'd also need to
//  update the front-end fetch URLs in js/app.js back to /api/abn-lookup.
//  Until then, both halves agree on /abn-lookup and ABN verification works.
//
//  Browser side cannot call the Australian Business Register directly:
//   1. ABR Web Services requires a GUID (which must stay server-side).
//   2. ABR endpoints don't return CORS headers for browser fetches anyway.
//
//  This Cloudflare Pages Function runs on the same origin as the SPA,
//  so the browser fetches /abn-lookup?abn=... with no CORS issue.
//  We then call ABR server-side using a stored GUID, parse the JSONP-
//  style response, and return clean JSON to the browser.
//
//  Endpoint:
//      GET /abn-lookup?abn=11_DIGIT_ABN
//
//  Response:
//      { entityName, tradingName, status, type, state, gst }       — found
//      { entityName: null }                                          — not found
//      HTTP 400  { error }                                           — bad input
//      HTTP 503  { error: "ABR proxy not configured" }              — no GUID
//      HTTP 502  { error: "ABR upstream error", detail }            — ABR down
//
//  Setup (one-time):
//   1. Register for a free GUID at:
//        https://abr.business.gov.au/Tools/WebServices
//      (registration is free, takes ~24h to activate)
//   2. In Cloudflare dashboard:
//        Pages → noyo project → Settings → Environment Variables
//        Add: ABR_GUID = <your guid>
//        Set scope: Production (and Preview if you want)
//   3. Redeploy. /abn-lookup will start working.
//
//  Until step 2 is done, the function returns 503 and the front-end
//  falls through to "verify manually" — the registration UX is not
//  blocked.
// ────────────────────────────────────────────────────────────────────────

export async function onRequestGet({ request, env }) {
  // Standard headers we'll attach to every response — short cache so the
  // same ABN doesn't hammer ABR if a customer pastes/un-pastes their ABN.
  const baseHeaders = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=600", // 10 min CDN cache per (abn) URL
  };
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: baseHeaders });

  try {
    // ── Validate input ─────────────────────────────────────────────────
    const url = new URL(request.url);
    const rawAbn = (url.searchParams.get("abn") || "").replace(/\D/g, "");
    if (!/^\d{11}$/.test(rawAbn)) {
      return json(400, { error: "ABN must be exactly 11 digits" });
    }

    // ── Reject if GUID not configured ─────────────────────────────────
    const guid = env.ABR_GUID;
    if (!guid || typeof guid !== "string" || guid.length < 10) {
      return json(503, {
        error:
          "ABR proxy not configured (ABR_GUID env var missing). Set it in Cloudflare Pages → Settings → Environment Variables.",
      });
    }

    // ── Call the ABR Web Services JSON endpoint ───────────────────────
    // AbnDetails returns either JSONP (callback wrapper) or raw JSON.
    // We pass callback=`` to ask for raw JSON and strip the wrapper just
    // in case it comes back JSONP-style.
    const abrUrl =
      "https://abr.business.gov.au/json/AbnDetails.aspx" +
      "?abn=" +
      encodeURIComponent(rawAbn) +
      "&guid=" +
      encodeURIComponent(guid) +
      "&callback=";

    const upstream = await fetch(abrUrl, {
      method: "GET",
      headers: { Accept: "application/json, text/javascript" },
      cf: { cacheTtl: 600, cacheEverything: true },
    });

    if (!upstream.ok) {
      return json(502, {
        error: "ABR upstream error",
        detail: "HTTP " + upstream.status,
      });
    }

    const rawText = await upstream.text();

    // Strip JSONP padding if present: callback({...}) → {...}
    const cleaned = rawText.replace(/^[^{]*/, "").replace(/[^}]*$/, "");
    let abrData;
    try {
      abrData = JSON.parse(cleaned);
    } catch (e) {
      return json(502, {
        error: "ABR returned non-JSON response",
        detail: rawText.slice(0, 200),
      });
    }

    // ── Normalise ABR response to our stable schema ───────────────────
    // ABR JSON fields (typical):
    //   Abn, AbnStatus ("Active"/"Cancelled"),
    //   AbnStatusEffectiveFrom, EntityName, EntityTypeName,
    //   AddressState, AddressPostcode, Gst,
    //   BusinessName: [ ... ]            (array of trading names)
    //   Message: "..."                   (e.g. "Search text is not a valid ABN")
    //
    // Not-found marker: EntityName empty AND a Message saying not valid.
    if (!abrData || !abrData.EntityName || abrData.EntityName === "") {
      return json(200, { entityName: null });
    }

    const tradingName =
      Array.isArray(abrData.BusinessName) && abrData.BusinessName.length
        ? abrData.BusinessName[0]
        : null;

    const result = {
      entityName: abrData.EntityName || null,
      tradingName: tradingName,
      status: abrData.AbnStatus || "Unknown",
      type: abrData.EntityTypeName || "",
      state: abrData.AddressState || "",
      // Gst is sometimes a date string (registered from when), sometimes
      // null — treat any truthy value as "registered".
      gst: !!(abrData.Gst && abrData.Gst !== "null"),
    };

    return json(200, result);
  } catch (err) {
    return json(502, {
      error: "ABR proxy threw an exception",
      detail: (err && err.message) || String(err),
    });
  }
}

// CORS pre-flight — same-origin so this should never fire from the SPA,
// but harmless to handle and helps if you ever proxy from another tool.
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}
