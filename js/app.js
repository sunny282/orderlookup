(() => {
  "use strict";

  // ---------- Element refs ----------
  const orderInput = document.getElementById("order-id");
  const inputError = document.getElementById("input-error");
  const searchBtn = document.getElementById("search-btn");
  const statusEl = document.getElementById("status");

  const resultSection = document.getElementById("result-section");
  const resultText = document.getElementById("result-text");
  const copyBtn = document.getElementById("copy-btn");
  const copyConfirm = document.getElementById("copy-confirm");
  const clearBtn = document.getElementById("clear-btn");

  const installBanner = document.getElementById("install-banner");
  const installBtn = document.getElementById("install-btn");
  const installDismiss = document.getElementById("install-dismiss");

  const LAST_ORDER_KEY = "ataad_last_order_id";
  let isSearching = false;

  // ---------- Init ----------
  window.addEventListener("DOMContentLoaded", () => {
    orderInput.focus();

    try {
      const lastId = localStorage.getItem(LAST_ORDER_KEY);
      if (lastId) orderInput.value = lastId;
    } catch (e) {
      /* localStorage may be unavailable in some contexts; ignore */
    }
  });

  // ---------- Validation ----------
  function validateOrderId(value) {
    const trimmed = value.trim();
    if (!trimmed) return { valid: false, message: "Please enter an Order ID." };
    if (!/^[0-9]+$/.test(trimmed)) {
      return { valid: false, message: "Please enter a valid numeric Order ID." };
    }
    return { valid: true, value: trimmed };
  }

  // ---------- Status helpers ----------
  function setStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = "status " + type;
    statusEl.classList.remove("hidden");
  }

  function clearStatus() {
    statusEl.classList.add("hidden");
    statusEl.textContent = "";
  }

  function showInputError(message) {
    inputError.textContent = message;
    inputError.classList.remove("hidden");
  }

  function clearInputError() {
    inputError.classList.add("hidden");
    inputError.textContent = "";
  }

  // ---------- WhatsApp text formatting ----------
  // Mirrors the server-side formatting fields; server sends already-formatted
  // text, but we keep this as a fallback formatter in case the backend
  // returns raw fields instead of pre-formatted text.
  function formatOrderText(order) {
    const lines = [];
    lines.push("*ORDER DETAILS*");
    lines.push("");

    const pushIfPresent = (label, value) => {
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        lines.push(`${label}: ${value}`);
      }
    };

    pushIfPresent("Order ID", order.orderId);
    pushIfPresent("RL Reference", order.rlRefreneceNo);
    lines.push("");
    pushIfPresent("Customer", order.customerName);
    pushIfPresent("Contact", order.contactNumber);
    pushIfPresent("Other Phone", order.customerPhoneOther);
    lines.push("");
    pushIfPresent("GeoTag", order.geoTag);
    pushIfPresent("Created", order.createDate);
    lines.push("");
    pushIfPresent("Status", order.currentStage);
    pushIfPresent("Property Type", order.propertyType);
    pushIfPresent("POP", order.auditPopName);

    if (order.auditRlNotes && String(order.auditRlNotes).trim() !== "") {
      lines.push("");
      lines.push("RL Notes:");
      lines.push(order.auditRlNotes);
    }

    // Collapse accidental triple blank lines from empty sections
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---------- Search ----------
  async function searchOrder() {
    if (isSearching) return;

    clearInputError();
    clearStatus();
    resultSection.classList.add("hidden");

    const check = validateOrderId(orderInput.value);
    if (!check.valid) {
      showInputError(check.message);
      return;
    }

    isSearching = true;
    searchBtn.disabled = true;
    setStatus("Searching CRM...", "info");

    try {
      const response = await fetch("/.netlify/functions/order-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: check.value })
      });

      let payload;
      try {
        payload = await response.json();
      } catch (e) {
        payload = null;
      }

      if (!response.ok || !payload || payload.success !== true) {
        const message = (payload && payload.message) || "Unable to read the order details. Please try again.";
        setStatus(message, "error");
        return;
      }

      setStatus("Order found ✓", "success");

      const text = payload.formattedText || formatOrderText(payload.order || {});
      resultText.value = text;
      resultSection.classList.remove("hidden");
      copyConfirm.classList.add("hidden");

      try {
        localStorage.setItem(LAST_ORDER_KEY, check.value);
      } catch (e) {
        /* ignore storage errors */
      }
    } catch (networkErr) {
      setStatus("Unable to connect to CRM. Please try again later.", "error");
    } finally {
      isSearching = false;
      searchBtn.disabled = false;
    }
  }

  searchBtn.addEventListener("click", searchOrder);

  orderInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      searchOrder();
    }
  });

  orderInput.addEventListener("input", () => {
    clearInputError();
  });

  // ---------- Copy ----------
  async function copyDetails() {
    const text = resultText.value;
    if (!text) return;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
      showCopyConfirm();
    } catch (e) {
      // Clipboard API can fail in some in-app browsers; fall back to manual select
      try {
        fallbackCopy(text);
        showCopyConfirm();
      } catch (e2) {
        setStatus("Could not copy automatically. Please select and copy the text manually.", "error");
      }
    }
  }

  function fallbackCopy(text) {
    resultText.removeAttribute("readonly");
    resultText.focus();
    resultText.select();
    resultText.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    resultText.setAttribute("readonly", "true");
    window.getSelection().removeAllRanges();
    if (!ok) throw new Error("execCommand copy failed");
  }

  function showCopyConfirm() {
    copyConfirm.classList.remove("hidden");
    setTimeout(() => copyConfirm.classList.add("hidden"), 2500);
  }

  copyBtn.addEventListener("click", copyDetails);

  // ---------- Clear ----------
  clearBtn.addEventListener("click", () => {
    orderInput.value = "";
    orderInput.focus();
    resultSection.classList.add("hidden");
    resultText.value = "";
    clearStatus();
    clearInputError();
    copyConfirm.classList.add("hidden");
  });

  // ---------- PWA install prompt ----------
  let deferredPrompt = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBanner.classList.remove("hidden");
  });

  installBtn.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    installBanner.classList.add("hidden");
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  });

  installDismiss.addEventListener("click", () => {
    installBanner.classList.add("hidden");
  });

  window.addEventListener("appinstalled", () => {
    installBanner.classList.add("hidden");
    deferredPrompt = null;
  });

  // ---------- Service worker registration ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/service-worker.js").catch(() => {
        /* non-fatal: app still works without offline caching */
      });
    });
  }
})();
