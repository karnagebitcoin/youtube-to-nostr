(() => {
  const HISTORY_KEY = "clipyt_history_v1";
  const PENDING_EDIT_KEY = "clipyt_pending_edit_v1";
  const REQUEST_TYPE = "CLIPYT_NOSTR_REQUEST";
  const RESPONSE_TYPE = "CLIPYT_NOSTR_RESPONSE";
  const READY_TYPE = "CLIPYT_NOSTR_BRIDGE_READY";
  const SRC_IN = "clipyt-extension";
  const SRC_OUT = "clipyt-page";
  const BRIDGE_TOKEN_ATTR = "clipytToken";
  const BRIDGE_ALLOWED_METHODS = new Set(["hasNostr", "getSignerInfo", "getPublicKey", "signEvent", "getRelays"]);

  let lastUrl = location.href;
  let bridgeInjected = false;
  let bridgeReady = false;
  let bridgeLoadPromise = null;
  let bridgeToken = null;
  let shareButtonRetryToken = 0;
  let modalState = null;

  function isWatchPage() {
    return location.pathname === "/watch" && Boolean(getVideoId());
  }

  function getVideoId(url = location.href) {
    try {
      return new URL(url).searchParams.get("v");
    } catch {
      return null;
    }
  }

  function getVideoEl() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  function getCurrentTime() {
    const el = getVideoEl();
    if (!el || !Number.isFinite(el.currentTime)) return 0;
    return Math.floor(el.currentTime);
  }

  function getDuration() {
    const el = getVideoEl();
    if (!el || !Number.isFinite(el.duration)) return 0;
    return Math.floor(el.duration);
  }

  function seekMainVideo(seconds) {
    const video = getVideoEl();
    if (!video || !Number.isFinite(seconds)) return;
    const max = Number.isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
    const next = Math.max(0, Math.min(seconds, max));
    try {
      video.currentTime = next;
    } catch {
      // no-op
    }
  }

  function getVideoTitle() {
    const titleNode = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
      || document.querySelector("h1.title yt-formatted-string")
      || document.querySelector("h1");
    return titleNode?.textContent?.trim() || "YouTube Video";
  }

  function getChannelName() {
    const channelNode = document.querySelector("#owner #channel-name a")
      || document.querySelector("#channel-name a")
      || document.querySelector("ytd-channel-name a");
    return channelNode?.textContent?.trim() || "YouTube";
  }

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

  function getDefaultPreview(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  }

  function sanitizeRelayUrl(url) {
    if (typeof url !== "string") return null;
    const trimmed = url.trim();
    if (!trimmed.startsWith("wss://")) return null;
    return trimmed;
  }

  function showToast(message, type = "info") {
    const statusEl = document.getElementById("clipyt-status");
    if (!statusEl) return;
    statusEl.className = `clipyt-status ${type}`;
    statusEl.textContent = message;
  }

  function showSaveFeedback(message, type = "success") {
    if (!modalState) return;
    const feedbackEl = document.getElementById("clipyt-save-feedback");
    if (!feedbackEl) return;

    feedbackEl.className = `clipyt-save-feedback ${type}`;
    feedbackEl.textContent = message;

    if (modalState.saveFeedbackTimer) {
      clearTimeout(modalState.saveFeedbackTimer);
    }
    modalState.saveFeedbackTimer = setTimeout(() => {
      if (!modalState) return;
      feedbackEl.textContent = "";
      feedbackEl.className = "clipyt-save-feedback";
      modalState.saveFeedbackTimer = null;
    }, 2200);
  }

  function isHex(value, expectedLength) {
    if (typeof value !== "string") return false;
    if (value.length !== expectedLength) return false;
    return /^[0-9a-f]+$/i.test(value);
  }

  function bytesToHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let hex = "";
    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, "0");
    }
    return hex;
  }

  async function computeNostrEventId(event) {
    const payload = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    return bytesToHex(hash);
  }

  async function assertSignedEventIntegrity(unsignedEvent, signedEvent, expectedPubkey) {
    if (!signedEvent || typeof signedEvent !== "object") {
      throw new Error("Signer returned an invalid event payload.");
    }
    if (!isHex(signedEvent.pubkey, 64) || !isHex(signedEvent.id, 64) || !isHex(signedEvent.sig, 128)) {
      throw new Error("Signer returned malformed event fields.");
    }
    if (signedEvent.pubkey !== expectedPubkey || signedEvent.pubkey !== unsignedEvent.pubkey) {
      throw new Error("Signer pubkey mismatch.");
    }
    if (signedEvent.kind !== unsignedEvent.kind || signedEvent.content !== unsignedEvent.content) {
      throw new Error("Signer changed event payload unexpectedly.");
    }
    if (signedEvent.created_at !== unsignedEvent.created_at) {
      throw new Error("Signer changed event timestamp unexpectedly.");
    }
    if (JSON.stringify(signedEvent.tags) !== JSON.stringify(unsignedEvent.tags)) {
      throw new Error("Signer changed event tags unexpectedly.");
    }

    const expectedId = await computeNostrEventId(signedEvent);
    if (expectedId !== signedEvent.id) {
      throw new Error("Signer returned event id that fails integrity check.");
    }
    return signedEvent;
  }

  function ensureBridgeInjected() {
    if (bridgeReady) return Promise.resolve();
    if (bridgeLoadPromise) return bridgeLoadPromise;
    if (!bridgeToken) {
      bridgeToken = crypto.randomUUID().replaceAll("-", "");
    }

    bridgeLoadPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", onReadyMessage);
        bridgeInjected = false;
        reject(new Error("Failed to initialize Nostr bridge"));
      }, 8000);

      function cleanup() {
        clearTimeout(timeout);
        window.removeEventListener("message", onReadyMessage);
      }

      function onReadyMessage(event) {
        if (event.source !== window || !event.data) return;
        const data = event.data;
        if (data.source !== SRC_OUT || data.type !== READY_TYPE) return;
        if (data.bridgeToken !== bridgeToken) return;
        bridgeReady = true;
        cleanup();
        resolve();
      }

      window.addEventListener("message", onReadyMessage);

      if (!bridgeInjected) {
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL("nostr-bridge.js");
        script.dataset[BRIDGE_TOKEN_ATTR] = bridgeToken;
        script.async = false;
        script.onerror = () => {
          cleanup();
          bridgeInjected = false;
          reject(new Error("Failed to inject Nostr bridge"));
        };
        script.onload = () => script.remove();
        (document.head || document.documentElement).appendChild(script);
        bridgeInjected = true;
      }
    }).finally(() => {
      if (!bridgeReady) {
        bridgeLoadPromise = null;
      }
    });

    return bridgeLoadPromise;
  }

  async function nostrRequest(method, params = [], timeoutMs = 15000) {
    if (!BRIDGE_ALLOWED_METHODS.has(method)) {
      throw new Error(`Unsupported signer method: ${method}`);
    }
    await ensureBridgeInjected();

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        reject(new Error(`Nostr request timed out: ${method}`));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      }

      function onMessage(event) {
        if (event.source !== window || !event.data) return;
        const data = event.data;
        if (data.source !== SRC_OUT || data.type !== RESPONSE_TYPE || data.id !== id) return;
        if (data.bridgeToken !== bridgeToken) return;

        if (done) return;
        done = true;
        cleanup();

        if (data.ok) {
          resolve(data.result);
        } else {
          reject(new Error(data.error || "Nostr request failed"));
        }
      }

      window.addEventListener("message", onMessage);
      window.postMessage(
        {
          source: SRC_IN,
          type: REQUEST_TYPE,
          id,
          method,
          params,
          bridgeToken
        },
        "*"
      );
    });
  }

  function publishEventToRelay(relay, event) {
    return new Promise((resolve) => {
      const relayUrl = sanitizeRelayUrl(relay);
      if (!relayUrl) {
        resolve({ relay, ok: false, error: "invalid relay URL" });
        return;
      }

      let settled = false;
      const ws = new WebSocket(relayUrl);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // no-op
        }
        resolve({ relay: relayUrl, ok: false, error: "timeout" });
      }, 5500);

      function finish(payload) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {
          // no-op
        }
        resolve(payload);
      }

      ws.onopen = () => {
        ws.send(JSON.stringify(["EVENT", event]));
      };

      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (Array.isArray(data) && data[0] === "OK" && data[1] === event.id) {
            finish({ relay: relayUrl, ok: Boolean(data[2]), message: data[3] || "" });
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        finish({ relay: relayUrl, ok: false, error: "socket error" });
      };

      ws.onclose = () => {
        if (settled) return;
        finish({ relay: relayUrl, ok: true, message: "sent (no ack)" });
      };
    });
  }

  async function publishToRelays(event, relayUrls) {
    const relays = relayUrls.length
      ? relayUrls
      : ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
    const limited = Array.from(new Set(relays.map(sanitizeRelayUrl).filter(Boolean))).slice(0, 6);
    const results = await Promise.all(limited.map((relay) => publishEventToRelay(relay, event)));
    return results;
  }

  async function getHistory() {
    const result = await chrome.storage.local.get(HISTORY_KEY);
    if (!Array.isArray(result[HISTORY_KEY])) return [];
    return result[HISTORY_KEY];
  }

  async function setHistory(items) {
    await chrome.storage.local.set({ [HISTORY_KEY]: items.slice(0, 300) });
  }

  async function upsertHistoryItem(item) {
    const items = await getHistory();
    const idx = items.findIndex((entry) => entry.id === item.id);
    if (idx >= 0) {
      items[idx] = item;
    } else {
      items.unshift(item);
    }
    await setHistory(items);
    return item;
  }

  async function deleteHistoryItem(id) {
    const items = await getHistory();
    const next = items.filter((entry) => entry.id !== id);
    await setHistory(next);
  }

  function createShareButton() {
    const btn = document.createElement("button");
    btn.id = "clipyt-share-btn";
    btn.type = "button";
    btn.innerHTML = '<span class="clipyt-dot"></span><span>Share to Nostr</span>';
    btn.title = "Share timestamped video";
    btn.addEventListener("click", () => {
      openModal();
    });
    return btn;
  }

  function getShareButtonHost() {
    const candidates = [
      "#top-level-buttons-computed",
      "#menu-container #top-level-buttons-computed",
      "ytd-menu-renderer #top-level-buttons-computed",
      "ytd-watch-metadata #top-level-buttons-computed",
      "ytd-watch-metadata #actions #top-level-buttons-computed",
      "#above-the-fold #top-level-buttons-computed",
      "ytd-watch-flexy #top-level-buttons-computed",
      "ytd-watch-flexy #menu #top-level-buttons-computed"
    ];

    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement && el.isConnected) return el;
    }
    return null;
  }

  function ensureShareButton() {
    const existing = document.getElementById("clipyt-share-btn");
    if (!isWatchPage()) {
      existing?.remove();
      return false;
    }

    const host = getShareButtonHost();
    if (!host) return false;

    if (existing) {
      if (existing.parentElement !== host) {
        host.appendChild(existing);
      }
      return true;
    }

    host.appendChild(createShareButton());
    return true;
  }

  function scheduleEnsureShareButton(attempts = 40, delayMs = 200) {
    const token = ++shareButtonRetryToken;
    const run = () => {
      if (token !== shareButtonRetryToken) return;
      if (ensureShareButton()) return;
      if (attempts <= 0) return;
      attempts -= 1;
      setTimeout(run, delayMs);
    };
    run();
  }

  function switchTab(tab) {
    const shareTab = document.querySelector('[data-clipyt-tab="share"]');
    const historyTab = document.querySelector('[data-clipyt-tab="history"]');
    const sharePanel = document.getElementById("clipyt-tab-share");
    const historyPanel = document.getElementById("clipyt-tab-history");
    if (!shareTab || !historyTab || !sharePanel || !historyPanel) return;

    const isShare = tab === "share";
    shareTab.classList.toggle("active", isShare);
    historyTab.classList.toggle("active", !isShare);
    sharePanel.hidden = !isShare;
    historyPanel.hidden = isShare;
    modalState.activeTab = tab;

    if (!isShare) {
      renderHistoryList();
    }
  }

  function buildNoteText() {
    if (!modalState) return "";
    const url = buildTimestampUrl(modalState.videoId, modalState.selectedTime);
    const lines = [];
    if (modalState.comment?.trim()) lines.push(modalState.comment.trim());
    lines.push(`${modalState.title}`);
    lines.push(url);
    lines.push(`Timestamp: ${formatTimestamp(modalState.selectedTime)}`);

    if (modalState.previewImage && !modalState.previewImage.startsWith("data:")) {
      lines.push(modalState.previewImage);
    }

    return lines.join("\n\n");
  }

  function buildPreviewPostText() {
    if (!modalState) return "";
    const comment = modalState.comment?.trim() || "";
    if (comment) return comment;
    return "No comment added. Link card preview below.";
  }

  function syncFromNativeVideo() {
    if (!modalState) return;
    const video = getVideoEl();
    if (!video) return;
    if (Number.isFinite(video.currentTime)) {
      modalState.selectedTime = Math.max(0, Math.floor(video.currentTime));
    }
    if (Number.isFinite(video.duration)) {
      modalState.duration = Math.max(0, Math.floor(video.duration));
    }
    renderState();
  }

  function attachNativeVideoSync() {
    if (!modalState || modalState.detachNativeVideoSync) return;
    const video = getVideoEl();
    if (!video) return;

    const onUpdate = () => syncFromNativeVideo();
    video.addEventListener("timeupdate", onUpdate);
    video.addEventListener("seeking", onUpdate);
    video.addEventListener("seeked", onUpdate);
    video.addEventListener("loadedmetadata", onUpdate);
    video.addEventListener("durationchange", onUpdate);
    video.addEventListener("play", onUpdate);
    video.addEventListener("pause", onUpdate);

    modalState.detachNativeVideoSync = () => {
      video.removeEventListener("timeupdate", onUpdate);
      video.removeEventListener("seeking", onUpdate);
      video.removeEventListener("seeked", onUpdate);
      video.removeEventListener("loadedmetadata", onUpdate);
      video.removeEventListener("durationchange", onUpdate);
      video.removeEventListener("play", onUpdate);
      video.removeEventListener("pause", onUpdate);
    };
  }

  function stabilizeNativePreviewLayout() {
    const host = document.getElementById("clipyt-player-host");
    const moviePlayer = document.getElementById("movie_player");
    if (!(host instanceof HTMLElement) || !(moviePlayer instanceof HTMLElement)) return;

    const rect = host.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width < 40 || rect.height < 40) {
      return;
    }

    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    moviePlayer.style.width = `${width}px`;
    moviePlayer.style.height = `${height}px`;

    if (typeof moviePlayer.setInternalSize === "function") {
      try {
        moviePlayer.setInternalSize(width, height);
      } catch {
        // no-op
      }
    }
    if (typeof moviePlayer.updateSize === "function") {
      try {
        moviePlayer.updateSize();
      } catch {
        // no-op
      }
    }
    window.dispatchEvent(new Event("resize"));
  }

  function attachPreviewResizeSync() {
    if (!modalState || modalState.detachPreviewResizeSync) return;
    const host = document.getElementById("clipyt-player-host");
    if (!(host instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      stabilizeNativePreviewLayout();
    });
    observer.observe(host);

    modalState.detachPreviewResizeSync = () => {
      observer.disconnect();
      modalState.detachPreviewResizeSync = null;
    };

    // YouTube sometimes applies size styles asynchronously after reparenting.
    stabilizeNativePreviewLayout();
    requestAnimationFrame(() => {
      stabilizeNativePreviewLayout();
      requestAnimationFrame(() => {
        stabilizeNativePreviewLayout();
      });
    });
  }

  function attachNativePlayerToModal() {
    if (!modalState) return;
    const host = document.getElementById("clipyt-player-host");
    const moviePlayer = document.getElementById("movie_player");
    if (!host || !moviePlayer || !moviePlayer.parentElement) {
      if (host) {
        host.innerHTML = '<div class="clipyt-native-unavailable">Live player unavailable. Use the main page player and this modal will keep the timestamp in sync.</div>';
      }
      attachNativeVideoSync();
      return;
    }

    modalState.nativePlayerRestore = {
      node: moviePlayer,
      parent: moviePlayer.parentElement,
      nextSibling: moviePlayer.nextSibling,
      inlineStyle: moviePlayer.getAttribute("style")
    };

    host.appendChild(moviePlayer);
    moviePlayer.classList.add("clipyt-native-player");
    moviePlayer.style.width = "100%";
    moviePlayer.style.height = "100%";

    if (Number.isFinite(modalState.selectedTime)) {
      seekMainVideo(modalState.selectedTime);
    }

    attachNativeVideoSync();
    attachPreviewResizeSync();
    syncFromNativeVideo();
  }

  function stabilizeYouTubePlayerLayout(node) {
    if (!(node instanceof HTMLElement)) return;
    const watchFlexy = document.querySelector("ytd-watch-flexy");
    const moviePlayer = node;

    // YouTube updates player size asynchronously, so trigger resize across frames.
    const bumpResize = () => {
      window.dispatchEvent(new Event("resize"));
      document.dispatchEvent(new Event("resize"));
      if (typeof moviePlayer.updateSize === "function") {
        try {
          moviePlayer.updateSize();
        } catch {
          // no-op
        }
      }
      if (watchFlexy && typeof watchFlexy.calculateCurrentPlayerSize_ === "function") {
        try {
          watchFlexy.calculateCurrentPlayerSize_();
        } catch {
          // no-op
        }
      }
    };

    bumpResize();
    requestAnimationFrame(() => {
      bumpResize();
      requestAnimationFrame(() => {
        bumpResize();
      });
    });
  }

  function restoreNativePlayerFromModal() {
    if (!modalState?.nativePlayerRestore) return;
    const { node, parent, nextSibling, inlineStyle } = modalState.nativePlayerRestore;
    if (!node || !parent) return;

    if (parent.isConnected) {
      if (nextSibling && nextSibling.parentNode === parent) {
        parent.insertBefore(node, nextSibling);
      } else {
        parent.appendChild(node);
      }
    } else {
      const fallbackParent = document.querySelector("#player") || document.querySelector("ytd-watch-flexy");
      if (fallbackParent instanceof HTMLElement) {
        fallbackParent.appendChild(node);
      }
    }

    node.classList.remove("clipyt-native-player");
    if (inlineStyle === null) {
      node.removeAttribute("style");
    } else {
      node.setAttribute("style", inlineStyle);
    }
    stabilizeYouTubePlayerLayout(node);
    modalState.nativePlayerRestore = null;
  }

  function setSignerUi() {
    const badgeEl = document.getElementById("clipyt-signer-badge");
    const detailEl = document.getElementById("clipyt-signer-detail");
    if (!badgeEl || !detailEl) return;

    const signerInfo = modalState?.signerInfo;
    if (!signerInfo || !signerInfo.checked) {
      badgeEl.className = "clipyt-signer-badge pending";
      badgeEl.textContent = "Signer not checked";
      detailEl.textContent = "Use \"Check signer\" before sharing.";
      return;
    }

    if (!signerInfo.available) {
      badgeEl.className = "clipyt-signer-badge offline";
      badgeEl.textContent = "No signer detected";
      detailEl.textContent = "No NIP-07 signer found on this page.";
      return;
    }

    const shortPubkey = signerInfo.pubkey
      ? `${signerInfo.pubkey.slice(0, 8)}...${signerInfo.pubkey.slice(-6)}`
      : "pubkey unavailable";

    badgeEl.className = "clipyt-signer-badge online";
    badgeEl.textContent = `${signerInfo.name || "NIP-07 signer"} connected`;
    detailEl.textContent = `Pubkey: ${shortPubkey}`;
  }

  async function checkSignerConnection(showToastMessage = true) {
    if (!modalState) return null;
    try {
      if (showToastMessage) showToast("Checking signer extension...", "info");
      const signerInfo = await nostrRequest("getSignerInfo", [], 12000);
      if (!signerInfo?.hasNostr) {
        modalState.signerInfo = {
          checked: true,
          available: false,
          name: null,
          pubkey: null
        };
        setSignerUi();
        if (showToastMessage) showToast("No signer detected.", "error");
        return modalState.signerInfo;
      }

      let pubkey = null;
      if (showToastMessage) {
        try {
          pubkey = await nostrRequest("getPublicKey", [], 12000);
        } catch {
          pubkey = null;
        }
      }

      modalState.signerInfo = {
        checked: true,
        available: true,
        name: signerInfo.signerName || "NIP-07 signer",
        methods: Array.isArray(signerInfo.methods) ? signerInfo.methods : [],
        pubkey
      };
      setSignerUi();
      if (showToastMessage) showToast("Signer is available.", "success");
      return modalState.signerInfo;
    } catch (error) {
      modalState.signerInfo = {
        checked: true,
        available: false,
        name: null,
        pubkey: null
      };
      setSignerUi();
      if (showToastMessage) {
        showToast(error instanceof Error ? error.message : "Signer check failed", "error");
      }
      return modalState.signerInfo;
    }
  }

  function renderState() {
    if (!modalState) return;
    const selectedTime = Math.max(0, Math.floor(modalState.selectedTime || 0));
    const duration = Math.max(0, Math.floor(modalState.duration || 0));

    const titleEl = document.getElementById("clipyt-video-title");
    const subEl = document.getElementById("clipyt-video-sub");
    const timeEl = document.getElementById("clipyt-time-value");
    const urlEl = document.getElementById("clipyt-url");
    const notePostEl = document.getElementById("clipyt-note-post");
    const noteImageEl = document.getElementById("clipyt-note-image");
    const noteCardTitleEl = document.getElementById("clipyt-note-card-title");
    const noteCardMetaEl = document.getElementById("clipyt-note-card-meta");
    const noteCardUrlEl = document.getElementById("clipyt-note-card-url");
    const commentEl = document.getElementById("clipyt-comment");
    const saveButtonEl = document.getElementById("clipyt-save-history");

    if (titleEl) titleEl.textContent = modalState.title;
    if (subEl) subEl.textContent = `${modalState.channel} | ${formatTimestamp(selectedTime)}`;
    if (timeEl) {
      timeEl.textContent = duration > 0
        ? `${formatTimestamp(selectedTime)} / ${formatTimestamp(duration)}`
        : formatTimestamp(selectedTime);
    }

    const url = buildTimestampUrl(modalState.videoId, selectedTime);
    if (urlEl) urlEl.value = url;

    if (commentEl && commentEl.value !== (modalState.comment || "")) {
      commentEl.value = modalState.comment || "";
    }

    if (saveButtonEl) {
      saveButtonEl.textContent = modalState.historyId ? "Update history" : "Save to history";
    }

    if (notePostEl) notePostEl.textContent = buildPreviewPostText();
    if (noteImageEl) {
      noteImageEl.src = modalState.previewImage || getDefaultPreview(modalState.videoId);
      noteImageEl.hidden = false;
    }
    if (noteCardTitleEl) noteCardTitleEl.textContent = modalState.title;
    if (noteCardMetaEl) {
      noteCardMetaEl.textContent = `${modalState.channel} · ${formatTimestamp(selectedTime)}`;
    }
    if (noteCardUrlEl) noteCardUrlEl.textContent = url;

    setSignerUi();
  }

  async function renderHistoryList() {
    const listEl = document.getElementById("clipyt-history-list");
    if (!listEl) return;

    const items = await getHistory();
    const sorted = [...items].sort((a, b) => (b.updatedAt || b.savedAt || 0) - (a.updatedAt || a.savedAt || 0));

    if (!sorted.length) {
      listEl.innerHTML = '<div class="clipyt-history-empty">No shares saved yet. Save a timestamp from the Share tab to start building your history.</div>';
      return;
    }

    listEl.innerHTML = sorted
      .map((item) => {
        const ts = formatTimestamp(item.timestamp || 0);
        const date = new Date(item.updatedAt || item.savedAt || Date.now()).toLocaleString();
        const preview = item.previewImage || getDefaultPreview(item.videoId);
        return `
          <div class="clipyt-history-item" data-id="${item.id}">
            <div class="clipyt-history-media">
              <img
                class="clipyt-history-thumb"
                src="${escapeHtml(preview)}"
                data-video-id="${escapeHtml(item.videoId || "")}"
                alt="Saved share preview"
                loading="lazy"
              />
              <span class="clipyt-history-time">${ts}</span>
            </div>
            <div class="clipyt-history-main">
              <h4>${escapeHtml(item.title || "YouTube Video")}</h4>
              <p>${escapeHtml(item.channel || "YouTube")} | ${escapeHtml(date)}</p>
              <div class="clipyt-history-actions">
                <button class="clipyt-btn-secondary" data-action="edit" data-id="${item.id}">Edit</button>
                <button class="clipyt-btn-secondary" data-action="copy" data-id="${item.id}">Copy URL</button>
                <button class="clipyt-btn-danger" data-action="delete" data-id="${item.id}">Delete</button>
              </div>
            </div>
          </div>`;
      })
      .join("");

    listEl.querySelectorAll(".clipyt-history-thumb").forEach((imgEl) => {
      imgEl.addEventListener(
        "error",
        () => {
          const videoId = imgEl.getAttribute("data-video-id") || "";
          if (!videoId) return;
          imgEl.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        },
        { once: true }
      );
    });
  }

  function escapeHtml(input) {
    return String(input)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function saveCurrentToHistory(options = {}) {
    if (!modalState) return;
    const showToastMessage = options.showToastMessage !== false;
    const feedbackMessage = options.feedbackMessage || "Saved to history.";

    const item = {
      id: modalState.historyId || crypto.randomUUID(),
      videoId: modalState.videoId,
      title: modalState.title,
      channel: modalState.channel,
      timestamp: Math.max(0, Math.floor(modalState.selectedTime || 0)),
      previewImage: modalState.previewImage || getDefaultPreview(modalState.videoId),
      comment: modalState.comment || "",
      savedAt: modalState.savedAt || Date.now(),
      updatedAt: Date.now()
    };

    await upsertHistoryItem(item);
    modalState.historyId = item.id;
    modalState.savedAt = item.savedAt;
    showSaveFeedback(feedbackMessage, "success");
    if (showToastMessage) {
      showToast(feedbackMessage, "success");
    }
    renderState();
    if (modalState.activeTab === "history") {
      await renderHistoryList();
    }
  }

  async function applyHistoryItem(item) {
    if (!item) return;

    const currentId = getVideoId();
    if (item.videoId !== currentId) {
      await chrome.storage.local.set({ [PENDING_EDIT_KEY]: item.id });
      location.href = buildTimestampUrl(item.videoId, item.timestamp || 0);
      return;
    }

    modalState.historyId = item.id;
    modalState.title = item.title || modalState.title;
    modalState.channel = item.channel || modalState.channel;
    modalState.selectedTime = item.timestamp || 0;
    modalState.previewImage = item.previewImage || getDefaultPreview(modalState.videoId);
    modalState.comment = item.comment || "";
    modalState.savedAt = item.savedAt || Date.now();

    seekMainVideo(modalState.selectedTime);
    seekMainVideo(modalState.selectedTime);
    syncFromNativeVideo();
    renderState();
    switchTab("share");
    showToast("History item loaded. Adjust timestamp and save to update.", "info");
  }

  async function maybeLoadPendingHistoryEdit() {
    const data = await chrome.storage.local.get(PENDING_EDIT_KEY);
    const pendingId = data[PENDING_EDIT_KEY];
    if (!pendingId) return;

    const items = await getHistory();
    const item = items.find((entry) => entry.id === pendingId);
    if (!item) {
      await chrome.storage.local.remove(PENDING_EDIT_KEY);
      return;
    }

    if (item.videoId === getVideoId()) {
      await chrome.storage.local.remove(PENDING_EDIT_KEY);
      openModal(item);
    }
  }

  async function copyCurrentUrl() {
    if (!modalState) return;
    const url = buildTimestampUrl(modalState.videoId, modalState.selectedTime);
    await navigator.clipboard.writeText(url);
    showToast("Timestamp URL copied.", "success");
  }

  async function shareToNostr() {
    if (!modalState) return;

    try {
      try {
        await saveCurrentToHistory({
          showToastMessage: false,
          feedbackMessage: "Draft auto-saved."
        });
      } catch {
        // Do not block Nostr share if storage fails.
      }

      const signerInfo = await checkSignerConnection(false);
      if (!signerInfo?.available) {
        throw new Error("No active signer. Click \"Check signer\" first.");
      }

      const pubkey = signerInfo.pubkey || await nostrRequest("getPublicKey", [], 12000);
      modalState.signerInfo.pubkey = pubkey;
      setSignerUi();
      const url = buildTimestampUrl(modalState.videoId, modalState.selectedTime);

      const unsignedEvent = {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["r", url],
          ["t", "youtube"],
          ["t", "clip"]
        ],
        content: buildNoteText(),
        pubkey
      };

      showToast("Requesting signature from signer...", "info");
      const signedEvent = await nostrRequest("signEvent", [unsignedEvent]);
      const verifiedEvent = await assertSignedEventIntegrity(unsignedEvent, signedEvent, pubkey);

      let relayMap = {};
      try {
        relayMap = (await nostrRequest("getRelays")) || {};
      } catch {
        relayMap = {};
      }

      const relayUrls = Object.keys(relayMap).filter((relay) => {
        const cfg = relayMap[relay];
        if (!cfg || typeof cfg !== "object") return true;
        return cfg.write !== false;
      });

      showToast("Publishing event to relays...", "info");
      const publishResults = await publishToRelays(verifiedEvent, relayUrls);
      const successCount = publishResults.filter((entry) => entry.ok).length;

      if (successCount === 0) {
        throw new Error("Signed, but failed to publish to relays.");
      }

      showToast(`Shared to Nostr (${successCount} relay${successCount === 1 ? "" : "s"}).`, "success");
      await saveCurrentToHistory({
        showToastMessage: false,
        feedbackMessage: "Saved after Nostr share."
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Nostr share failed", "error");
    }
  }

  function closeModal() {
    if (modalState?.saveFeedbackTimer) {
      clearTimeout(modalState.saveFeedbackTimer);
    }
    if (modalState?.keydownHandler) {
      document.removeEventListener("keydown", modalState.keydownHandler);
    }
    if (modalState?.detachNativeVideoSync) {
      modalState.detachNativeVideoSync();
    }
    if (modalState?.detachPreviewResizeSync) {
      modalState.detachPreviewResizeSync();
    }
    restoreNativePlayerFromModal();
    const overlay = document.getElementById("clipyt-modal-overlay");
    overlay?.remove();
    modalState = null;
  }

  function buildModalTemplate() {
    return `
      <div id="clipyt-modal-overlay" role="dialog" aria-modal="true">
        <div class="clipyt-modal">
          <header class="clipyt-header">
            <div class="clipyt-brand">
              <span class="clipyt-brand-mark"></span>
              <h2>Youtube to Nostr</h2>
            </div>
            <button class="clipyt-close" id="clipyt-close-btn" aria-label="Close">&times;</button>
          </header>

          <nav class="clipyt-tabs">
            <button class="clipyt-tab-btn active" data-clipyt-tab="share">Share</button>
            <button class="clipyt-tab-btn" data-clipyt-tab="history">History</button>
          </nav>

          <div class="clipyt-body">
            <section id="clipyt-tab-share">
              <div class="clipyt-layout">
                <div class="clipyt-card">
                  <div class="clipyt-live-wrap">
                    <div id="clipyt-player-host" class="clipyt-player-host"></div>
                  </div>
                  <h3 id="clipyt-video-title" class="clipyt-video-title"></h3>
                  <p id="clipyt-video-sub" class="clipyt-video-sub"></p>

                  <div class="clipyt-row space-between">
                    <span>Timestamp from preview</span>
                    <span class="clipyt-time" id="clipyt-time-value">00:00 / 00:00</span>
                  </div>

                  <div class="clipyt-row clipyt-url-row">
                    <input id="clipyt-url" class="clipyt-url" readonly />
                    <button id="clipyt-copy" class="clipyt-btn-secondary">Copy URL</button>
                  </div>

                  <div class="clipyt-row">
                    <button id="clipyt-save-history" class="clipyt-btn">Save to history</button>
                  </div>
                  <div id="clipyt-save-feedback" class="clipyt-save-feedback" aria-live="polite"></div>
                </div>

                <div class="clipyt-card">
                  <div class="clipyt-signer-row">
                    <button id="clipyt-check-signer" class="clipyt-btn-secondary">Check signer</button>
                    <span id="clipyt-signer-badge" class="clipyt-signer-badge pending">Signer not checked</span>
                    <button id="clipyt-share-nostr" class="clipyt-btn clipyt-share-top">Share to Nostr</button>
                  </div>
                  <div id="clipyt-signer-detail" class="clipyt-signer-detail">Use "Check signer" before sharing.</div>

                  <label for="clipyt-comment">Comment</label>
                  <textarea id="clipyt-comment" class="clipyt-textarea" placeholder="Add context before publishing..."></textarea>

                  <div class="clipyt-note-preview">
                    <div id="clipyt-note-post" class="clipyt-note-post"></div>
                    <div class="clipyt-note-card">
                      <img id="clipyt-note-image" alt="Nostr note preview image" />
                      <div class="clipyt-note-card-body">
                        <h4 id="clipyt-note-card-title" class="clipyt-note-card-title"></h4>
                        <p id="clipyt-note-card-meta" class="clipyt-note-card-meta"></p>
                        <p id="clipyt-note-card-url" class="clipyt-note-card-url"></p>
                      </div>
                    </div>
                  </div>

                  <div id="clipyt-status" class="clipyt-status"></div>
                </div>
              </div>
            </section>

            <section id="clipyt-tab-history" hidden>
              <div id="clipyt-history-list" class="clipyt-history-list"></div>
            </section>
          </div>
        </div>
      </div>`;
  }

  async function wireModalEvents() {
    const overlay = document.getElementById("clipyt-modal-overlay");
    if (!overlay) return;

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeModal();
    });

    document.getElementById("clipyt-close-btn")?.addEventListener("click", closeModal);

    document.querySelectorAll("[data-clipyt-tab]").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        const tab = tabBtn.getAttribute("data-clipyt-tab") || "share";
        switchTab(tab);
      });
    });

    document.getElementById("clipyt-check-signer")?.addEventListener("click", () => {
      checkSignerConnection(true);
    });

    document.getElementById("clipyt-comment")?.addEventListener("input", (event) => {
      modalState.comment = event.target.value || "";
      renderState();
    });

    document.getElementById("clipyt-copy")?.addEventListener("click", () => {
      copyCurrentUrl().catch((error) => {
        showToast(error instanceof Error ? error.message : "Copy failed", "error");
      });
    });

    document.getElementById("clipyt-save-history")?.addEventListener("click", () => {
      saveCurrentToHistory().catch((error) => {
        showToast(error instanceof Error ? error.message : "Save failed", "error");
      });
    });

    document.getElementById("clipyt-share-nostr")?.addEventListener("click", () => {
      shareToNostr();
    });

    document.getElementById("clipyt-history-list")?.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;

      const action = button.dataset.action;
      const id = button.dataset.id;
      if (!id) return;

      const items = await getHistory();
      const item = items.find((entry) => entry.id === id);
      if (!item) return;

      if (action === "edit") {
        applyHistoryItem(item);
      }

      if (action === "copy") {
        await navigator.clipboard.writeText(buildTimestampUrl(item.videoId, item.timestamp || 0));
        showToast("History URL copied.", "success");
      }

      if (action === "delete") {
        await deleteHistoryItem(id);
        renderHistoryList();
        showToast("History item deleted.", "success");
      }
    });

    const onKeyDown = (event) => {
      if (event.key === "Escape" && document.getElementById("clipyt-modal-overlay")) {
        closeModal();
      }
    };
    modalState.keydownHandler = onKeyDown;
    document.addEventListener("keydown", onKeyDown);

    attachNativePlayerToModal();
    checkSignerConnection(false);

    await renderHistoryList();
  }

  async function openModal(seedItem = null) {
    if (!isWatchPage()) return;

    closeModal();

    const videoId = getVideoId();
    if (!videoId) return;

    modalState = {
      videoId,
      title: getVideoTitle(),
      channel: getChannelName(),
      duration: getDuration(),
      selectedTime: getCurrentTime(),
      previewImage: getDefaultPreview(videoId),
      comment: "",
      historyId: null,
      savedAt: null,
      activeTab: "share",
      keydownHandler: null,
      nativePlayerRestore: null,
      detachNativeVideoSync: null,
      detachPreviewResizeSync: null,
      saveFeedbackTimer: null,
      signerInfo: {
        checked: false,
        available: false,
        name: null,
        pubkey: null
      }
    };

    if (seedItem) {
      modalState.historyId = seedItem.id;
      modalState.selectedTime = seedItem.timestamp || modalState.selectedTime;
      modalState.previewImage = seedItem.previewImage || modalState.previewImage;
      modalState.comment = seedItem.comment || "";
      modalState.savedAt = seedItem.savedAt || Date.now();
    }

    document.body.insertAdjacentHTML("beforeend", buildModalTemplate());

    const video = getVideoEl();
    if (video && !modalState.duration) {
      const updateDuration = () => {
        modalState.duration = getDuration();
        renderState();
      };
      video.addEventListener("loadedmetadata", updateDuration, { once: true });
      setTimeout(updateDuration, 600);
    }

    await wireModalEvents();
    renderState();
  }

  async function autoBindPendingItemAndButton() {
    scheduleEnsureShareButton();
    await maybeLoadPendingHistoryEdit();
  }

  function watchForRouteChanges() {
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        closeModal();
        scheduleEnsureShareButton();
      }
      ensureShareButton();
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener("yt-navigate-finish", () => {
      lastUrl = location.href;
      closeModal();
      scheduleEnsureShareButton();
      setTimeout(() => autoBindPendingItemAndButton(), 220);
    });

    window.addEventListener("yt-page-data-updated", () => {
      scheduleEnsureShareButton();
    });

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        closeModal();
        autoBindPendingItemAndButton();
      }
    }, 1000);
  }

  autoBindPendingItemAndButton();
  watchForRouteChanges();
})();
