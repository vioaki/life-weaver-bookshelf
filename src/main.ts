import "./styles.css";
import { callModel, systemPrompt } from "./llm";
import {
  deleteBook,
  getActiveBookId,
  getBook,
  listBooks,
  loadConfig,
  makeCoverStyle,
  makeSummaryLine,
  migrateLegacySave,
  saveBook,
  saveConfig,
  setActiveBookId,
} from "./storage";
import type { AppConfig, BookPage, BookRecord, ChatMessage, LifeState, View } from "./types";

type Modal = null | "settings" | "stats" | "relationships" | "finale";

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) throw new Error("Missing #app root");
const app = appRoot;

let cfg: AppConfig = loadConfig();
let books: BookRecord[] = [];
let activeBook: BookRecord | null = null;
let view: View = "home";
let modal: Modal = null;
let busy = false;
let currentPageIndex = 0;
let dockExpanded = false;

app.addEventListener("click", (event) => void handleClick(event));
app.addEventListener("submit", (event) => void handleSubmit(event));
app.addEventListener("keydown", (event) => void handleKeyDown(event));

void boot();

async function boot(): Promise<void> {
  await migrateLegacySave();
  await refreshBooks();
  const activeId = getActiveBookId();
  activeBook = activeId ? await getBook(activeId) || null : null;
  if (activeBook?.pages.length === 0 && activeBook.history.length > 0) {
    activeBook.pages = rebuildPagesFromHistory(activeBook.history);
    await saveBook(activeBook);
  }
  renderApp();
}

async function refreshBooks(): Promise<void> {
  books = await listBooks();
}

function renderApp(): void {
  app.innerHTML = `
    <div id="backdrop"></div>
    ${view === "home" ? renderHome() : ""}
    ${view === "shelf" ? renderShelf() : ""}
    ${view === "reader" ? renderReader() : ""}
    ${renderModal()}
  `;
}

function renderHome(): string {
  const latest = books.find((book) => book.status === "ongoing") || books[0];
  const ongoing = books.filter((book) => book.status === "ongoing").length;
  const finished = books.filter((book) => book.status === "finished").length;
  return `
    <main class="home">
      <header class="homebar">
        <div class="brand-seal">卷</div>
        <div>
          <div class="brand-title">人生之书</div>
          <div class="brand-sub">命册书斋</div>
        </div>
        <button class="iconbtn" data-action="open-settings" title="设置">☰</button>
      </header>
      <section class="desk">
        <div class="shelf-shadow" aria-hidden="true">
          ${books.slice(0, 10).map((book) => `<i style="--paper:${book.coverStyle.paper};--seal:${book.coverStyle.seal}"></i>`).join("")}
        </div>
        <div class="desk-book" aria-hidden="true">
          <span class="book-ribbon"></span>
          <span class="book-title-mark">人生之书</span>
          <span class="book-seal">命</span>
        </div>
        <div class="home-actions">
          <button class="seal-btn primary" data-action="start-new">起新卷</button>
          <button class="seal-btn" data-action="continue-latest" ${latest ? "" : "disabled"}>续前卷</button>
          <button class="seal-btn" data-action="open-shelf">入书柜</button>
        </div>
        <div class="ledger-strip">
          <span>藏书 ${books.length}</span>
          <span>未竟 ${ongoing}</span>
          <span>终章 ${finished}</span>
        </div>
      </section>
    </main>
  `;
}

function renderShelf(): string {
  return `
    <main class="shelf-page">
      <header class="viewbar">
        <button class="ghost-link" data-action="back-home">← 书案</button>
        <div>
          <div class="view-title">书柜</div>
          <div class="view-sub">${books.length ? `共 ${books.length} 卷` : "尚无藏书"}</div>
        </div>
        <div class="shelf-actions">
          <button class="seal-mini" data-action="start-new">起新卷</button>
          <button class="iconbtn" data-action="open-settings" title="设置">☰</button>
        </div>
      </header>
      <section class="bookcase ${books.length ? "" : "empty-case"}">
        ${books.length ? books.map(renderBookCard).join("") : `<div class="empty-bookcase">书柜尚空</div>`}
      </section>
    </main>
  `;
}

