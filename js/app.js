/**
 * ATAAD Order Lookup – Frontend
 *
 * API endpoint: your laptop server via Cloudflare Tunnel
 */

// ─── API ENDPOINT ──────────────────────────────────────────
const API_URL = 'https://chrome-feeling-henry-gear.trycloudflare.com/api/lookup';

// ─── DOM REFS ──────────────────────────────────────────────
const orderInput = document.getElementById('orderId');
const searchBtn = document.getElementById('searchBtn');
const resultDiv = document.getElementById('result');
const copyBtn = document.getElementById('copyBtn');
const loadingEl = document.getElementById('loading');

// ─── HELPERS ──────────────────────────────────────────────
function showLoading(show) {
  if (loadingEl) loadingEl.style.display = show ? 'block' : 'none';
}

function showResult(html) {
  if (resultDiv) resultDiv.innerHTML = html;
}

function showError(msg) {
  showResult(`<div class="error">❌ ${msg}</div>`);
}

function showSuccess(data) {
  // Format the response nicely
  const formatted = data.formattedText || 'No details available.';
  // Convert newlines to <br> for HTML display
  const html = formatted.replace(/\n/g, '<br>');
  showResult(`<div class="success">✅ Order found!</div><div class="details">${html}</div>`);
  // Store the raw text for copy
  window._copyText = formatted;
}

// ─── SEARCH ──────────────────────────────────────────────
async function searchOrder() {
  const orderId = orderInput.value.trim();
  if (!orderId) {
    showError('Please enter an Order ID.');
    return;
  }
  if (!/^\d+$/.test(orderId)) {
    showError('Please enter a valid numeric Order ID.');
    return;
  }

  showLoading(true);
  showResult('');

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Server returned ${response.status}`);
    }

    if (data.success && data.order) {
      showSuccess(data);
    } else {
      showError(data.error || 'Order not found.');
    }
  } catch (err) {
    console.error('[app] Error:', err);
    showError('Could not reach the server. Please try again later.');
  } finally {
    showLoading(false);
  }
}

// ─── COPY ──────────────────────────────────────────────────
async function copyDetails() {
  const text = window._copyText;
  if (!text) {
    alert('No details to copy. Search for an order first.');
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    alert('✅ Details copied to clipboard!');
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      alert('✅ Details copied to clipboard!');
    } catch {
      alert('Could not copy. Please select and copy manually.');
    }
    document.body.removeChild(textarea);
  }
}

// ─── EVENT LISTENERS ──────────────────────────────────────
searchBtn.addEventListener('click', searchOrder);
copyBtn.addEventListener('click', copyDetails);

// Allow Enter key on input
orderInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') searchOrder();
});

// Optionally load last searched order from localStorage
const lastOrder = localStorage.getItem('lastOrder');
if (lastOrder) {
  orderInput.value = lastOrder;
}

// Save last order on successful search (optional)
const originalShowSuccess = showSuccess;
showSuccess = function(data) {
  localStorage.setItem('lastOrder', orderInput.value.trim());
  originalShowSuccess(data);
};

// ─── INIT ──────────────────────────────────────────────────
console.log('[app] Ready. API endpoint:', API_URL);
