import { listItems } from "./db.js";

const DEFAULT_CATEGORIES = [
  { id: "inbox", name: "收件箱", icon: "▧" }, { id: "writing", name: "写作", icon: "✎" },
  { id: "speech", name: "演讲", icon: "◌" }, { id: "emotion", name: "情感", icon: "♡" },
  { id: "inspiration", name: "灵感", icon: "✦" }, { id: "design", name: "设计", icon: "◈" }
];
const DEFAULT_SETTINGS = { enhancedMode: false, imageHover: true, selectionButton: true, showToasts: true, defaultCategory: "inbox", theme: "system" };
const $ = selector => document.querySelector(selector);
let items = [];
let categories = [...DEFAULT_CATEGORIES];
let settings = { ...DEFAULT_SETTINGS };
let activeType = "all";
let selectedItem = null;
let imageObjectUrls = [];
let toastTimer;

async function message(type, values = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...values });
  if (!result?.ok) throw new Error(result?.error || "操作没有完成，请重试。");
  return result;
}

async function initialize() {
  try {
    const local = await chrome.storage.local.get(["categories", "settings"]);
    categories = local.categories || [...DEFAULT_CATEGORIES];
    settings = { ...DEFAULT_SETTINGS, ...(local.settings || {}) };
    await reloadItems();
    renderSettings();
    applyTheme();
    wireEvents();
    await consumePendingDraft();
  } catch (error) {
    showToast(error.message);
  }
}

async function reloadItems() {
  items = await listItems();
  renderCategoryOptions();
  renderLibrary();
}

function wireEvents() {
  $("#homeButton").addEventListener("click", showLibrary);
  $("#settingsButton").addEventListener("click", showSettings);
  $("#quickLaunch").addEventListener("click", async () => {
    try { await message("open-quick-from-panel"); } catch (error) { showToast(error.message); }
  });
  $("#backButton").addEventListener("click", showLibrary);
  $("#createButton").addEventListener("click", () => openDialog());
  $("#emptyCreateButton").addEventListener("click", () => openDialog());
  $("#searchInput").addEventListener("input", renderLibrary);
  $("#categoryFilter").addEventListener("change", renderLibrary);
  $("#sortSelect").addEventListener("change", renderLibrary);
  $("#typeFilters").addEventListener("click", event => {
    const button = event.target.closest("[data-type]");
    if (!button) return;
    activeType = button.dataset.type;
    $("#typeFilters").querySelectorAll(".filter-tab").forEach(tab => tab.classList.toggle("active", tab === button));
    renderLibrary();
  });
  $("#collectionList").addEventListener("click", onCardAction);
  $("#collectionList").addEventListener("error", event => {
    if (!event.target.matches(".card-image")) return;
    const fallback = document.createElement("div");
    fallback.className = "image-unavailable";
    fallback.textContent = "图片暂时无法加载";
    event.target.replaceWith(fallback);
  }, true);
  $("#closeDialog").addEventListener("click", closeDialog);
  $("#cancelDialog").addEventListener("click", closeDialog);
  $("#dialogBackdrop").addEventListener("click", event => { if (event.target === $("#dialogBackdrop")) closeDialog(); });
  $("#saveDialogButton").addEventListener("click", saveDialog);
  $("#dialogCategory").addEventListener("change", onDialogCategoryChange);
  $("#enhancedToggle").addEventListener("click", toggleEnhancedMode);
  $("#imageHoverToggle").addEventListener("click", () => updateSetting("imageHover", !settings.imageHover));
  $("#toastToggle").addEventListener("click", () => updateSetting("showToasts", !settings.showToasts));
  $("#defaultCategory").addEventListener("change", event => updateSetting("defaultCategory", event.target.value));
  $("#themeSelect").addEventListener("change", event => updateSetting("theme", event.target.value));
  $("#addCategoryButton").addEventListener("click", addCategory);
  $("#categoryManager").addEventListener("click", onCategoryAction);
  $("#exportButton").addEventListener("click", exportData);
  $("#importInput").addEventListener("change", importFile);
  $("#clearButton").addEventListener("click", clearData);
  $(".search-box kbd").addEventListener("click", () => $("#searchInput").focus());
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      showLibrary();
      $("#searchInput").focus();
    } else if (event.key === "Escape" && !$("#dialogBackdrop").hidden) closeDialog();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "session" && changes.pendingDraft?.newValue) consumePendingDraft(changes.pendingDraft.newValue);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (settings.theme === "system") applyTheme(); });
}