function renderBookCard(book: BookRecord): string {
  const age = book.state.age != null ? `${book.state.age}岁` : "年岁未详";
  const statusText = book.status === "finished" ? "终" : "续";
  return `
    <article class="book-card" style="--paper:${book.coverStyle.paper};--seal:${book.coverStyle.seal}">
      <div class="book-spine">
        <span>${esc(statusText)}</span>
      </div>
      <div class="book-card-body">
        <div class="book-card-head">
          <span class="avatar-mark">${esc(book.avatar || "卷")}</span>
          <span class="status ${book.status}">${book.status === "finished" ? "终章" : "未竟"}</span>
        </div>
        <h2>${esc(book.title)}</h2>
        <p>${esc(book.summaryLine || `${book.world} · ${age}`)}</p>
        <div class="book-meta">
          <span>${esc(book.protagonist || "无名者")}</span>
          <span>${formatDate(book.updatedAt)}</span>
        </div>
        <div class="book-actions">
          ${book.status === "ongoing" ? `<button data-action="continue-book" data-id="${book.id}">续写</button>` : ""}
          <button data-action="read-book" data-id="${book.id}">翻阅</button>
          ${book.status === "finished" ? `<button data-action="open-finale-book" data-id="${book.id}">终章</button>` : ""}
          <button class="danger" data-action="delete-book" data-id="${book.id}">焚毁</button>
        </div>
      </div>
    </article>
  `;
}

function renderReader(): string {
  const book = activeBook;
  if (!book) return renderHome();
  const state = book.state;
  const pages = book.pages;
  const hasPages = pages.length > 0;
  const atStart = currentPageIndex <= 0;
  const atEnd = !hasPages || currentPageIndex >= pages.length - 1;
  return `
    <main class="reader">
      <header id="topbar">
        <button class="iconbtn" data-action="back-home" title="书案">⌂</button>
        <div id="avatar">${esc(book.avatar || state.avatar || "卷")}</div>
        <div id="whoami">
          <div id="name">${esc(book.title || "未名之卷")}</div>
          <div id="sub">${esc([state.oneline, state.world].filter(Boolean).join(" · ") || book.summaryLine || "命运尚未启封")}</div>
        </div>
        <div class="agebadge"><b>${state.age ?? "—"}</b><span>春秋</span></div>
        <button class="iconbtn" data-action="open-stats" title="命格">☯</button>
        <button class="iconbtn" data-action="open-relationships" title="人物">缘</button>
        <button class="iconbtn" data-action="open-settings" title="设置">☰</button>
      </header>

      <button class="nav-wing left ${atStart ? "disabled" : ""}" data-action="prev-page" title="上一卷">⟨</button>
      <button class="nav-wing right ${atEnd ? "disabled" : ""}" data-action="next-page" title="下一卷">⟩</button>

      <div id="main-book-frame">
        <div id="book-viewport">
          <div id="book-slider" style="transform:translateX(-${currentPageIndex * 100}%)">
            ${hasPages ? pages.map(renderPage).join("") : renderWelcomePage()}
          </div>
        </div>
      </div>

      ${renderDock(book)}
    </main>
  `;
}

function renderWelcomePage(): string {
  return `
    <article class="book-page active">
      <div class="era"><span class="deco">❖ 序 章 ❖</span><span class="ttl">人生之书</span></div>
      <div class="story"><span class="dropcap">命</span>运尚未落笔。启封新卷后，此处会逐页留下你的一生。</div>
      <div class="page-num">— 序 —</div>
    </article>
  `;
}

function renderPage(page: BookPage, index: number): string {
  const active = index === currentPageIndex ? "active" : "";
  const chapter = toChineseNumeral(index + 1);
  return `
    <article class="book-page ${active}">
      <div class="era"><span class="deco">❖ 第 ${chapter} 卷 ❖</span><span class="ttl">${esc(page.era_label || "启笔")}</span></div>
      <div class="story">${storyHTML(page.narrative)}</div>
      ${page.event ? `<div class="event"><b>变故 · </b>${esc(page.event)}</div>` : ""}
      ${page.deltas?.length ? `<div class="deltas">${page.deltas.map((d) => `<span class="delta ${(d.d || 0) >= 0 ? "up" : "down"}">${esc(d.k)} ${(d.d || 0) >= 0 ? "+" : ""}${d.d}</span>`).join("")}</div>` : ""}
      ${page.choiceMade ? `<div class="mychoice"><span class="label">朱批</span><span class="txt">${esc(page.choiceMade)}</span></div>` : ""}
      <div class="page-num">— 卷 ${chapter} —</div>
    </article>
  `;
}

