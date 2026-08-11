/**
 * ATAAD ORDER LOOKUP
 *
 * Netlify Function
 *
 * Flow:
 * Browser
 *   -> Netlify Function
 *   -> Oman Broadband CRM
 *   -> Login/session
 *   -> viewOrderDetails_New
 *   -> formatted order details
 *
 * Required Netlify environment variables:
 *
 * CRM_USERNAME
 * CRM_PASSWORD
 *
 * Optional environment variables for CRM order-search parameters:
 *
 * CRM_CONTRACTOR_ID
 * CRM_USER_ID
 * CRM_ROLE_ID
 * CRM_MVNO_ID
 * CRM_TEAM_ID
 */

const CRM_BASE_URL = "https://bss.omanbroadband.om";

const LOGIN_LOGOUT_PATH = "/crm/logOut";
const LOGIN_PATH = "/crm/login";
const AUTH_SUCCESS_PATH = "/crm/authSuccess";
const ORDER_PATH = "/crm/viewOrderDetails_New";

const REQUEST_TIMEOUT_MS = 30000;

/* ---------------------------------------------------------
   MAIN HANDLER
--------------------------------------------------------- */

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      success: false,
      error: "Method not allowed."
    });
  }

  try {
    const body = safeJsonParse(event.body);

    const rawOrderId = body && body.orderId;

    if (rawOrderId === undefined || rawOrderId === null) {
      return jsonResponse(400, {
        success: false,
        error: "Order ID is required."
      });
    }

    const orderId = String(rawOrderId).trim();

    /*
     * Order IDs must remain strings.
     * This is important because an Order ID may contain leading zeroes.
     */
    if (!/^\d+$/.test(orderId)) {
      return jsonResponse(400, {
        success: false,
        error: "Please enter a valid numeric Order ID."
      });
    }

    if (!process.env.CRM_USERNAME || !process.env.CRM_PASSWORD) {
      console.error("[order-lookup] CRM credentials are not configured.");

      return jsonResponse(500, {
        success: false,
        error: "CRM is not configured correctly."
      });
    }

    console.log(`[order-lookup] Starting lookup for Order ID ${orderId}`);

    /*
     * -----------------------------------------------------
     * STEP 1
     * Establish CRM session and obtain login/CSRF information
     * -----------------------------------------------------
     */

    const session = await createCrmSession();

    /*
     * -----------------------------------------------------
     * STEP 2
     * Login
     * -----------------------------------------------------
     */

    await loginToCrm(session);

    /*
     * -----------------------------------------------------
     * STEP 3
     * Search order
     * -----------------------------------------------------
     */

    const crmResult = await fetchOrder(session, orderId);

    /*
     * -----------------------------------------------------
     * STEP 4
     * Parse CRM response
     * -----------------------------------------------------
     */

    const order = extractOrder(crmResult, orderId);

    if (!order) {
      console.log(
        `[order-lookup] Order ${orderId} was not found in CRM response.`
      );

      return jsonResponse(404, {
        success: false,
        error: "Order not found. Please check the Order ID."
      });
    }

    const formattedText = formatForWhatsApp(order);

    console.log(`[order-lookup] Order ${orderId} found successfully.`);

    return jsonResponse(200, {
      success: true,
      order,
      formattedText
    });

  } catch (error) {
    console.error(
      "[order-lookup] ERROR:",
      sanitizeErrorMessage(error)
    );

    return jsonResponse(
      error.statusCode || 502,
      {
        success: false,
        error: getSafeUserMessage(error)
      }
    );
  }
};

/* =========================================================
   CRM SESSION (REVISED)
========================================================= */

