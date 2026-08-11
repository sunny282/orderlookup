/**
 * netlify/functions/order-lookup.js
 *
 * Server-side only. Handles:
 *   1. Logging into the Oman Broadband CRM (bss.omanbroadband.om)
 *   2. Maintaining the CRM session (cookies) for a single request lifecycle
 *   3. Looking up an order by ID
 *   4. Returning ONLY the sanitized fields the frontend needs
 *
 * IMPORTANT — READ THIS FIRST
 * ----------------------------------------------------------------------
 * This function was built from a description of CRM requests captured via
 * browser DevTools, not from a live integration test against the CRM.
 * The exact HTML structure of the login page (where the CSRF token lives),
 * the exact set of hidden/session fields required for login, and the exact
 * shape of the viewOrderDetails_New JSON response were not fully knowable
 * without direct access to the CRM.
 *
 * Every CRM-specific detail that may need adjusting once you test against
 * the real CRM is isolated in the CONFIG object and the three functions:
 *   - fetchLoginPage()
 *   - performLogin()
 *   - lookupOrder()
 * You should not need to touch any other file to fix a CRM integration
 * mismatch — everything CRM-specific lives in this one file.
 * ----------------------------------------------------------------------
 */

const CRM_BASE = "https://bss.omanbroadband.om";
const LOGIN_PAGE_PATH = "/crm/login";
const LOGIN_SUBMIT_PATH = "/crm/login";
const ORDER_LOOKUP_PATH = "/crm/viewOrderDetails_New";

const REQUEST_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------
// CONFIG — adjust here if the CRM's real request/response shape differs
// from what was captured in DevTools.
// ---------------------------------------------------------------------
const CONFIG = {
  // Static/default values observed in the login form. Adjust if your
  // CRM account uses different location/language defaults.
  loginDefaults: {
    featureId: "",
    targetPage: "",
    sessionChk: "",
    GuiLanguage: "en",
    locationId: "",
    locationName: "",
    otp: ""
  },

  // Regex patterns used to pull the CSRF token out of the login page HTML.
  // Adjust these if the CRM's login page markup differs.
  csrfPatterns: [
    /name=["']_csrf["']\s+(?:id=["'][^"']*["']\s+)?value=["']([^"']+)["']/i,
    /<meta\s+name=["']_csrf["']\s+content=["']([^"']+)["']/i,
    /"_csrf"\s*:\s*"([^"]+)"/i
  ],

  // Fields the order-lookup POST is expected to need beyond order_id.
  // These are typically returned from the authenticated session
  // (e.g. embedded in the post-login page or an initial CRM API call)
  // rather than being fixed values — extend fetchSessionContext() below
  // if your CRM exposes them via a specific endpoint.
  orderLookupExtraFields: ["contractorId", "userId", "roleId", "mvnoId", "teamId"]
};

// ---------------------------------------------------------------------
// Minimal cookie jar (request-scoped only — never persisted, never
// returned to the browser, never written to disk/database).
// ---------------------------------------------------------------------
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  storeFromResponse(response) {
    const raw = typeof response.headers.raw === "function"
      ? response.headers.raw()["set-cookie"] || []
      : response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie")]
        : [];

    for (const cookieStr of raw) {
      const [pair] = cookieStr.split(";");
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const name = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  header() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  get(name) {
    return this.cookies.get(name);
  }
}

// ---------------------------------------------------------------------
// Networking helper with timeout
// ---------------------------------------------------------------------
async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------
// Step 1: Load the login page to get an initial session cookie + CSRF token
// ---------------------------------------------------------------------
async function fetchLoginPage(jar) {
  const response = await timedFetch(`${CRM_BASE}${LOGIN_PAGE_PATH}`, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AtaadOrderLookup/1.0)",
      Accept: "text/html,application/xhtml+xml"
    }
  });

  jar.storeFromResponse(response);

  if (!response.ok && response.status !== 302) {
    throw new CrmError("CRM_UNAVAILABLE", `Login page returned status ${response.status}`);
  }

  const html = await response.text();

  let csrfToken = null;
  for (const pattern of CONFIG.csrfPatterns) {
    const match = html.match(pattern);
    if (match) {
      csrfToken = match[1];
      break;
    }
  }

  if (!csrfToken) {
    throw new CrmError(
      "CSRF_NOT_FOUND",
      "Could not locate a CSRF token on the CRM login page. The login page markup may have changed — update csrfPatterns in netlify/functions/order-lookup.js."
    );
  }

  return { csrfToken };
}