function renderDock(book: BookRecord): string {
  const state = book.state;
  const dead = book.status === "finished" || !!state.dead;
  return `
    <section id="dock" class="${dockExpanded ? "expanded" : ""}">
      <button id="dock-handle" data-action="dock-toggle">
        <span class="title-text">${dead ? "❧ 终章笺" : "📜 执笔抉择"}</span>
        <span class="handle-hint">${dockExpanded ? "收起" : "启封"}</span>
        <span class="arrow-icon">▲</span>
      </button>
      <div id="dock-content">
        ${busy ? `<div class="dock-hint">墨迹未干</div>` : dead ? renderFinaleDock() : renderChoiceDock(state)}
      </div>
    </section>
  `;
}

function renderFinaleDock(): string {
  return `<div class="dock-hint">此生已成卷 <button id="openDeath" data-action="open-finale">展开终章笺</button></div>`;
}

function renderChoiceDock(state: LifeState): string {
  const choices = state.choices || [];
  return `
    <div class="dock-hint">命运的岔路 <button id="newchoices" data-action="reroll">换一批选项</button></div>
    <div class="choices">
      ${choices.map((choice, index) => `<button class="choice" data-action="choice" data-choice="${attr(choice)}"><span class="num">${index + 1}</span><span>${esc(choice)}</span></button>`).join("")}
    </div>
    <div class="freerow">
      <input id="freein" placeholder="或，亲笔写下你的去向…" autocomplete="off" ${busy ? "disabled" : ""}/>
      <button id="sendbtn" data-action="send-free" ${busy ? "disabled" : ""}>书</button>
    </div>
  `;
}

function renderModal(): string {
  if (!modal) return "";
  if (modal === "settings") return renderSettingsModal();
  if (modal === "stats") return renderStatsModal();
  if (modal === "relationships") return renderRelationshipsModal();
  return renderFinaleModal();
}

function renderSettingsModal(): string {
  return `
    <div class="modal on" data-action="close-modal">
      <form class="sheet" id="settingsForm">
        <h2>笔墨与接口</h2>
        <label>接口地址<input name="url" value="${attr(cfg.url)}" placeholder="https://api.openai.com/v1" /></label>
        <label>API Key<input name="key" type="password" value="${attr(cfg.key)}" placeholder="仅保存在本地" /></label>
        <label>模型名称<input name="model" value="${attr(cfg.model)}" placeholder="gpt-4.1-mini" /></label>
        <label>笔锋
          <select name="style">
            ${["温情细腻", "跌宕传奇", "黑暗残酷", "幽默荒诞"].map((style) => `<option ${style === cfg.style ? "selected" : ""}>${style}</option>`).join("")}
          </select>
        </label>
        <label>命运批注<textarea name="custom" rows="4" placeholder="追加设定、世界观或文风要求">${esc(cfg.custom)}</textarea></label>
        <button class="btn primary" type="submit">封存笔墨</button>
        <button class="btn ghost" type="button" data-action="close-modal">合上</button>
      </form>
    </div>
  `;
}

function renderStatsModal(): string {
  const state = activeBook?.state;
  const stats = state?.stats || {};
  const keys = ["健康", "智力", "体力", "魅力", "财富", ...Object.keys(stats).filter((k) => !["健康", "智力", "体力", "魅力", "财富"].includes(k))];
  return `
    <div class="modal on" data-action="close-modal">
      <div class="sheet">
        <h2>☯ 叩问命格</h2>
        ${keys.length ? keys.map((key) => renderStatLine(key, Number(stats[key]) || 0)).join("") : `<div class="empty">命格尚未显影</div>`}
        ${state?.extra ? `<div class="extras">${Object.entries(state.extra).map(([k, v]) => `<span class="chip">${esc(k)} <b>${esc(v)}</b></span>`).join("")}</div>` : ""}
        <h2>编年纪事</h2>
        ${state?.timeline?.length ? `<div class="tl">${state.timeline.map((item) => `<div class="tlitem"><div class="a">${item.age ?? ""}岁</div><div class="t">${esc(item.t)}</div></div>`).join("")}</div>` : `<div class="empty">命运尚未展开</div>`}
        <button class="btn ghost" type="button" data-action="close-modal">合上</button>
      </div>
    </div>
  `;
}