async function createCrmSession() {
  /*
   * REVISED: Start by requesting the login page (GET /crm/login)
   * to obtain the initial session cookies and CSRF token.
   * The previous approach of calling /crm/logOut first caused a 401.
   */

  const url = CRM_BASE_URL + LOGIN_PATH;

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      redirect: "manual",
      headers: browserHeaders({
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      })
    },
    REQUEST_TIMEOUT_MS
  );

  const cookies = extractCookies(response);
  const location = response.headers.get("location");

  console.log(
    `[order-lookup] Login page request: ${response.status}` +
    (location ? ` redirect=${location}` : "") +
    ` cookies=${cookies.length > 0}`
  );

  // Follow redirects (e.g., to a different login page)
  if (isRedirect(response.status) && location) {
    const redirectUrl = new URL(location, CRM_BASE_URL).toString();

    const redirectResponse = await fetchWithTimeout(
      redirectUrl,
      {
        method: "GET",
        redirect: "manual",
        headers: browserHeaders({
          referer: url,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          cookie: cookies.join("; ")
        })
      },
      REQUEST_TIMEOUT_MS
    );

    const redirectCookies = extractCookies(redirectResponse);
    const allCookies = mergeCookies(cookies, redirectCookies);

    const html = await redirectResponse.text();

    console.log(
      `[order-lookup] Login redirect response: ${redirectResponse.status}` +
      ` content-type=${redirectResponse.headers.get("content-type") || ""}` +
      ` length=${html.length}`
    );

    const csrf =
      extractCsrf(html) ||
      redirectResponse.headers.get("X-CSRF-TOKEN") ||
      redirectResponse.headers.get("x-csrf-token");

    return { cookies: allCookies, csrf: csrf || null };
  }

  // If we get a 200, read the HTML to extract CSRF
  if (response.status === 200) {
    const html = await response.text();

    console.log(
      `[order-lookup] Login page received, status=${response.status}` +
      ` length=${html.length}`
    );

    const csrf =
      extractCsrf(html) ||
      response.headers.get("X-CSRF-TOKEN") ||
      response.headers.get("x-csrf-token");

    return { cookies, csrf: csrf || null };
  }

  // Handle unexpected status codes
  if (response.status === 401) {
    const error = new Error(
      "CRM login page returned 401 – check the endpoint or your IP."
    );
    error.code = "CRM_LOGIN_PAGE_401";
    error.statusCode = 502;
    throw error;
  }

  if (response.status >= 400) {
    const error = new Error(
      `CRM login page returned HTTP ${response.status}.`
    );
    error.statusCode = 502;
    throw error;
  }

  // Fallback: try to get CSRF from headers
  const csrf = response.headers.get("X-CSRF-TOKEN") ||
               response.headers.get("x-csrf-token");

  return { cookies, csrf: csrf || null };
}

/* =========================================================
   CRM LOGIN
========================================================= */

async function loginToCrm(session) {
  /*
   * The CRM login request captured from the browser is:
   *
   * POST /crm/login
   *
   * application/x-www-form-urlencoded
   */

  const username = process.env.CRM_USERNAME;
  const password = process.env.CRM_PASSWORD;

  const form = new URLSearchParams();

  /*
   * Dynamic CSRF.
   */
  if (session.csrf) {
    form.append("_csrf", session.csrf);
  }

  /*
   * Values observed from the browser login request.
   */
  form.append(
    "featureId",
    "<fmt:message key='login.featureid'/>"
  );

  form.append(
    "targetPage",
    "/common/authenticateResp.jsp"
  );

  form.append("sessionChk", "false");
  form.append("GuiLanguage", "null");
  form.append("locationId", "");
  form.append("locationName", "");

  form.append("username", username);
  form.append("password_ui", "");
  form.append("password", password);
  form.append("otp", "");

  const response = await fetchWithTimeout(
    CRM_BASE_URL + LOGIN_PATH,
    {
      method: "POST",
      redirect: "manual",

      headers: browserHeaders({
        referer: CRM_BASE_URL + LOGIN_PATH,
        origin: CRM_BASE_URL,
        contentType:
          "application/x-www-form-urlencoded",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        cookie: session.cookies.join("; "),
        csrf: session.csrf
      }),

      body: form.toString()
    },
    REQUEST_TIMEOUT_MS
  );

  const loginCookies = extractCookies(response);
  session.cookies = mergeCookies(session.cookies, loginCookies);

  const location = response.headers.get("location");

  console.log(
    `[order-lookup] CRM login response: ${response.status}` +
    (location ? ` redirect=${location}` : "")
  );

  if (response.status === 401 || response.status === 403) {
    const error = new Error(
      `CRM login rejected with HTTP ${response.status}.`
    );
    error.code = "CRM_LOGIN_REJECTED";
    error.statusCode = 502;
    throw error;
  }

  if (isRedirect(response.status) && location) {
    await followAuthenticationRedirect(session, location);
    return;
  }

  // Some servers may return 200 with an authentication page
  if (response.status === 200) {
    const text = await response.text();
    if (
      /login/i.test(text) &&
      /password/i.test(text) &&
      !/authSuccess/i.test(text)
    ) {
      const error = new Error(
        "CRM login did not establish an authenticated session."
      );
      error.code = "CRM_LOGIN_NOT_AUTHENTICATED";
      error.statusCode = 502;
      throw error;
    }
    return;
  }

  const error = new Error(
    `Unexpected CRM login response: HTTP ${response.status}.`
  );
  error.statusCode = 502;
  throw error;
}