function renderCategoryOptions() {
  const options = categories.map(category => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.icon || "◦")} ${escapeHtml(category.name)}</option>`).join("");
  $("#categoryFilter").innerHTML = `<option value="all">全部分类</option>${options}`;
  $("#dialogCategory").innerHTML = `${options}<option value="__new">＋ 新建分类…</option>`;
  $("#defaultCategory").innerHTML = options;
  if (!categories.some(category => category.id === settings.defaultCategory)) settings.defaultCategory = "inbox";
  $("#defaultCategory").value = settings.defaultCategory;
  $("#categoryManager").innerHTML = categories.map((category, index) => `<span class="category-chip" data-category-id="${escapeHtml(category.id)}">${escapeHtml(category.icon || "◦")} ${escapeHtml(category.name)}${category.id !== "inbox" ? `<button data-action="up" aria-label="上移${escapeHtml(category.name)}" ${index === 1 ? "disabled" : ""}>↑</button><button data-action="down" aria-label="下移${escapeHtml(category.name)}" ${index === categories.length - 1 ? "disabled" : ""}>↓</button><button data-action="rename" aria-label="重命名${escapeHtml(category.name)}">✎</button><button data-action="delete" aria-label="删除${escapeHtml(category.name)}">×</button>` : ""}</span>`).join("");
}

function renderLibrary() {
  const query = $("#searchInput").value.trim().toLocaleLowerCase();
  const categoryId = $("#categoryFilter").value || "all";
  const filtered = items.filter(item => {
    if (activeType === "text" && item.type !== "text") return false;
    if (activeType === "image" && item.type !== "image") return false;
    if (activeType === "starred" && !item.favorite) return false;
    if (categoryId !== "all" && item.categoryId !== categoryId) return false;
    if (query) {
      const categoryName = categories.find(category => category.id === item.categoryId)?.name || "";
      const haystack = [item.content, item.note, item.sourceTitle, item.sourceDomain, item.sourceUrl, categoryName, ...(item.tags || [])].join(" ").toLocaleLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
  const sort = $("#sortSelect").value;
  filtered.sort((a, b) => sort === "oldest" ? dateValue(a.createdAt) - dateValue(b.createdAt)
    : sort === "updated" ? dateValue(b.updatedAt) - dateValue(a.updatedAt)
      : sort === "used" ? (b.copyCount || 0) - (a.copyCount || 0) || dateValue(b.createdAt) - dateValue(a.createdAt)
        : dateValue(b.createdAt) - dateValue(a.createdAt));

  $("#allCount").textContent = String(items.length);
  $("#resultCount").textContent = `${filtered.length} 条收藏`;
  const activeCategory = categories.find(category => category.id === categoryId);
  $("#activeCategoryLabel").textContent = activeCategory ? activeCategory.name : "全部分类";
  $("#collectionList").innerHTML = "";
  imageObjectUrls.forEach(url => URL.revokeObjectURL(url));
  imageObjectUrls = [];
  for (const item of filtered) $("#collectionList").insertAdjacentHTML("beforeend", cardMarkup(item));

  const empty = filtered.length === 0;
  $("#emptyState").hidden = !empty;
  if (empty) {
    const hasAny = items.length > 0;
    $("#emptyTitle").textContent = hasAny ? "没有找到匹配的收藏" : "你的灵感库还很安静";
    $("#emptyCopy").textContent = hasAny ? "试试其他关键词，或换一个分类看看。" : "在网页选中文字或悬停图片，把值得留下的内容收进来。";
    $("#emptyCreateButton").hidden = hasAny;
  }
}

function cardMarkup(item) {
  const category = categories.find(entry => entry.id === item.categoryId)?.name || "收件箱";
  const imageUrl = item.imageBlob ? objectUrl(item.imageBlob) : safeUrl(item.originalUrl);
  const sourceUrl = safeUrl(item.sourceUrl);
  const source = item.sourceDomain || domainFromUrl(item.sourceUrl) || "本地收藏";
  const displayText = item.content || (item.type === "image" ? "网页图片" : "（空内容）");
  const tags = (item.tags || []).map(tag => `<span class="card-tag">#${escapeHtml(tag)}</span>`).join("");
  const date = formatDate(item.createdAt);
  return `<article class="collection-card" data-id="${escapeHtml(item.id)}">
    <div class="card-topline"><span class="kind-badge ${item.type === "image" ? "image-kind" : ""}">${item.type === "image" ? "▧ 图片" : "¶ 文本"}</span><span class="category-badge">${escapeHtml(category)}</span><time class="card-date">${date}</time></div>
    ${item.type === "image" && imageUrl ? `<img class="card-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(displayText)}" loading="lazy">` : ""}
    ${displayText ? `<p class="card-copy">${escapeHtml(displayText)}</p>` : ""}
    ${item.note ? `<p class="card-note">${escapeHtml(item.note)}</p>` : ""}
    ${tags ? `<div class="card-tags">${tags}</div>` : ""}
    <div class="card-footer"><a class="source-link" ${sourceUrl ? `href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer"` : ""} title="${escapeHtml(item.sourceTitle || source)}"><span class="source-favicon">↗</span>${escapeHtml(source)}</a>
      <div class="card-actions"><button class="small-action favorite-action ${item.favorite ? "is-favorite" : ""}" data-action="favorite" title="${item.favorite ? "取消星标" : "添加星标"}" aria-label="${item.favorite ? "取消星标" : "添加星标"}">${item.favorite ? "★" : "☆"}</button><button class="small-action copy-action" data-action="copy">${item.type === "image" ? item.imageBlob ? "复制图片" : "复制地址" : "复制"}</button><div class="more-wrap"><button class="small-action more-action" data-action="more" aria-label="更多操作">···</button><div class="more-menu"><button data-action="edit">编辑收藏</button><button data-action="move">移动分类</button>${item.type === "image" ? '<button data-action="copy-image-url">复制图片地址</button>' : ""}<button data-action="copy-source">复制来源链接</button><button data-action="open-source">打开来源</button><button class="delete-item" data-action="delete">删除收藏</button></div></div></div>
    </div>
  </article>`;
}

function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  imageObjectUrls.push(url);
  return url;
}

async function onCardAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const card = button.closest(".collection-card");
  const item = items.find(entry => entry.id === card?.dataset.id);
  if (!item) return;
  switch (button.dataset.action) {
    case "favorite":
      await updateItem(item, { favorite: !item.favorite });
      break;
    case "copy":
      try {
        let copiedImage = false;
        if (item.type === "image" && item.imageBlob) {
          try {
            await copyImageToClipboard(item.imageBlob);
            copiedImage = true;
          } catch {
            if (!safeUrl(item.originalUrl)) throw new Error("无法复制此图片");
            await navigator.clipboard.writeText(item.originalUrl);
          }
        } else {
          const value = item.type === "image" ? item.originalUrl || item.content || "" : item.content || "";
          if (!value) return showToast("这条收藏没有可复制的内容");
          await navigator.clipboard.writeText(value);
        }
        await updateItem(item, { copyCount: (item.copyCount || 0) + 1, lastCopiedAt: new Date().toISOString() }, false);
        showToast(item.type === "image" ? copiedImage ? "图片已复制到剪贴板" : "图片地址已复制" : "已复制到剪贴板");
      } catch { showToast("复制失败，请检查剪贴板权限"); }
      break;
    case "more":
      $("#collectionList").querySelectorAll(".more-wrap").forEach(menu => { if (menu !== button.parentElement) menu.classList.remove("open"); });
      button.parentElement.classList.toggle("open");
      break;
    case "edit":
      button.closest(".more-wrap").classList.remove("open");
      openDialog(item, item);
      break;
    case "delete":
      button.closest(".more-wrap").classList.remove("open");
      if (confirm("删除这条收藏？此操作无法撤销。")) {
        await message("remove-item", { id: item.id });
        items = items.filter(entry => entry.id !== item.id);
        renderLibrary();
        showToast("已删除收藏");
      }
      break;
    case "open-source":
      button.closest(".more-wrap").classList.remove("open");
      if (safeUrl(item.sourceUrl)) chrome.tabs.create({ url: item.sourceUrl });
      break;
    case "copy-source":
      button.closest(".more-wrap").classList.remove("open");
      if (safeUrl(item.sourceUrl)) {
        await navigator.clipboard.writeText(item.sourceUrl);
        showToast("已复制来源链接");
      } else showToast("这条收藏没有来源链接");
      break;
    case "copy-image-url":
      button.closest(".more-wrap").classList.remove("open");
      if (safeUrl(item.originalUrl)) {
        await navigator.clipboard.writeText(item.originalUrl);
        showToast("已复制图片地址");
      } else showToast("这条收藏没有图片地址");
      break;
    case "move": {
      button.closest(".more-wrap").classList.remove("open");
      const choices = categories.map((entry, index) => `${index + 1}. ${entry.name}`).join("\n");
      const answer = prompt(`移动到哪个分类？输入分类名称或序号：\n\n${choices}`, categories.find(entry => entry.id === item.categoryId)?.name || "收件箱");
      if (!answer) return;
      const target = categories.find((entry, index) => entry.name.toLocaleLowerCase() === answer.trim().toLocaleLowerCase() || String(index + 1) === answer.trim());
      if (!target) return showToast("没有找到这个分类");
      await updateItem(item, { categoryId: target.id });
      showToast(`已移动到「${target.name}」`);
      break;
    }
  }
}

async function updateItem(item, patch, rerender = true) {
  const { id, imageBlob, ...rest } = { ...item, ...patch };
  await message("save-item", { item: { id, ...rest } });
  if (rerender) await reloadItems();
  else Object.assign(item, patch);
}

function openDialog(draft = {}, existing = null) {
  selectedItem = existing;
  if (!existing) currentPendingDraft = Object.keys(draft).length ? draft : null;
  const current = existing || draft;
  const isImage = current.type === "image";
  $("#dialogEyebrow").textContent = isImage ? "SAVE IMAGE TO YOUR LIBRARY" : "SAVE TO YOUR LIBRARY";
  $("#dialogTitle").textContent = existing ? "编辑这份收藏" : "整理这份灵感";
  $("#contentLabel").textContent = isImage ? "图片标题 / 说明" : "收藏内容";
  $("#contentField").placeholder = isImage ? "给这张图片写个标题…" : "写下值得记住的内容…";
  $("#contentField").value = current.content || "";
  $("#noteField").value = current.note || "";
  $("#tagsField").value = (current.tags || []).join(", ");
  renderCategoryOptions();
  $("#dialogCategory").value = categories.some(category => category.id === current.categoryId) ? current.categoryId : settings.defaultCategory;
  $("#sourceTitle").textContent = current.sourceTitle || current.sourceDomain || "当前网页";
  $("#sourceDomain").textContent = current.sourceDomain || domainFromUrl(current.sourceUrl) || "本机内容";
  $("#sourceLink").href = safeUrl(current.sourceUrl) || "#";
  $("#sourceLink").style.visibility = safeUrl(current.sourceUrl) ? "visible" : "hidden";
  const previewUrl = current.imageBlob ? objectUrl(current.imageBlob) : safeUrl(current.originalUrl);
  $("#imagePreviewWrap").hidden = !isImage || !previewUrl;
  if (isImage && previewUrl) $("#imagePreview").src = previewUrl;
  $("#saveDialogButton").innerHTML = existing ? "保存修改 <span>→</span>" : "保存到素材库 <span>→</span>";
  $("#dialogBackdrop").hidden = false;
  setTimeout(() => $("#contentField").focus(), 30);
}

function closeDialog() {
  $("#dialogBackdrop").hidden = true;
  selectedItem = null;
  currentPendingDraft = null;
  $("#imagePreview").removeAttribute("src");
}

async function saveDialog() {
  const content = $("#contentField").value.trim();
  const base = selectedItem || currentPendingDraft || {};
  if ((base.type || "text") === "text" && !content) {
    $("#contentField").focus();
    showToast("先写下要收藏的内容");
    return;
  }
  const item = {
    ...(selectedItem ? { id: selectedItem.id } : {}),
    type: base.type || "text",
    content,
    originalUrl: base.originalUrl || "",
    sourceTitle: base.sourceTitle || "",
    sourceUrl: base.sourceUrl || "",
    sourceDomain: base.sourceDomain || domainFromUrl(base.sourceUrl),
    categoryId: $("#dialogCategory").value || "inbox",
    tags: $("#tagsField").value.split(/[，,]/).map(tag => tag.trim()).filter(Boolean),
    note: $("#noteField").value.trim(),
    ...(selectedItem ? { favorite: selectedItem.favorite, copyCount: selectedItem.copyCount, createdAt: selectedItem.createdAt } : {})
  };
  try {
    await message("save-item", { item });
    closeDialog();
    currentPendingDraft = null;
    await reloadItems();
    showToast("已保存到素材库");
  } catch (error) { showToast(error.message); }
}

let currentPendingDraft = null;

function onDialogCategoryChange(event) {
  if (event.target.value !== "__new") return;
  event.target.value = settings.defaultCategory;
  addCategory().then(id => { if (id) $("#dialogCategory").value = id; });
}

async function consumePendingDraft(draft) {
  if (!draft) {
    const pending = await chrome.storage.session.get("pendingDraft");
    draft = pending.pendingDraft;
  }
  if (!draft) return;
  await chrome.storage.session.remove("pendingDraft");
  currentPendingDraft = draft;
  openDialog(draft);
}

function showLibrary() {
  $("#libraryView").hidden = false;
  $("#settingsView").hidden = true;
}

function showSettings() {
  $("#libraryView").hidden = true;
  $("#settingsView").hidden = false;
  renderSettings();
}

function renderSettings() {
  renderCategoryOptions();
  setSwitch("enhancedToggle", settings.enhancedMode);
  setSwitch("imageHoverToggle", settings.imageHover);
  setSwitch("toastToggle", settings.showToasts);
  $("#themeSelect").value = settings.theme || "system";
  $("#permissionNote").textContent = settings.enhancedMode
    ? "已允许 ChromeMark 在网页上显示收藏按钮。你可以随时关闭并撤销权限。"
    : "启用后会请求你访问网页内容的权限。收藏数据仍只保存在本机。";
}

function setSwitch(id, enabled) { $("#" + id).setAttribute("aria-checked", String(Boolean(enabled))); }

function applyTheme() {
  const dark = settings.theme === "dark" || (settings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.dataset.theme = dark ? "dark" : "light";
}

async function updateSetting(key, value) {
  settings = { ...settings, [key]: value };
  await message("update-settings", { settings });
  renderSettings();
  applyTheme();
  await broadcastCollectorSettings();
  showToast("设置已更新");
}

async function toggleEnhancedMode() {
  if (settings.enhancedMode) {
    settings = { ...settings, enhancedMode: false };
    await chrome.scripting.unregisterContentScripts({ ids: ["chromemark-collectors"] }).catch(() => {});
    await chrome.permissions.remove({ origins: ["http://*/*", "https://*/*"] }).catch(() => {});
    await message("update-settings", { settings });
    await broadcastCollectorSettings();
    renderSettings();
    showToast("已关闭网页浮动按钮");
    return;
  }
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] }); }
  catch { granted = false; }
  if (!granted) {
    showToast("需要网页访问权限才能显示浮动收藏按钮");
    return;
  }
  settings = { ...settings, enhancedMode: true };
  await message("update-settings", { settings });
  try {
    await chrome.scripting.registerContentScripts([{ id: "chromemark-collectors", matches: ["http://*/*", "https://*/*"], js: ["content.js"], runAt: "document_idle", persistAcrossSessions: true }]);
  } catch (error) {
    if (!String(error.message).includes("Duplicate")) showToast("网页按钮注册失败：" + error.message);
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) {
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }); } catch { /* Restricted browser pages cannot be injected. */ }
  }
  renderSettings();
  showToast("网页浮动收藏已开启");
}

async function broadcastCollectorSettings() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "collector-settings", settings }).catch(() => {});
}

async function addCategory() {
  const name = prompt("新分类名称");
  if (!name?.trim()) return null;
  if (categories.some(category => category.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) {
    showToast("这个分类已经存在");
    return null;
  }
  const category = { id: crypto.randomUUID(), name: name.trim(), icon: "◦" };
  categories = [...categories, category];
  await message("update-categories", { categories });
  renderCategoryOptions();
  renderLibrary();
  showToast(`已创建「${category.name}」`);
  return category.id;
}

async function onCategoryAction(event) {
  const button = event.target.closest("button[data-action]");
  const chip = event.target.closest("[data-category-id]");
  if (!button || !chip) return;
  const category = categories.find(entry => entry.id === chip.dataset.categoryId);
  if (!category) return;
  if (button.dataset.action === "up" || button.dataset.action === "down") {
    const index = categories.findIndex(entry => entry.id === category.id);
    const swapIndex = index + (button.dataset.action === "up" ? -1 : 1);
    if (index < 1 || swapIndex < 1 || swapIndex >= categories.length) return;
    const reordered = [...categories];
    [reordered[index], reordered[swapIndex]] = [reordered[swapIndex], reordered[index]];
    categories = reordered;
    await message("update-categories", { categories });
    renderCategoryOptions();
    return;
  }
  if (button.dataset.action === "rename") {
    const name = prompt("修改分类名称", category.name)?.trim();
    if (!name || name === category.name) return;
    if (categories.some(entry => entry.id !== category.id && entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return showToast("这个分类已经存在");
    categories = categories.map(entry => entry.id === category.id ? { ...entry, name } : entry);
    await message("update-categories", { categories });
    renderCategoryOptions(); renderLibrary(); showToast("分类名称已更新");
  } else if (button.dataset.action === "delete") {
    if (!confirm(`删除「${category.name}」？其中的收藏会移到收件箱。`)) return;
    for (const item of items.filter(entry => entry.categoryId === category.id)) await updateItem(item, { categoryId: "inbox" }, false);
    categories = categories.filter(entry => entry.id !== category.id);
    if (settings.defaultCategory === category.id) await updateSetting("defaultCategory", "inbox");
    await message("update-categories", { categories });
    await reloadItems(); renderSettings(); showToast("分类已删除，收藏已移至收件箱");
  }
}

async function exportData() {
  try {
    const local = await chrome.storage.local.get(["categories", "settings"]);
    const exportItems = items.map(({ imageBlob, ...item }) => item);
    const payload = { version: 1, exportedAt: new Date().toISOString(), categories: local.categories || categories, settings: local.settings || settings, items: exportItems };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `chromemark-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("JSON 备份已导出");
  } catch (error) { showToast(error.message); }
}