function renderRelationshipsModal(): string {
  const rels = activeBook?.state.relationships || [];
  return `
    <div class="modal on" data-action="close-modal">
      <div class="sheet">
        <h2>缘 · 书中人</h2>
        ${rels.length ? rels.map((rel) => `<div class="rel"><div class="face">${esc(rel.emoji || "人")}</div><div class="info"><div class="n">${esc(rel.name)}</div><div class="r">${esc(rel.relation || "")}${rel.note ? " · " + esc(rel.note) : ""}</div></div><div class="bond ${rel.bond || "neutral"}">${bondLabel(rel.bond)}</div></div>`).join("") : `<div class="empty">尚未遇见任何人</div>`}
        <button class="btn ghost" type="button" data-action="close-modal">合上</button>
      </div>
    </div>
  `;
}

function renderFinaleModal(): string {
  const book = activeBook;
  const finale = book?.finale || book?.state.death || {};
  return `
    <div id="death" class="on">
      <div class="skull">❧</div>
      <h1>此 生 终 章</h1>
      <div class="endmark">—— 全 书 完 ——</div>
      <div class="title">${esc(finale.title || book?.title || "无名的一生")}</div>
      <div class="ages">享年 ${book?.state.age ?? "?"} 岁 · 死因：${esc(finale.cause || "未知")}</div>
      <div class="sum">${esc(finale.summary || "")}${finale.analysis ? "\n\n【性格剖析】" + esc(finale.analysis) : ""}</div>
      <div class="finals">${renderFinalStats(book?.state)}</div>
      <button class="btn ghost" data-action="close-modal">合上终章</button>
      <button class="btn primary" data-action="reincarnate">✦ 转世 · 另起一卷</button>
    </div>
  `;
}

async function handleClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement;
  const actionEl = target.closest<HTMLElement>("[data-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.action || "";
  if (action === "close-modal" && target === actionEl) modal = null;
  if (action !== "close-modal") event.preventDefault();

  if (action === "back-home") {
    view = "home";
    modal = null;
    renderApp();
  } else if (action === "open-shelf") {
    view = "shelf";
    modal = null;
    await refreshBooks();
    renderApp();
  } else if (action === "open-settings") {
    modal = "settings";
    renderApp();
  } else if (action === "open-stats") {
    modal = "stats";
    renderApp();
  } else if (action === "open-relationships") {
    modal = "relationships";
    renderApp();
  } else if (action === "open-finale") {
    modal = "finale";
    dockExpanded = false;
    renderApp();
  } else if (action === "close-modal") {
    modal = null;
    renderApp();
  } else if (action === "start-new" || action === "reincarnate") {
    await startNewBook();
  } else if (action === "continue-latest") {
    const latest = books.find((book) => book.status === "ongoing") || books[0];
    if (latest) await openBook(latest.id);
  } else if (action === "continue-book" || action === "read-book") {
    await openBook(actionEl.dataset.id || "");
  } else if (action === "open-finale-book") {
    await openBook(actionEl.dataset.id || "", "finale");
  } else if (action === "delete-book") {
    await burnBook(actionEl.dataset.id || "");
  } else if (action === "prev-page") {
    flipTo(currentPageIndex - 1);
  } else if (action === "next-page") {
    flipTo(currentPageIndex + 1);
  } else if (action === "dock-toggle") {
    dockExpanded = !dockExpanded;
    renderApp();
  } else if (action === "choice") {
    await sendAction(actionEl.dataset.choice || "");
  } else if (action === "reroll") {
    await sendAction("__REROLL__");
  } else if (action === "send-free") {
    await sendFreeInput();
  }
}

async function handleSubmit(event: SubmitEvent): Promise<void> {
  const form = event.target as HTMLFormElement;
  if (form.id !== "settingsForm") return;
  event.preventDefault();
  const data = new FormData(form);
  cfg = {
    url: String(data.get("url") || "").trim().replace(/\/+$/, "") || "https://api.openai.com/v1",
    key: String(data.get("key") || "").trim(),
    model: String(data.get("model") || "").trim() || "gpt-4.1-mini",
    style: String(data.get("style") || "跌宕传奇"),
    custom: String(data.get("custom") || "").trim(),
    temperature: 1,
  };
  saveConfig(cfg);
  modal = null;
  renderApp();
}

async function handleKeyDown(event: KeyboardEvent): Promise<void> {
  if (event.key !== "Enter") return;
  const target = event.target as HTMLElement;
  if (target.id === "freein") {
    event.preventDefault();
    await sendFreeInput();
  }
}

