// TruthGuard: looks up claims in the Google Fact Check Tools API.
// Docs: https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search

const API_URL = "https://factchecktools.googleapis.com/v1alpha1/claims:search";
const KEY_STORAGE = "truthguard_api_key";
const MAX_CLAIMS = 5; // how many sentences to look up from a long article

const linkInput = document.getElementById("link-input");
const keyInput = document.getElementById("api-key");
const textInput = document.getElementById("claim-text");
const linkBtn = document.getElementById("check-link");
const claimsBtn = document.getElementById("check-claims");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

// ---------- small helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent keeps API text safe
  return node;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "status error" : "status";
}

function setBusy(busy) {
  linkBtn.disabled = busy;
  claimsBtn.disabled = busy;
}

function loadKey() {
  try {
    keyInput.value = localStorage.getItem(KEY_STORAGE) || "";
  } catch (e) {
    // storage can be blocked; the page still works without it
  }
}

function saveKey() {
  try {
    localStorage.setItem(KEY_STORAGE, keyInput.value.trim());
  } catch (e) {
    // ignore
  }
}

// ---------- turning input into search queries ----------

// Picks the sentences most likely to be checkable claims.
function extractClaims(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 220) return [clean];

  const sentences = clean.split(/(?<=[.!?])\s+/).filter(s => s.length >= 30 && s.length <= 300);
  const cues = /\d|%|percent|million|billion|says|said|claims?|according|never|always|no one|everyone|proven|study|scientists?|cause[sd]?|cure[sd]?/i;

  const scored = sentences.map((s, i) => ({ s, i, score: cues.test(s) ? 2 : 0 }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);

  return scored
    .slice(0, MAX_CLAIMS)
    .sort((a, b) => a.i - b.i)
    .map(x => x.s);
}

// Uses only the words inside the URL. The page itself is never opened.
function queryFromLink(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const slug = segments.sort((a, b) => b.length - a.length)[0] || "";
  const words = decodeURIComponent(slug)
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .split(/[-_+\s]+/)
    .filter(w => w.length > 1 && !/^\d+$/.test(w));

  if (words.length < 3) return null;
  return words.slice(0, 12).join(" ");
}

// ---------- talking to the API ----------

async function searchClaims(query, apiKey) {
  const params = new URLSearchParams({
    query,
    key: apiKey,
    languageCode: "en",
    pageSize: "5",
  });

  const res = await fetch(`${API_URL}?${params}`);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.error && body.error.message ? body.error.message : "";
    } catch (e) {
      // no JSON body
    }
    const err = new Error(detail || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.claims || [];
}

function friendlyError(err) {
  if (err.status === 400 || err.status === 403) {
    return "Google rejected the API key. Check that it is correct and that the Fact Check Tools API is enabled for it.";
  }
  if (err.status === 429) {
    return "Too many requests. Wait a minute and try again.";
  }
  if (err instanceof TypeError) {
    return "Could not reach Google. Check your internet connection.";
  }
  return err.message;
}

// ---------- showing results ----------

function ratingClass(rating) {
  const r = (rating || "").toLowerCase();
  if (/(partly|half|mixture|mixed|unproven|unverified|missing context|needs context|unclear|outdated|exaggerat|mostly true)/.test(r)) return "mixed";
  if (/(false|fake|incorrect|wrong|hoax|scam|fabricat|pants|not true|misleading|baseless|inaccura|distort|no evidence)/.test(r)) return "bad";
  if (/(true|correct|accurate|real|legit)/.test(r)) return "good";
  return "";
}

function renderClaim(claim, queried) {
  const box = el("article", "claim");
  if (queried) box.appendChild(el("p", "claim-queried", `Searched for: ${queried}`));
  box.appendChild(el("p", "claim-text", claim.text || "(no claim text)"));

  const by = [claim.claimant, claim.claimDate && claim.claimDate.slice(0, 10)].filter(Boolean).join(", ");
  if (by) box.appendChild(el("p", "claim-by", `Claimed by ${by}`));

  (claim.claimReview || []).forEach(rev => {
    const row = el("div", `review ${ratingClass(rev.textualRating)}`);
    row.appendChild(el("div", "rating", rev.textualRating || "No rating given"));

    if (rev.url) {
      const a = el("a", "", rev.title || rev.url);
      a.href = rev.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      row.appendChild(a);
    }

    const meta = [rev.publisher && rev.publisher.name, rev.reviewDate && rev.reviewDate.slice(0, 10)]
      .filter(Boolean)
      .join(", ");
    if (meta) row.appendChild(el("div", "review-meta", `Reviewed by ${meta}`));

    box.appendChild(row);
  });

  return box;
}

function renderEmpty(query) {
  const box = el("div", "empty");
  box.textContent = `No fact-checks found for: "${query}"`;
  return box;
}

// Runs a list of queries and shows everything that comes back.
async function runChecks(queries) {
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    setStatus("Paste your Google Fact Check API key first.", true);
    keyInput.focus();
    return;
  }
  saveKey();

  resultsEl.replaceChildren();
  setBusy(true);
  setStatus(`Checking ${queries.length} ${queries.length === 1 ? "claim" : "claims"}...`);

  let found = 0;
  try {
    for (const q of queries) {
      const claims = await searchClaims(q, apiKey);
      if (claims.length === 0) {
        resultsEl.appendChild(renderEmpty(q));
      } else {
        found += claims.length;
        claims.forEach(c => resultsEl.appendChild(renderClaim(c, queries.length > 1 ? q : "")));
      }
    }
    setStatus(found > 0 ? `Found ${found} reviewed ${found === 1 ? "claim" : "claims"}.` : "No fact-checks found.");
    resultsEl.appendChild(
      el("p", "note", "No result does not mean a claim is true. It only means no fact-checker in Google's database has reviewed it yet.")
    );
  } catch (err) {
    setStatus(friendlyError(err), true);
  } finally {
    setBusy(false);
  }
}

// ---------- button handlers ----------

claimsBtn.addEventListener("click", () => {
  const text = textInput.value.trim();
  if (!text) {
    setStatus("Paste an article or a claim first.", true);
    textInput.focus();
    return;
  }
  runChecks(extractClaims(text));
});

linkBtn.addEventListener("click", () => {
  const query = queryFromLink(linkInput.value.trim());
  if (!query) {
    setStatus("Paste a full link whose address contains the story's title, like https://example.com/news/story-title-here.", true);
    linkInput.focus();
    return;
  }
  runChecks([query]);
});

linkInput.addEventListener("keydown", e => { if (e.key === "Enter") linkBtn.click(); });
keyInput.addEventListener("change", saveKey);

loadKey();