async function importFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    let mode = "merge";
    if (!confirm("将备份合并到现有收藏吗？\n\n确定 = 合并（推荐）\n取消 = 选择覆盖")) {
      if (!confirm("覆盖会删除本机现有收藏。确认继续？")) return;
      mode = "replace";
    }
    const result = await message("import-data", { data, mode });
    const local = await chrome.storage.local.get(["categories", "settings"]);
    categories = local.categories || [...DEFAULT_CATEGORIES];
    settings = { ...DEFAULT_SETTINGS, ...(local.settings || {}) };
    await reloadItems(); renderSettings(); applyTheme();
    showToast(`已导入 ${result.count} 条收藏`);
  } catch (error) { showToast(error.message === "Unexpected end of JSON input" ? "备份文件内容不完整" : error.message); }
}

async function clearData() {
  if (!confirm("清空本机全部收藏、分类和设置？此操作无法撤销。")) return;
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["chromemark-collectors"] }).catch(() => {});
    await chrome.permissions.remove({ origins: ["http://*/*", "https://*/*"] }).catch(() => {});
    await message("clear-data");
    categories = [...DEFAULT_CATEGORIES]; settings = { ...DEFAULT_SETTINGS };
    await broadcastCollectorSettings();
    await reloadItems(); renderSettings(); applyTheme(); showLibrary();
    showToast("本机数据已清空");
  } catch (error) { showToast(error.message); }
}

function showToast(text) {
  if (settings.showToasts === false && text !== "需要网页访问权限才能显示浮动收藏按钮") return;
  const toast = $("#toast");
  toast.textContent = text;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2100);
}

function safeUrl(value = "") {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
}
function domainFromUrl(value = "") {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function dateValue(value) { const date = new Date(value).getTime(); return Number.isFinite(date) ? date : 0; }
function formatDate(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date) : "未知时间"; }
function escapeHtml(value = "") { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

async function copyImageToClipboard(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error("图片格式暂不支持复制")), "image/png"));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

initialize();
