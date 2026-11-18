import { getItem, listItems, normalizeItem, putItem, removeItem, replaceItems, saveImageBlob } from "./db.js";

const DEFAULT_CATEGORIES = [
  { id: "inbox", name: "收件箱", icon: "▧" },
  { id: "writing", name: "写作", icon: "✎" },
  { id: "speech", name: "演讲", icon: "◌" },
  { id: "emotion", name: "情感", icon: "♡" },
  { id: "inspiration", name: "灵感", icon: "✦" },
  { id: "design", name: "设计", icon: "◈" }
];

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["categories", "settings"]);
  if (!current.categories) await chrome.storage.local.set({ categories: DEFAULT_CATEGORIES });
  if (!current.settings) await chrome.storage.local.set({ settings: defaultSettings() });
  createContextMenus();
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

function defaultSettings() {
  return { enhancedMode: false, imageHover: true, selectionButton: true, showToasts: true, defaultCategory: "inbox", theme: "system" };
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "save-selection", title: "收藏选中文字", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "save-image", title: "收藏此图片", contexts: ["image"] });
    chrome.contextMenus.create({ id: "open-library", title: "打开 ChromeMark 素材库", contexts: ["page", "selection", "image"] });
    chrome.contextMenus.create({ id: "open-quick", title: "打开快速调用面板", contexts: ["page", "selection", "image"] });
  });
}

function draftFromContext(info, tab) {
  const sourceUrl = info.pageUrl || tab?.url || "";
  return {
    type: info.mediaType === "image" || info.srcUrl ? "image" : "text",
    content: info.selectionText || info.srcUrl || "",
    originalUrl: info.srcUrl || "",
    sourceTitle: tab?.title || "",
    sourceUrl,
    sourceDomain: domainFromUrl(sourceUrl)
  };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "save-selection" || info.menuItemId === "save-image") {
    await saveDraft(draftFromContext(info, tab), true);
  } else if (info.menuItemId === "open-library" && tab?.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  } else if (info.menuItemId === "open-quick") {
    await openQuickPanel(tab?.id);
  }
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== "quick-open") return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  await openQuickPanel(tab?.id);
});

async function openQuickPanel(tabId) {
  await chrome.storage.session.set({ quickTargetTabId: tabId || null });
  await chrome.windows.create({ url: chrome.runtime.getURL("quick.html"), type: "popup", width: 420, height: 590, focused: true });
}

async function saveDraft(input, quick = false) {
  const { categories = DEFAULT_CATEGORIES, settings = defaultSettings() } = await chrome.storage.local.get(["categories", "settings"]);
  const categoryId = quick ? settings.defaultCategory || "inbox" : input.categoryId || settings.defaultCategory || "inbox";
  const image = input.type === "image" && !input.imageBlob ? await saveImageBlob(input.originalUrl) : null;
  const item = normalizeItem({ ...input, categoryId, ...(image ? { imageBlob: image.blob, imageMimeType: image.mimeType, imageFileSize: image.fileSize } : {}) });
  await putItem(item);
  return { category: categories.find(category => category.id === item.categoryId)?.name || "收件箱" };
}