async function startNewBook(): Promise<void> {
  if (!cfg.key.trim()) {
    modal = "settings";
    renderApp();
    return;
  }
  const now = Date.now();
  const book: BookRecord = {
    id: crypto.randomUUID(),
    title: "未名新卷",
    createdAt: now,
    updatedAt: now,
    status: "ongoing",
    protagonist: "无名者",
    world: "未名世界",
    avatar: "卷",
    coverStyle: makeCoverStyle("未名世界", "卷"),
    pages: [],
    history: [],
    state: { timeline: [] },
    finale: null,
    summaryLine: "命运尚未启封",
  };
  activeBook = book;
  setActiveBookId(book.id);
  await saveBook(book);
  await refreshBooks();
  view = "reader";
  modal = null;
  currentPageIndex = 0;
  dockExpanded = false;
  renderApp();
  await runTurn("游戏开始。请随机生成时代背景、我的性别(男女各50%)、外貌、姓名、出身家庭与健康等设定，并从0~10岁阶段开始对我提出第一个抉择。记得输出STATE。");
}

async function openBook(id: string, openModal?: Modal): Promise<void> {
  const book = await getBook(id);
  if (!book) return;
  if (book.pages.length === 0 && book.history.length > 0) {
    book.pages = rebuildPagesFromHistory(book.history);
    await saveBook(book);
  }
  activeBook = book;
  setActiveBookId(book.id);
  view = "reader";
  modal = openModal || null;
  currentPageIndex = Math.max(0, book.pages.length - 1);
  dockExpanded = false;
  renderApp();
}

async function burnBook(id: string): Promise<void> {
  const book = books.find((item) => item.id === id);
  if (!book) return;
  if (!confirm(`焚毁${book.title}？此操作不可撤回。`)) return;
  await deleteBook(id);
  if (activeBook?.id === id) activeBook = null;
  await refreshBooks();
  view = "shelf";
  renderApp();
}

async function sendFreeInput(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#freein");
  const value = input?.value.trim() || "";
  if (!value) return;
  if (input) input.value = "";
  await sendAction(value);
}

async function sendAction(text: string): Promise<void> {
  const book = activeBook;
  if (!book || busy || book.status === "finished") return;
  let message = text;
  if (text === "__REROLL__") {
    message = "我觉得这些选项都不够好，请基于我当前的处境，重新给我5个差异更大、更有意思的选项（保持同一时间点，不要推进剧情）。";
  } else if (book.pages.length > 0) {
    book.pages[book.pages.length - 1].choiceMade = text;
    await saveBook(book);
  }
  await runTurn(text === "__REROLL__" ? message : `我的选择：${message}`);
}

async function runTurn(userMsg: string): Promise<void> {
  const book = activeBook;
  if (!book || busy) return;
  busy = true;
  dockExpanded = false;
  book.history.push({ role: "user", content: userMsg });
  const pageIndex = book.pages.length;
  book.pages.push({ era_label: "起笔中…", narrative: "", event: "", deltas: [], choiceMade: "", choices: [], dead: false, death: null });
  currentPageIndex = pageIndex;
  renderApp();

  let fullText = "";
  try {
    fullText = await callModel(cfg, [{ role: "system", content: systemPrompt(cfg) }, ...book.history], (acc) => {
      const parsed = splitStateAndNarrative(acc);
      const activePage = book.pages[pageIndex];
      activePage.narrative = parsed.narrative || "";
      if (parsed.state?.era_label) activePage.era_label = parsed.state.era_label;
      updateActiveStory(activePage);
    });
  } catch (error) {
    book.pages[pageIndex].narrative = `✕ ${(error as Error).message}`;
    busy = false;
    await saveBook(book);
    renderApp();
    return;
  }

  book.history.push({ role: "assistant", content: fullText });
  const { narrative, state } = splitStateAndNarrative(fullText);
  book.pages[pageIndex] = {
    era_label: state?.era_label || "启笔",
    narrative: narrative || fullText,
    event: state?.event || "",
    deltas: state?.deltas || [],
    choiceMade: "",
    choices: state?.choices || [],
    dead: !!state?.dead,
    death: state?.death || null,
  };
  applyState(book, state);
  book.updatedAt = Date.now();
  await saveBook(book);
  await refreshBooks();
  busy = false;
  renderApp();
}