/* =========================================================
   AUTH REDIRECT
========================================================= */

async function followAuthenticationRedirect(
  session,
  location
) {
  let currentUrl = new URL(location, CRM_BASE_URL).toString();

  for (let i = 0; i < 5; i++) {
    const response = await fetchWithTimeout(
      currentUrl,
      {
        method: "GET",
        redirect: "manual",
        headers: browserHeaders({
          referer: CRM_BASE_URL + LOGIN_PATH,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          cookie: session.cookies.join("; "),
          csrf: session.csrf
        })
      },
      REQUEST_TIMEOUT_MS
    );

    const newCookies = extractCookies(response);
    session.cookies = mergeCookies(session.cookies, newCookies);

    const nextLocation = response.headers.get("location");

    console.log(
      `[order-lookup] CRM auth redirect ${i + 1}: ${response.status}` +
      (nextLocation ? ` -> ${nextLocation}` : "")
    );

    if (isRedirect(response.status) && nextLocation) {
      currentUrl = new URL(nextLocation, currentUrl).toString();
      continue;
    }

    if (response.status >= 400) {
      const error = new Error(
        `CRM authentication redirect returned HTTP ${response.status}.`
      );
      error.statusCode = 502;
      throw error;
    }

    return;
  }

  const error = new Error("CRM authentication redirect loop.");
  error.statusCode = 502;
  throw error;
}

/* =========================================================
   ORDER LOOKUP
========================================================= */

