(() => {
  if (window.__chromemarkInitialized) return;
  window.__chromemarkInitialized = true;

  const host = document.createElement("div");
  host.setAttribute("data-chromemark-host", "");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#27334a}
      .toolbar{position:fixed;display:none;align-items:center;gap:3px;padding:4px;background:rgba(255,255,255,.97);border:1px solid #e6ebf3;border-radius:10px;box-shadow:0 7px 26px rgba(31,46,78,.2);backdrop-filter:blur(12px);pointer-events:auto;white-space:nowrap;animation:in .13s ease-out}
      .toolbar.show{display:flex}@keyframes in{from{opacity:0;transform:translateY(3px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
      button{font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;border:0;cursor:pointer;transition:.15s}
      .save{height:27px;display:flex;align-items:center;gap:6px;padding:0 9px;border-radius:7px;color:#fff;background:#4367ed;box-shadow:0 2px 5px #4367ed35}
      .save:hover{background:#2d51d5}.save-icon{font-size:13px;font-weight:400}.details{height:27px;width:27px;border-radius:7px;background:transparent;color:#8792a5;font-size:15px;letter-spacing:1px;padding:0}.details:hover{background:#f1f4fa;color:#4367ed}
      .toast{position:fixed;display:none;align-items:center;gap:7px;padding:8px 11px;border-radius:8px;background:#25334b;color:#fff;font:11px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 7px 20px #1d2b4533;pointer-events:none;white-space:nowrap}.toast.show{display:flex;animation:in .16s ease-out}.check{width:16px;height:16px;border-radius:50%;background:#52bd91;display:grid;place-items:center;font-size:10px}
      @media(prefers-reduced-motion:reduce){.toolbar,.toast{animation:none!important;transition:none!important}}
    </style>
    <div class="toolbar" role="toolbar" aria-label="ChromeMark 收藏">
      <button class="save" data-action="save"><span class="save-icon">✦</span><span class="save-label">收藏</span></button>
      <button class="details" data-action="details" aria-label="编辑后收藏" title="编辑后收藏">···</button>
    </div>
    <div class="toast"><span class="check">✓</span><span class="toast-label">已收藏</span></div>`;
  (document.documentElement || document.body).append(host);
  const toolbar = shadow.querySelector(".toolbar");
  const toast = shadow.querySelector(".toast");
  let settings = { enhancedMode: false, selectionButton: true, imageHover: true, showToasts: true, defaultCategory: "inbox" };
  let currentDraft = null;
  let hoveredImage = null;
  let hideTimer = 0;
  let toastTimer = 0;

  chrome.storage.local.get("settings").then(({ settings: saved }) => {
    if (saved) settings = { ...settings, ...saved };
  }).catch(() => {});

  function sourceFor(type, content, image) {
    const sourceUrl = location.href;
    return {
      type,
      content,
      originalUrl: image?.currentSrc || image?.src || "",
      sourceTitle: document.title || location.hostname,
      sourceUrl,
      sourceDomain: location.hostname.replace(/^www\./, "")
    };
  }

  function positionToolbar(left, top, mode) {
    const width = mode === "image" ? 101 : 91;
    const x = Math.max(8, Math.min(window.innerWidth - width - 8, left));
    const y = Math.max(8, Math.min(window.innerHeight - 43, top));
    toolbar.style.left = `${x}px`;
    toolbar.style.top = `${y}px`;
    toolbar.querySelector(".save-label").textContent = mode === "image" ? "收藏图片" : "收藏";
    toolbar.querySelector(".save-icon").textContent = mode === "image" ? "▧" : "✦";
    toolbar.classList.add("show");
  }

  function selectionChanged() {
    if (!settings.enhancedMode || !settings.selectionButton || shadow.contains(document.activeElement)) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text || !selection.rangeCount) return hideToolbar();
    const range = selection.getRangeAt(0);
    if (host.contains(range.commonAncestorContainer)) return hideToolbar();
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return hideToolbar();
    hoveredImage = null;
    currentDraft = sourceFor("text", text);
    positionToolbar(rect.right + 9, rect.bottom + 9, "text");
  }

  function imageOver(event) {
    if (!settings.enhancedMode || !settings.imageHover || host.contains(event.target)) return;
    const image = event.target?.closest?.("img");
    if (!image || image === hoveredImage || image.naturalWidth < 72 || image.naturalHeight < 52) return;
    clearTimeout(hideTimer);
    hoveredImage = image;
    const bounds = image.getBoundingClientRect();
    currentDraft = sourceFor("image", image.alt || image.title || "", image);
    positionToolbar(bounds.right - 105, bounds.top + 8, "image");
  }

  function scheduleHide(event) {
    if (!hoveredImage || event.target !== hoveredImage || (event.relatedTarget && (host.contains(event.relatedTarget) || hoveredImage.contains(event.relatedTarget)))) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!shadow.querySelector(":hover")) hideToolbar();
    }, 360);
  }

  function hideToolbar() {
    toolbar.classList.remove("show");
    hoveredImage = null;
    currentDraft = null;
  }

  function showToast(text) {
    if (!settings.showToasts) return;
    toast.querySelector(".toast-label").textContent = text;
    toast.style.left = `${Math.max(8, Math.min(window.innerWidth - 210, parseFloat(toolbar.style.left) || 12))}px`;
    toast.style.top = `${Math.max(8, (parseFloat(toolbar.style.top) || 12) + 37)}px`;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1700);
  }

  toolbar.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  toolbar.addEventListener("pointerleave", () => {
    if (hoveredImage) scheduleHide({ target: hoveredImage, relatedTarget: null });
  });
  toolbar.addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");
    if (!button || !currentDraft) return;
    event.preventDefault();
    event.stopPropagation();
    const draft = { ...currentDraft };
    if (button.dataset.action === "details") {
      hideToolbar();
      chrome.runtime.sendMessage({ type: "open-editor", draft }).catch(() => {});
      return;
    }
    try {
      const result = await chrome.runtime.sendMessage({ type: "save-quick", draft });
      showToast(result?.ok ? `已收藏到「${result.category}」` : "收藏失败，请稍后重试");
      hideToolbar();
    } catch {
      showToast("收藏失败，请稍后重试");
    }
  });

  document.addEventListener("mouseup", () => setTimeout(selectionChanged, 25), true);
  document.addEventListener("pointerover", imageOver, true);
  document.addEventListener("pointerout", scheduleHide, true);
  document.addEventListener("pointerdown", event => {
    if (!host.contains(event.target) && !window.getSelection()?.toString().trim()) hideToolbar();
  }, true);
  document.addEventListener("keydown", event => { if (event.key === "Escape") hideToolbar(); }, true);
  window.addEventListener("scroll", () => {
    if (hoveredImage?.isConnected) {
      const bounds = hoveredImage.getBoundingClientRect();
      positionToolbar(bounds.right - 105, bounds.top + 8, "image");
    } else if (toolbar.classList.contains("show")) hideToolbar();
  }, true);
  function applySettings(value) {
    settings = { ...settings, ...value };
    if (!settings.enhancedMode || (currentDraft?.type === "image" && !settings.imageHover) || (currentDraft?.type === "text" && !settings.selectionButton)) hideToolbar();
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "collector-settings") applySettings(message.settings);
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.settings?.newValue) return;
    applySettings(changes.settings.newValue);
  });
})();