function applyState(book: BookRecord, state: LifeState | null): void {
  if (!state) return;
  const next: LifeState = { ...book.state };
  for (const key of ["name", "gender", "avatar", "world", "oneline", "era_label"] as const) {
    if (state[key] != null) (next as any)[key] = state[key];
  }
  if (state.age != null) next.age = state.age;
  if (state.stats) next.stats = state.stats;
  if (state.extra) next.extra = state.extra;
  if (Array.isArray(state.relationships)) next.relationships = state.relationships;
  next.deltas = Array.isArray(state.deltas) ? state.deltas : [];
  next.event = state.event || "";
  next.choices = Array.isArray(state.choices) ? state.choices : [];
  next.dead = !!state.dead;
  next.death = state.death || null;
  if (state.timeline_add) {
    next.timeline = [...(next.timeline || []), { age: next.age, t: state.timeline_add }];
  }
  book.state = next;
  book.protagonist = next.name || book.protagonist || "无名者";
  book.world = next.world || book.world || "未名世界";
  book.avatar = next.avatar || book.avatar || "卷";
  book.title = next.name ? `《${next.name}传》` : book.title;
  book.coverStyle = makeCoverStyle(book.world, book.avatar);
  book.status = next.dead ? "finished" : "ongoing";
  book.finale = next.death || null;
  book.summaryLine = makeSummaryLine(next);
}

function updateActiveStory(page: BookPage): void {
  const story = document.querySelector<HTMLElement>(".book-page.active .story");
  const title = document.querySelector<HTMLElement>(".book-page.active .era .ttl");
  if (story) story.innerHTML = storyHTML(page.narrative);
  if (title) title.textContent = page.era_label;
}

function flipTo(index: number): void {
  const total = activeBook?.pages.length || 0;
  if (index < 0 || index >= total) return;
  currentPageIndex = index;
  renderApp();
}

function rebuildPagesFromHistory(history: ChatMessage[]): BookPage[] {
  const pages: BookPage[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role !== "assistant") continue;
    const { narrative, state } = splitStateAndNarrative(msg.content);
    let choiceMade = "";
    const next = history[i + 1];
    if (next?.role === "user") choiceMade = next.content.replace(/^我的选择：/, "");
    pages.push({
      era_label: state?.era_label || "旧卷",
      narrative: narrative || msg.content,
      event: state?.event || "",
      deltas: state?.deltas || [],
      choiceMade,
      choices: state?.choices || [],
      dead: !!state?.dead,
      death: state?.death || null,
    });
  }
  return pages;
}

function splitStateAndNarrative(text: string): { narrative: string; state: LifeState | null } {
  const match = text.match(/<STATE>([\s\S]*?)<\/STATE>/i);
  let narrative = text;
  let state: LifeState | null = null;
  if (match) {
    narrative = text.slice(0, match.index).trim();
    const raw = match[1].trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    state = tryParseState(raw);
  } else {
    const open = text.indexOf("<STATE");
    if (open >= 0) narrative = text.slice(0, open).trim();
  }
  return { narrative, state };
}

function tryParseState(raw: string): LifeState | null {
  try {
    return JSON.parse(raw) as LifeState;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as LifeState;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function storyHTML(narrative: string): string {
  const text = String(narrative || "");
  if (!text) return "";
  const [first] = Array.from(text);
  const rest = text.slice(first.length);
  return `<span class="dropcap">${esc(first)}</span>${esc(rest)}`;
}

function renderStatLine(key: string, value: number): string {
  const v = Math.max(0, Math.min(100, value));
  const cls = key === "健康" ? "hp" : key === "财富" ? "gold" : "";
  return `<div class="statline"><div class="top"><b>${esc(key)}</b><em>${v}</em></div><div class="bar ${cls}"><i style="width:${v}%"></i></div></div>`;
}

function renderFinalStats(state?: LifeState): string {
  const stats = Object.entries(state?.stats || {});
  const extra = Object.entries(state?.extra || {});
  return [...stats, ...extra].map(([k, v]) => `<span class="chip">${esc(k)} <b>${esc(v)}</b></span>`).join("");
}

function toChineseNumeral(num: number): string {
  const chars = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];
  if (num <= 10) return chars[num];
  if (num < 20) return `拾${num % 10 === 0 ? "" : chars[num % 10]}`;
  if (num < 100) return `${chars[Math.floor(num / 10)]}拾${num % 10 === 0 ? "" : chars[num % 10]}`;
  return String(num);
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(ts);
}

function bondLabel(bond?: string): string {
  return bond === "good" ? "亲密" : bond === "bad" ? "敌对" : bond === "dead" ? "已逝" : "平淡";
}

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch] || ch));
}

function attr(value: unknown): string {
  return esc(value).replace(/"/g, "&quot;");
}