async function fetchOrder(session, orderId) {
  const contractorId = process.env.CRM_CONTRACTOR_ID || "117";
  const userId = process.env.CRM_USER_ID || "1583";
  const roleId = process.env.CRM_ROLE_ID || "93";
  const mvnoId = process.env.CRM_MVNO_ID || "200";
  const teamId = process.env.CRM_TEAM_ID || "51";

  const form = new URLSearchParams();

  form.append("draw", "1");
  form.append("start", "0");
  form.append("length", "10");
  form.append("languageId", "1");
  form.append("pageName", "ADVANCED_SEARCH_ORDER_MANAGEMENT");
  form.append("order_type", "");
  form.append("roleForOm", "false");
  form.append("order_id", orderId);
  form.append("gis_tag", "");
  form.append("posId", "");
  form.append("startDate", "");
  form.append("endDate", "");
  form.append("rowCount", "10");
  form.append("perPageCount", "10");
  form.append("userPosition", "49");
  form.append("rl_reference_no", "");
  form.append("requesting_licensee", "");
  form.append("MVNORequired", "true");
  form.append("end_user_type", "");
  form.append("contractorId", contractorId);
  form.append("contractorType", "");
  form.append("userId", userId);
  form.append("roleId", roleId);
  form.append("mvnoId", mvnoId);
  form.append("teamId", teamId);

  const response = await fetchWithTimeout(
    CRM_BASE_URL + ORDER_PATH,
    {
      method: "POST",
      redirect: "manual",
      headers: browserHeaders({
        referer: CRM_BASE_URL + AUTH_SUCCESS_PATH,
        origin: CRM_BASE_URL,
        accept: "application/json, text/javascript, */*; q=0.01",
        contentType: "application/x-www-form-urlencoded; charset=UTF-8",
        requestedWith: "XMLHttpRequest",
        cookie: session.cookies.join("; "),
        csrf: session.csrf
      }),
      body: form.toString()
    },
    REQUEST_TIMEOUT_MS
  );

  const cookies = extractCookies(response);
  session.cookies = mergeCookies(session.cookies, cookies);

  const contentType = response.headers.get("content-type") || "";
  const location = response.headers.get("location");

  console.log(
    `[order-lookup] CRM order response: ${response.status}` +
    ` content-type=${contentType}` +
    ` length=${response.headers.get("content-length") || "unknown"}` +
    (location ? ` redirect=${location}` : "")
  );

  // Check for redirect to login (session expired)
  if (isRedirect(response.status) && location) {
    const redirectUrl = new URL(location, CRM_BASE_URL).toString();
    if (/login|auth/i.test(redirectUrl)) {
      const error = new Error("CRM session was not authenticated.");
      error.code = "CRM_SESSION_EXPIRED";
      error.statusCode = 502;
      throw error;
    }
  }

  if (response.status === 401 || response.status === 403) {
    const error = new Error(
      `CRM order request returned HTTP ${response.status}.`
    );
    error.code = "CRM_ORDER_AUTH_ERROR";
    error.statusCode = 502;
    throw error;
  }

  if (response.status >= 500) {
    const error = new Error(
      `CRM server returned HTTP ${response.status}.`
    );
    error.code = "CRM_SERVER_ERROR";
    error.statusCode = 502;
    throw error;
  }

  if (response.status >= 400) {
    const error = new Error(
      `CRM order request returned HTTP ${response.status}.`
    );
    error.statusCode = 502;
    throw error;
  }

  const text = await response.text();

  if (!text) {
    const error = new Error("CRM returned an empty response.");
    error.statusCode = 502;
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (parseError) {
    console.error(
      `[order-lookup] CRM returned non-JSON response. ` +
      `content-type=${contentType} length=${text.length}`
    );
    const error = new Error("CRM returned an unexpected response.");
    error.code = "CRM_NON_JSON_RESPONSE";
    error.statusCode = 502;
    throw error;
  }
}

/* =========================================================
   RESPONSE PARSING
========================================================= */

function extractOrder(data, requestedOrderId) {
  if (!data) return null;

  let rows = [];
  if (Array.isArray(data.data)) rows = data.data;
  else if (Array.isArray(data.aaData)) rows = data.aaData;
  else if (Array.isArray(data.rows)) rows = data.rows;
  else if (Array.isArray(data)) rows = data;

  if (!rows.length) return null;

  // Find the specific order
  let row = rows.find((item) => {
    const value = item?.orderId ?? item?.order_id ?? item?.id;
    return value !== undefined && String(value).trim() === requestedOrderId;
  });

  // Fallback to first row if only one is returned
  if (!row && rows.length === 1) row = rows[0];

  if (!row) return null;

  return normalizeOrder(row, requestedOrderId);
}

/* =========================================================
   NORMALIZE ORDER
========================================================= */

function normalizeOrder(row, requestedOrderId) {
  return {
    orderId:
      firstValue(
        row.orderId,
        row.order_id,
        row.orderID,
        requestedOrderId
      ),
    rlRefreneceNo:
      firstValue(
        row.rlRefreneceNo,
        row.rlReferenceNo,
        row.rl_reference_no,
        row.rlReferenceNumber
      ),
    customerName:
      firstValue(
        row.customerName,
        row.endUserName,
        row.end_user_name
      ),
    contactNumber:
      firstValue(
        row.contactNumber,
        row.contact_number,
        row.mobileNumber,
        row.customerPhone
      ),
    geoTag:
      firstValue(
        row.geoTag,
        row.geo_tag,
        row.gisTag,
        row.gis_tag
      ),
    createDate:
      firstValue(
        row.createDate,
        row.create_date,
        row.createdDate
      ),
    currentStage:
      firstValue(
        row.currentStage,
        row.current_stage,
        row.orderStatus,
        row.order_status
      ),
    customerPhoneOther:
      firstValue(
        row.customerPhoneOther,
        row.customer_phone_other,
        row.otherPhone
      ),
    propertyType:
      firstValue(
        row.propertyType,
        row.property_type
      ),
    auditPopName:
      firstValue(
        row.auditPopName,
        row.audit_pop_name,
        row.popName,
        row.pop
      ),
    auditRlNotes:
      firstValue(
        row.auditRlNotes,
        row.audit_rl_notes,
        row.rlNotes,
        row.rl_notes
      )
  };
}

/* =========================================================
   WHATSAPP FORMAT
========================================================= */

function formatForWhatsApp(order) {
  const lines = [];
  lines.push("*ORDER DETAILS*");
  lines.push("");
  addLine(lines, "Order ID", order.orderId);
  addLine(lines, "RL Reference", order.rlRefreneceNo);
  lines.push("");
  addLine(lines, "Customer", order.customerName);
  addLine(lines, "Contact", order.contactNumber);
  addLine(lines, "Other Phone", order.customerPhoneOther);
  lines.push("");
  addLine(lines, "GeoTag", order.geoTag);
  addLine(lines, "Created", order.createDate);
  lines.push("");
  addLine(lines, "Status", order.currentStage);
  addLine(lines, "Property Type", order.propertyType);
  addLine(lines, "POP", order.auditPopName);
  if (hasValue(order.auditRlNotes)) {
    lines.push("");
    lines.push("RL Notes:");
    lines.push(String(order.auditRlNotes).trim());
  }
  return lines.join("\n").trim();
}

/* =========================================================
   HELPERS
========================================================= */

function addLine(lines, label, value) {
  if (!hasValue(value)) return;
  lines.push(`${label}: ${String(value).trim()}`);
}

function firstValue(...values) {
  for (const v of values) {
    if (hasValue(v)) return v;
  }
  return "";
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function safeJsonParse(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    const e = new Error("Invalid request.");
    e.statusCode = 400;
    throw e;
  }
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function browserHeaders(options = {}) {
  const headers = {
    // Updated to a modern Chrome User-Agent
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "DNT": "1"
  };

  if (options.accept) headers["Accept"] = options.accept;
  if (options.referer) headers["Referer"] = options.referer;
  if (options.origin) headers["Origin"] = options.origin;
  if (options.contentType) headers["Content-Type"] = options.contentType;
  if (options.requestedWith) headers["X-Requested-With"] = options.requestedWith;
  if (options.cookie) headers["Cookie"] = options.cookie;
  if (options.csrf) headers["X-CSRF-TOKEN"] = options.csrf;

  return headers;
}

/* =========================================================
   COOKIE HELPERS
========================================================= */

function extractCookies(response) {
  let rawCookies = [];
  if (response.headers && typeof response.headers.getSetCookie === "function") {
    rawCookies = response.headers.getSetCookie();
  } else {
    const single = response.headers.get("set-cookie");
    if (single) rawCookies = splitSetCookieHeader(single);
  }
  return rawCookies
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean);
}

function splitSetCookieHeader(header) {
  return header.split(/,(?=[^;,=\s]+=[^;,]+)/);
}

function mergeCookies(...cookieArrays) {
  const map = new Map();
  for (const cookies of cookieArrays) {
    for (const cookie of cookies || []) {
      const sep = cookie.indexOf("=");
      if (sep === -1) continue;
      const name = cookie.substring(0, sep);
      map.set(name, cookie);
    }
  }
  return Array.from(map.values());
}

/* =========================================================
   CSRF EXTRACTION
========================================================= */

function extractCsrf(html) {
  if (!html) return null;

  const patterns = [
    /name=["']_csrf["'][^>]*value=["']([^"']+)["']/i,
    /value=["']([^"']+)["'][^>]*name=["']_csrf["']/i,
    /["']_csrf["']\s*[:=]\s*["']([^"']+)["']/i,
    /csrfToken\s*[:=]\s*["']([^"']+)["']/i,
    /csrf_token\s*[:=]\s*["']([^"']+)["']/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1] && match[1].trim()) {
      return match[1].trim();
    }
  }
  return null;
}

/* =========================================================
   FETCH WITH TIMEOUT
========================================================= */

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("CRM request timed out.");
      timeoutError.code = "CRM_TIMEOUT";
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   RESPONSE / ERROR HELPERS
========================================================= */

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 ||
         status === 307 || status === 308;
}

function sanitizeErrorMessage(error) {
  if (!error) return "Unknown error";
  return String(error.message || error)
    .replace(/password\s*[:=]\s*[^\s,;]+/gi, "password=[REDACTED]")
    .replace(/username\s*[:=]\s*[^\s,;]+/gi, "username=[REDACTED]")
    .replace(/JSESSIONID=[^;\s]+/gi, "JSESSIONID=[REDACTED]")
    .replace(/X-CSRF-TOKEN[^,\s]*/gi, "X-CSRF-TOKEN=[REDACTED]");
}

function getSafeUserMessage(error) {
  if (!error) return "CRM is currently unavailable. Please try again later.";

  switch (error.code) {
    case "CRM_TIMEOUT":
      return "CRM is taking too long to respond. Please try again.";
    case "CRM_LOGIN_PAGE_401":
      return "CRM login page could not be accessed. Check the URL or your network.";
    case "CRM_LOGIN_REJECTED":
      return "CRM login was rejected. Please check the CRM configuration.";
    case "CRM_LOGIN_NOT_AUTHENTICATED":
      return "CRM login could not be completed. Please try again later.";
    case "CRM_SESSION_EXPIRED":
      return "CRM session could not be established. Please try again.";
    case "CRM_ORDER_AUTH_ERROR":
      return "CRM authentication failed while searching the order.";
    case "CRM_SERVER_ERROR":
      return "CRM is currently unavailable. Please try again later.";
    case "CRM_NON_JSON_RESPONSE":
      return "CRM returned an unexpected response. Please try again.";
    default:
      return "CRM is currently unavailable. Please try again later.";
  }
}
