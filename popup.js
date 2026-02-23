const HISTORY_KEY = "clipyt_history_v1";

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function buildTimestampUrl(videoId, seconds) {
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(seconds || 0))}s`;
}

function setStatus(message) {
  const status = document.getElementById("status");
  status.textContent = message;
  if (message) {
    setTimeout(() => {
      if (status.textContent === message) status.textContent = "";
    }, 2200);
  }
}

async function getHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
}

async function setHistory(items) {
  await chrome.storage.local.set({ [HISTORY_KEY]: items.slice(0, 300) });
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function render() {
  const root = document.getElementById("history-list");
  const items = (await getHistory()).sort((a, b) => (b.updatedAt || b.savedAt || 0) - (a.updatedAt || a.savedAt || 0));

  if (!items.length) {
    root.innerHTML = '<div class="empty">No saved shares yet. Open a YouTube video and click the Share to Nostr button.</div>';
    return;
  }

  root.innerHTML = items
    .map((item) => {
      const ts = formatTimestamp(item.timestamp || 0);
      const updated = new Date(item.updatedAt || item.savedAt || Date.now()).toLocaleString();
      return `
        <article class="item" data-id="${item.id}">
          <h2>${escapeHtml(item.title || "YouTube Video")}</h2>
          <p>${escapeHtml(item.channel || "YouTube")} | ${ts}</p>
          <p>${escapeHtml(updated)}</p>
          <div class="item-actions">
            <button data-action="open" data-id="${item.id}">Open</button>
            <button data-action="copy" data-id="${item.id}">Copy URL</button>
            <button class="delete" data-action="delete" data-id="${item.id}">Delete</button>
          </div>
        </article>`;
    })
    .join("");
}

async function handleAction(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;
  const items = await getHistory();
  const item = items.find((entry) => entry.id === id);
  if (!item) return;

  if (action === "open") {
    await chrome.tabs.create({ url: buildTimestampUrl(item.videoId, item.timestamp || 0) });
    setStatus("Opened share in new tab.");
  }

  if (action === "copy") {
    await navigator.clipboard.writeText(buildTimestampUrl(item.videoId, item.timestamp || 0));
    setStatus("URL copied.");
  }

  if (action === "delete") {
    const next = items.filter((entry) => entry.id !== id);
    await setHistory(next);
    await render();
    setStatus("Deleted.");
  }
}

document.getElementById("history-list").addEventListener("click", handleAction);
document.getElementById("refresh-btn").addEventListener("click", () => render());
render();
