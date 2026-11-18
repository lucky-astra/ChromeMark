import { listItems } from "./db.js";

const $ = selector => document.querySelector(selector);
let items = [];
let visibleItems = [];
let selectedIndex = 0;
let closeTimer;

async function initialize() {
  try {
    const local = await chrome.storage.local.get("settings");
    applyQuickTheme(local.settings?.theme || "system");
    items = await listItems();
    renderResults();
  } catch {
    $("#quickResults").innerHTML = '<div class="quick-empty"><strong>素材库暂时无法读取</strong>请重新打开快速调用面板。</div>';
  }
  $("#quickSearch").addEventListener("input", () => { selectedIndex = 0; renderResults(); });
  $("#quickResults").addEventListener("click", event => {
    const row = event.target.closest("[data-id]");
    const item = visibleItems.find(entry => entry.id === row?.dataset.id);
    if (item) useItem(item, false);
  });
  $("#closeQuick").addEventListener("click", () => window.close());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); window.close(); }
    if (event.key === "ArrowDown" && visibleItems.length) { event.preventDefault(); selectedIndex = (selectedIndex + 1) % visibleItems.length; renderResults(false); }
    if (event.key === "ArrowUp" && visibleItems.length) { event.preventDefault(); selectedIndex = (selectedIndex - 1 + visibleItems.length) % visibleItems.length; renderResults(false); }
    if (event.key === "Enter" && visibleItems[selectedIndex]) { event.preventDefault(); useItem(visibleItems[selectedIndex], event.shiftKey); }
  });
  setTimeout(() => $("#quickSearch").focus(), 40);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    chrome.storage.local.get("settings").then(({ settings }) => { if ((settings?.theme || "system") === "system") applyQuickTheme("system"); });
  });
}

function applyQuickTheme(theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.dataset.theme = dark ? "dark" : "light";
}

function renderResults(reset = true) {
  if (reset) selectedIndex = 0;
  const query = $("#quickSearch").value.trim().toLocaleLowerCase();
  visibleItems = items.filter(item => {
    const text = [item.content, item.note, item.sourceTitle, item.sourceDomain, ...(item.tags || [])].join(" ").toLocaleLowerCase();
    return !query || text.includes(query);
  }).sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.copyCount || 0) - (a.copyCount || 0) || dateValue(b.createdAt) - dateValue(a.createdAt)).slice(0, 14);
  const host = $("#quickResults");
  if (!visibleItems.length) {
    host.innerHTML = `<div class="quick-empty"><strong>${query ? "没有找到匹配的收藏" : "还没有可以调用的内容"}</strong>${query ? "试试其他关键词。" : "在网页选中内容后收藏，或先在素材库新建一条。"}</div>`;
    return;
  }
  host.innerHTML = visibleItems.map((item, index) => {
    const text = item.content || item.originalUrl || "网页图片";
    return `<button class="quick-result ${index === selectedIndex ? "active" : ""}" data-id="${escapeHtml(item.id)}" title="按 Enter 使用这条收藏">
      <span class="quick-result-top">${item.favorite ? '<span class="quick-star">★</span>' : ""}<span class="quick-kind">${item.type === "image" ? "图片" : "文本"}</span><span class="quick-source">${escapeHtml(item.sourceDomain || "本机收藏")}</span></span>
      <span class="quick-result-copy">${escapeHtml(text)}</span>
    </button>`;
  }).join("");
  host.querySelector(".quick-result.active")?.scrollIntoView({ block: "nearest" });
}

async function useItem(item, copyOnly) {
  const text = item.content || item.originalUrl || "";
  if (!text) return showResult("这条图片收藏没有可复制的标题或地址");
  try {
    const result = await chrome.runtime.sendMessage({ type: "quick-use", itemId: item.id, text, copyOnly });
    if (result?.inserted) {
      showResult("已插入当前输入框");
    } else {
      await navigator.clipboard.writeText(text);
      showResult(copyOnly ? "已复制到剪贴板" : "未找到输入框，已复制到剪贴板");
    }
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => window.close(), 650);
  } catch {
    showResult("无法使用剪贴板，请检查浏览器权限");
  }
}

function showResult(text) {
  const toast = $("#quickToast");
  toast.textContent = text;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 1300);
}

function dateValue(value) { const date = new Date(value).getTime(); return Number.isFinite(date) ? date : 0; }
function escapeHtml(value = "") { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

initialize();