// ---------------------------------------------------------------------
// Step 2: Submit the login form using credentials from environment
// variables (never from the frontend/request body).
// ---------------------------------------------------------------------
async function performLogin(jar, csrfToken) {
  const username = process.env.CRM_USERNAME;
  const password = process.env.CRM_PASSWORD;

  if (!username || !password) {
    throw new CrmError(
      "CONFIG_MISSING",
      "CRM_USERNAME / CRM_PASSWORD environment variables are not configured."
    );
  }

  const body = new URLSearchParams({
    _csrf: csrfToken,
    featureId: CONFIG.loginDefaults.featureId,
    targetPage: CONFIG.loginDefaults.targetPage,
    sessionChk: CONFIG.loginDefaults.sessionChk,
    GuiLanguage: CONFIG.loginDefaults.GuiLanguage,
    locationId: CONFIG.loginDefaults.locationId,
    locationName: CONFIG.loginDefaults.locationName,
    username,
    password_ui: password,
    password,
    otp: CONFIG.loginDefaults.otp
  });

  let response = await timedFetch(`${CRM_BASE}${LOGIN_SUBMIT_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Cookie: jar.header(),
      "User-Agent": "Mozilla/5.0 (compatible; AtaadOrderLookup/1.0)"
    },
    body: body.toString()
  });

  jar.storeFromResponse(response);

  // Follow the redirect to /crm/authSuccess if the CRM responds with one.
  let hopCount = 0;
  while ([301, 302, 303, 307, 308].includes(response.status) && hopCount < 5) {
    const location = response.headers.get("location");
    if (!location) break;
    const nextUrl = location.startsWith("http") ? location : `${CRM_BASE}${location}`;
    response = await timedFetch(nextUrl, {
      method: "GET",
      headers: {
        Cookie: jar.header(),
        "User-Agent": "Mozilla/5.0 (compatible; AtaadOrderLookup/1.0)"
      }
    });
    jar.storeFromResponse(response);
    hopCount += 1;
  }

  if (!jar.get("JSESSIONID")) {
    throw new CrmError("LOGIN_FAILED", "CRM login did not establish an authenticated session.");
  }

  return true;
}

// ---------------------------------------------------------------------
// Step 3: Look up the order using the authenticated session.
// ---------------------------------------------------------------------
async function lookupOrder(jar, orderId, csrfToken) {
  const body = new URLSearchParams({
    order_id: orderId
  });

  // Extra session-derived fields the CRM's own frontend sends. These are
  // not secrets, but they vary by logged-in user/role, so we do not
  // hard-code real values — only include them if present via env config
  // for the CRM account being used. Leave unset if your CRM account does
  // not require them (single-tenant setups typically don't).
  for (const field of CONFIG.orderLookupExtraFields) {
    const envKey = `CRM_${field.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
    if (process.env[envKey]) {
      body.append(field, process.env[envKey]);
    }
  }

  const response = await timedFetch(`${CRM_BASE}${ORDER_LOOKUP_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": csrfToken,
      Cookie: jar.header(),
      "User-Agent": "Mozilla/5.0 (compatible; AtaadOrderLookup/1.0)",
      Accept: "application/json"
    },
    body: body.toString()
  });

  jar.storeFromResponse(response);

  if (response.status === 401 || response.status === 403) {
    throw new CrmError("SESSION_EXPIRED", "CRM session was rejected during order lookup.");
  }

  if (!response.ok) {
    throw new CrmError("CRM_UNAVAILABLE", `Order lookup returned status ${response.status}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new CrmError("PARSE_ERROR", "CRM order lookup response was not valid JSON.");
  }

  return data;
}

// ---------------------------------------------------------------------
// Field extraction — pulls only the fields we need, tolerant of the
// order record being nested under a wrapper key (e.g. { data: {...} }
// or { result: {...} }), which is common for this kind of CRM endpoint.
// ---------------------------------------------------------------------
function extractOrderFields(raw) {
  const candidates = [raw, raw && raw.data, raw && raw.result, raw && raw.order];
  const source = candidates.find((c) => c && typeof c === "object" && !Array.isArray(c)) || {};

  // Some CRMs return a single-element array of matches.
  const record = Array.isArray(source) ? source[0] : source;
  const src = record && typeof record === "object" ? record : {};

  const pick = (...keys) => {
    for (const key of keys) {
      if (src[key] !== undefined && src[key] !== null && String(src[key]).trim() !== "") {
        return String(src[key]).trim();
      }
    }
    return "";
  };

  return {
    orderId: pick("orderId", "order_id"),
    rlRefreneceNo: pick("rlRefreneceNo", "rlReferenceNo", "rl_reference_no"),
    customerName: pick("customerName", "customer_name"),
    contactNumber: pick("contactNumber", "contact_number"),
    geoTag: pick("geoTag", "geo_tag"),
    createDate: pick("createDate", "create_date"),
    currentStage: pick("currentStage", "current_stage", "status"),
    customerPhoneOther: pick("customerPhoneOther", "customer_phone_other"),
    propertyType: pick("propertyType", "property_type"),
    auditPopName: pick("auditPopName", "audit_pop_name"),
    auditRlNotes: pick("auditRlNotes", "audit_rl_notes")
  };
}

function isOrderFound(order, rawResponse) {
  // Treat as "not found" if we couldn't extract even a basic identifier
  // and the CRM didn't otherwise indicate success.
  if (order.orderId || order.customerName || order.currentStage) return true;
  if (rawResponse && rawResponse.found === false) return false;
  return false;
}

function formatWhatsAppText(order) {
  const lines = ["*ORDER DETAILS*", ""];

  const add = (label, value) => {
    if (value && String(value).trim() !== "") lines.push(`${label}: ${value}`);
  };

  add("Order ID", order.orderId);
  add("RL Reference", order.rlRefreneceNo);
  lines.push("");
  add("Customer", order.customerName);
  add("Contact", order.contactNumber);
  add("Other Phone", order.customerPhoneOther);
  lines.push("");
  add("GeoTag", order.geoTag);
  add("Created", order.createDate);
  lines.push("");
  add("Status", order.currentStage);
  add("Property Type", order.propertyType);
  add("POP", order.auditPopName);

  if (order.auditRlNotes) {
    lines.push("");
    lines.push("RL Notes:");
    lines.push(order.auditRlNotes);
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------
// Error type carrying a safe, user-facing code
// ---------------------------------------------------------------------
class CrmError extends Error {
  constructor(code, technicalMessage) {
    super(technicalMessage);
    this.code = code;
  }
}

const USER_MESSAGES = {
  INVALID_ORDER_ID: "Please enter a valid numeric Order ID.",
  CONFIG_MISSING: "CRM login failed. Please check the configured CRM credentials.",
  LOGIN_FAILED: "CRM login failed. Please check the configured CRM credentials.",
  CSRF_NOT_FOUND: "Unable to connect to CRM. Please try again later.",
  SESSION_EXPIRED: "Unable to connect to CRM. Please try again later.",
  CRM_UNAVAILABLE: "CRM is currently unavailable. Please try again later.",
  PARSE_ERROR: "Unable to read the order details. Please try again.",
  NOT_FOUND: "Order not found. Please check the Order ID and try again.",
  TIMEOUT: "CRM is taking too long to respond. Please try again.",
  UNKNOWN: "Unable to read the order details. Please try again."
};

function safeMessageFor(code) {
  return USER_MESSAGES[code] || USER_MESSAGES.UNKNOWN;
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, message: "Method not allowed." });
  }

  let orderId;
  try {
    const body = JSON.parse(event.body || "{}");
    orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
  } catch (e) {
    return jsonResponse(400, { success: false, message: safeMessageFor("INVALID_ORDER_ID") });
  }

  if (!orderId || !/^[0-9]+$/.test(orderId)) {
    return jsonResponse(400, { success: false, message: safeMessageFor("INVALID_ORDER_ID") });
  }

  const jar = new CookieJar();

  try {
    const { csrfToken } = await fetchLoginPage(jar);
    await performLogin(jar, csrfToken);

    // Some CRMs issue a fresh CSRF token post-login for subsequent API
    // calls. Re-use the login CSRF token by default; if your CRM requires
    // a distinct post-login token, fetch it here and pass it into
    // lookupOrder instead.
    const rawResult = await lookupOrder(jar, orderId, csrfToken);
    const order = extractOrderFields(rawResult);

    if (!isOrderFound(order, rawResult)) {
      return jsonResponse(200, { success: false, message: safeMessageFor("NOT_FOUND") });
    }

    const formattedText = formatWhatsAppText(order);

    return jsonResponse(200, {
      success: true,
      order,
      formattedText
    });
  } catch (err) {
    // Log full technical detail server-side only. Never log the password;
    // credentials are never included in these error objects.
    const code = err instanceof CrmError ? err.code : "UNKNOWN";
    console.error(`[order-lookup] ${code}:`, err && err.message ? err.message : err);

    if (err && err.name === "AbortError") {
      return jsonResponse(504, { success: false, message: safeMessageFor("TIMEOUT") });
    }

    return jsonResponse(200, { success: false, message: safeMessageFor(code) });
  }
};

function jsonResponse(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj)
  };
}
