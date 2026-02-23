(() => {
  const REQUEST_TYPE = "CLIPYT_NOSTR_REQUEST";
  const RESPONSE_TYPE = "CLIPYT_NOSTR_RESPONSE";
  const READY_TYPE = "CLIPYT_NOSTR_BRIDGE_READY";
  const SRC_IN = "clipyt-extension";
  const SRC_OUT = "clipyt-page";
  const BRIDGE_TOKEN = document.currentScript?.dataset?.clipytToken || null;
  const ALLOWED_METHODS = new Set(["hasNostr", "getSignerInfo", "getPublicKey", "signEvent", "getRelays"]);

  function getSignerInfo() {
    const signer = window.nostr;
    if (!signer) {
      return {
        hasNostr: false,
        signerName: null,
        methods: []
      };
    }

    const methodNames = Object.keys(signer).filter((key) => typeof signer[key] === "function");
    const maybeName = [
      signer.name,
      signer.signerName,
      signer.provider,
      signer.client,
      signer._provider,
      signer._client,
      signer.constructor?.name
    ].find((value) => {
      if (typeof value !== "string") return false;
      const cleaned = value.trim();
      if (!cleaned) return false;
      if (cleaned.toLowerCase() === "object") return false;
      return true;
    });

    return {
      hasNostr: true,
      signerName: maybeName || "NIP-07 signer",
      methods: methodNames
    };
  }

  async function handleMessage(event) {
    if (event.source !== window || !event.data) return;
    const data = event.data;
    if (data.source !== SRC_IN || data.type !== REQUEST_TYPE) return;
    if (!BRIDGE_TOKEN || data.bridgeToken !== BRIDGE_TOKEN) return;

    const { id, method, params } = data;
    try {
      if (!ALLOWED_METHODS.has(method)) {
        throw new Error(`Signer method blocked: ${method}`);
      }
      let result;
      if (method === "hasNostr") {
        result = Boolean(window.nostr);
      } else if (method === "getSignerInfo") {
        result = getSignerInfo();
      } else {
        if (!window.nostr) throw new Error("Nostr signer extension not found");
        if (typeof window.nostr[method] !== "function") {
          throw new Error(`Signer method not available: ${method}`);
        }
        result = await window.nostr[method](...(Array.isArray(params) ? params : []));
      }

      window.postMessage(
        {
          source: SRC_OUT,
          type: RESPONSE_TYPE,
          id,
          bridgeToken: BRIDGE_TOKEN,
          ok: true,
          result
        },
        "*"
      );
    } catch (error) {
      window.postMessage(
        {
          source: SRC_OUT,
          type: RESPONSE_TYPE,
          id,
          bridgeToken: BRIDGE_TOKEN,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        },
        "*"
      );
    }
  }

  window.addEventListener("message", handleMessage);

  window.postMessage(
    {
      source: SRC_OUT,
      type: READY_TYPE,
      bridgeToken: BRIDGE_TOKEN
    },
    "*"
  );
})();