async function openEditor(draft, tabId) {
  await chrome.storage.session.set({ pendingDraft: draft });
  if (!tabId) return;
  try {
    await chrome.sidePanel.open({ tabId });
  } catch {
    await chrome.windows.create({ url: chrome.runtime.getURL("panel.html"), type: "popup", width: 470, height: 760, focused: true });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "save-quick":
        sendResponse({ ok: true, ...(await saveDraft(message.draft, true)) });
        break;
      case "open-editor":
        await openEditor(message.draft, sender.tab?.id);
        sendResponse({ ok: true });
        break;
      case "open-quick-from-panel": {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await openQuickPanel(tab?.id);
        sendResponse({ ok: true });
        break;
      }
      case "save-item": {
        const existing = message.item.id ? await getItem(message.item.id) : null;
        const categoryId = message.item.categoryId || "inbox";
        const image = message.item.type === "image" && !message.item.imageBlob && !existing?.imageBlob
          ? await saveImageBlob(message.item.originalUrl)
          : null;
        const item = normalizeItem({ ...message.item, categoryId, ...(image ? { imageBlob: image.blob, imageMimeType: image.mimeType, imageFileSize: image.fileSize } : {}) }, existing);
        await putItem(item);
        sendResponse({ ok: true });
        break;
      }
      case "remove-item":
        await removeItem(message.id);
        sendResponse({ ok: true });
        break;
      case "import-data": {
        const { data, mode } = message;
        if (!data || data.version !== 1 || !Array.isArray(data.items) || !Array.isArray(data.categories)) throw new Error("这不是有效的 ChromeMark 备份文件。");
        const categoryIds = new Set();
        const validCategories = data.categories.filter(category => {
          if (!category || typeof category.id !== "string" || typeof category.name !== "string" || !category.id || categoryIds.has(category.id)) return false;
          categoryIds.add(category.id);
          return true;
        }).map(category => ({ id: category.id, name: category.name, icon: String(category.icon || "◦") }));
        const importedCategories = validCategories.length ? validCategories : DEFAULT_CATEGORIES;
        if (!importedCategories.some(category => category.id === "inbox")) importedCategories.unshift(DEFAULT_CATEGORIES[0]);
        const importedCategoryIds = new Set(importedCategories.map(category => category.id));
        const validItems = data.items.filter(item => item && (item.type === "text" || item.type === "image") && typeof item.id === "string" && item.id).map(item => normalizeItem({ ...item, categoryId: importedCategoryIds.has(item.categoryId) ? item.categoryId : "inbox" }, item));
        if (mode === "replace") {
          await replaceItems(validItems);
          const importedSettings = { ...defaultSettings(), ...(data.settings || {}), enhancedMode: false };
          importedSettings.defaultCategory = importedCategoryIds.has(importedSettings.defaultCategory) ? importedSettings.defaultCategory : "inbox";
          if (!["system", "light", "dark"].includes(importedSettings.theme)) importedSettings.theme = "system";
          await chrome.storage.local.set({ categories: importedCategories, settings: importedSettings });
        } else {
          const existing = await listItems();
          const ids = new Set(existing.map(item => item.id));
          const merged = [...existing, ...validItems.filter(item => !ids.has(item.id))];
          await replaceItems(merged);
          const local = await chrome.storage.local.get("categories");
          const categories = local.categories || DEFAULT_CATEGORIES;
          const known = new Set(categories.map(category => category.id));
          await chrome.storage.local.set({ categories: [...categories, ...importedCategories.filter(category => !known.has(category.id))] });
        }
        sendResponse({ ok: true, count: validItems.length });
        break;
      }
      case "update-settings":
        await chrome.storage.local.set({ settings: message.settings });
        sendResponse({ ok: true });
        break;
      case "update-categories":
        await chrome.storage.local.set({ categories: message.categories });
        sendResponse({ ok: true });
        break;
      case "clear-data":
        await replaceItems([]);
        await chrome.storage.local.set({ categories: DEFAULT_CATEGORIES, settings: defaultSettings() });
        sendResponse({ ok: true });
        break;
      case "quick-use":
        sendResponse(await useQuickItem(message.text, message.copyOnly, message.itemId));
        break;
      default:
        sendResponse({ ok: false, error: "未知操作" });
    }
  })().catch(error => sendResponse({ ok: false, error: error.message || "操作失败" }));
  return true;
});

async function useQuickItem(text, copyOnly, itemId) {
  if (itemId) {
    const item = await getItem(itemId);
    if (item) await putItem(normalizeItem({ ...item, copyCount: (item.copyCount || 0) + 1, lastCopiedAt: new Date().toISOString() }, item));
  }
  const { quickTargetTabId } = await chrome.storage.session.get("quickTargetTabId");
  if (!copyOnly && quickTargetTabId) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: quickTargetTabId },
        func: value => {
          const element = document.activeElement;
          if (!element) return false;
          const tag = element.tagName?.toLowerCase();
          if ((tag === "input" && /^(text|search|url|email|tel|password)?$/i.test(element.type || "text")) || tag === "textarea") {
            const start = element.selectionStart ?? element.value.length;
            const end = element.selectionEnd ?? start;
            element.setRangeText(value, start, end, "end");
            element.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
          }
          if (element.isContentEditable) {
            return document.execCommand("insertText", false, value);
          }
          return false;
        },
        args: [text]
      });
      if (result?.result) return { ok: true, inserted: true };
    } catch { /* A protected page or missing grant falls back to clipboard. */ }
  }
  return { ok: true, inserted: false, copied: true };
}

function domainFromUrl(value = "") {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return ""; }
}
