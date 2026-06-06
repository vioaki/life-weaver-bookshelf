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

type Modal = null | "settings" | "stats" | "relationships" | "finale" | "inspect";

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
let inspectingBookId: string | null = null;
let homeBookEngineCleanup: (() => void) | null = null;
let globalInkEngineCleanup: (() => void) | null = null;

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
  app.dataset.view = view;
  let homeSandbox = app.querySelector<HTMLElement>("#view-sandbox-home");
  let shelfSandbox = app.querySelector<HTMLElement>("#view-sandbox-shelf");
  let readerSandbox = app.querySelector<HTMLElement>("#view-sandbox-reader");

  if (!homeSandbox || !shelfSandbox || !readerSandbox) {
    app.innerHTML = `
      <svg class="material-shaders" aria-hidden="true" focusable="false">
        <defs>
          <filter id="epic-parchment-shader" x="0%" y="0%" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="3" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.8" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="epic-gold-foil" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence type="fractalNoise" baseFrequency="0.2" numOctaves="2" result="noise" />
            <feColorMatrix type="matrix" values="1 0 0 0 0  0 .7 0 0 0  0 .4 0 0 0  0 0 0 1 0" in="noise" result="coloredNoise" />
            <feComposite operator="in" in2="SourceGraphic" result="texturedGold" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="1" result="blur" />
            <feSpecularLighting in="blur" surfaceScale="3" specularExponent="22" lighting-color="#fff" result="light">
              <feDistantLight azimuth="45" elevation="60" />
            </feSpecularLighting>
            <feComposite operator="in" in2="SourceGraphic" result="specular" />
            <feMerge>
              <feMergeNode in="texturedGold" />
              <feMergeNode in="specular" />
            </feMerge>
          </filter>
          <filter id="epic-gold-foil-press" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.15" numOctaves="2" result="noise" />
            <feColorMatrix type="matrix" values="1 0 0 0 0  0 .75 0 0 0  0 .45 0 0 0  0 0 0 1 0" in="noise" result="gold" />
            <feComposite operator="in" in2="SourceGraphic" result="textured" />
            <feGaussianBlur in="SourceGraphic" stdDeviation=".5" result="blur" />
            <feSpecularLighting in="blur" surfaceScale="2" specularExponent="30" lighting-color="#fff" result="light">
              <feDistantLight azimuth="45" elevation="60" />
            </feSpecularLighting>
            <feComposite operator="in" in2="SourceGraphic" result="spec" />
            <feMerge>
              <feMergeNode in="textured" />
              <feMergeNode in="spec" />
            </feMerge>
          </filter>
        </defs>
      </svg>
      <canvas id="fullscreen-ink-smoke-canvas" class="ink-fluid-overlay"></canvas>
      <div id="backdrop"></div>
      <div id="view-sandbox-home" class="view-sandbox"></div>
      <div id="view-sandbox-shelf" class="view-sandbox"></div>
      <div id="view-sandbox-reader" class="view-sandbox"></div>
    `;
    homeSandbox = app.querySelector<HTMLElement>("#view-sandbox-home")!;
    shelfSandbox = app.querySelector<HTMLElement>("#view-sandbox-shelf")!;
    readerSandbox = app.querySelector<HTMLElement>("#view-sandbox-reader")!;
    globalInkEngineCleanup?.();
    globalInkEngineCleanup = initGlobalEtherealSmokeSolver();
  }

  if (view === "home") {
    stopHomeBookEngine();
    homeSandbox.innerHTML = renderHome();
    requestAnimationFrame(() => {
      homeBookEngineCleanup = initTopTierInteractiveBook();
    });
  } else {
    stopHomeBookEngine();
  }
  if (view === "shelf") shelfSandbox.innerHTML = renderShelf();
  if (view === "reader") {
    readerSandbox.innerHTML = renderReader();
  }

  homeSandbox.classList.toggle("active-view", view === "home");
  shelfSandbox.classList.toggle("active-view", view === "shelf");
  readerSandbox.classList.toggle("active-view", view === "reader");

  app.querySelector(".modal-layer-global")?.remove();
  if (modal) {
    const layer = document.createElement("div");
    layer.className = "modal-layer-global";
    layer.innerHTML = renderModal();
    app.appendChild(layer);
  }
}

function renderHome(): string {
  const latest = books.find((book) => book.status === "ongoing") || books[0];
  const ongoing = books.filter((book) => book.status === "ongoing").length;
  const finished = books.filter((book) => book.status === "finished").length;
  return `
    <main class="home">
      <button class="iconbtn home-settings" data-action="open-settings" title="设置">☰</button>
      <section class="home-left-panel">
        <header class="brand-section">
          <div class="brand-seal">卷</div>
          <h1 class="brand-title">人生之书</h1>
          <div class="brand-sub">一纸枯荣 · 执笔观浮生</div>
        </header>

        <div class="home-actions">
          <button class="seal-btn primary" data-action="start-new">起 新 卷</button>
          <button class="seal-btn" data-action="continue-latest" ${latest ? "" : "disabled"}>续 前 卷</button>
          <button class="seal-btn" data-action="open-shelf">入 书 柜</button>
        </div>

        <div class="ledger-strip">
          <span>藏书 <strong class="num-all">${books.length}</strong></span>
          <span>未竟 <strong class="num-ongoing">${ongoing}</strong></span>
          <span>终章 <strong class="num-finished">${finished}</strong></span>
        </div>
      </section>

      <section class="home-right-panel" id="interactive-desk-zone" aria-hidden="true">
        <div class="stage-3d" id="mesh-stage">
          <div class="mesh-shadow-floor"></div>
          <div class="book-mesh-cube">
            <div class="mesh-thickness-edge edge-spine"></div>
            <div class="mesh-thickness-edge edge-right"></div>
            <div class="mesh-thickness-edge edge-top"></div>
            <div class="mesh-thickness-edge edge-bottom"></div>
            <div class="mesh-face cover-back"></div>
            <div class="mesh-face cover-front">
              <div class="thread-binding">
                <i class="hole" style="top: 12%"></i>
                <i class="hole" style="top: 37%"></i>
                <i class="hole" style="top: 63%"></i>
                <i class="hole" style="top: 88%"></i>
                <i class="thread-spine" style="top: 12.5%"></i>
                <i class="thread-spine" style="top: 37.5%"></i>
                <i class="thread-spine" style="top: 63.5%"></i>
                <i class="thread-spine" style="top: 88.5%"></i>
                <i class="thread-vertical"></i>
              </div>
              <div class="book-inscription-strip">
                <h2 class="book-title-mesh">人生之书</h2>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  `;
}

function stopHomeBookEngine(): void {
  if (!homeBookEngineCleanup) return;
  homeBookEngineCleanup();
  homeBookEngineCleanup = null;
}

function initTopTierInteractiveBook(): (() => void) | null {
  const zone = document.querySelector<HTMLElement>("#interactive-desk-zone");
  const stage = document.querySelector<HTMLElement>("#mesh-stage");
  if (!zone || !stage) return null;

  const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let destroyed = false;
  let matrixFrame = 0;
  let currentX = 18;
  let currentY = -8;
  let targetX = 18;
  let targetY = -8;

  const onPointerMove = (event: PointerEvent): void => {
    if (reducedMotion) return;
    const rect = zone.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    targetY = -8 + ((x / rect.width) - .5) * 16;
    targetX = 18 - (((y / rect.height) - .5) * 12);
  };

  const onPointerLeave = (): void => {
    targetX = 18;
    targetY = -8;
  };

  const loopMatrix = (): void => {
    if (destroyed) return;
    currentX += (targetX - currentX) * .05;
    currentY += (targetY - currentY) * .05;
    stage.style.transform = `rotateX(${currentX}deg) rotateY(${currentY}deg)`;
    matrixFrame = requestAnimationFrame(loopMatrix);
  };

  zone.addEventListener("pointermove", onPointerMove);
  zone.addEventListener("pointerleave", onPointerLeave);
  loopMatrix();

  return () => {
    destroyed = true;
    zone.removeEventListener("pointermove", onPointerMove);
    zone.removeEventListener("pointerleave", onPointerLeave);
    cancelAnimationFrame(matrixFrame);
  };
}

function initGlobalEtherealSmokeSolver(): (() => void) | null {
  const canvas = document.querySelector<HTMLCanvasElement>("#fullscreen-ink-smoke-canvas");
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return null;
  const ctx: CanvasRenderingContext2D = context;
  const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let destroyed = false;
  let frame = 0;
  let lastPointerMoveAt = 0;
  let targetX = -1000;
  let targetY = -1000;
  let brushX = -1000;
  let brushY = -1000;
  let lastBrushX = -1000;
  let lastBrushY = -1000;
  let brushVx = 0;
  let brushVy = 0;
  let hasMoved = false;

  type PhysicalBristle = {
    offsetX: number;
    offsetY: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    vx: number;
    vy: number;
    spring: number;
    friction: number;
    thickness: number;
    color: string;
  };

  const bristles: PhysicalBristle[] = Array.from({ length: 300 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.pow(Math.random(), 2.6) * 16;
    const x = -1000;
    const y = -1000;
    return {
      offsetX: Math.cos(angle) * radius,
      offsetY: Math.sin(angle) * radius,
      x1: x,
      y1: y,
      x2: x,
      y2: y,
      vx: 0,
      vy: 0,
      spring: .15 + Math.random() * .4,
      friction: .45 + Math.random() * .4,
      thickness: .45 + Math.random() * 2.45,
      color: `rgba(${Math.round(12 + Math.random() * 14)}, ${Math.round(8 + Math.random() * 9)}, ${Math.round(5 + Math.random() * 5)}, `,
    };
  });

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const resetPointer = (): void => {
    hasMoved = false;
    targetX = -1000;
    targetY = -1000;
    brushX = -1000;
    brushY = -1000;
    lastBrushX = -1000;
    lastBrushY = -1000;
    brushVx = 0;
    brushVy = 0;
    for (const bristle of bristles) {
      bristle.x1 = -1000;
      bristle.y1 = -1000;
      bristle.x2 = -1000;
      bristle.y2 = -1000;
      bristle.vx = 0;
      bristle.vy = 0;
    }
  };

  const appendMove = (clientX: number, clientY: number): void => {
    if (reducedMotion) return;
    targetX = clientX;
    targetY = clientY;
    if (!hasMoved) {
      brushX = targetX;
      brushY = targetY;
      lastBrushX = targetX;
      lastBrushY = targetY;
      for (const bristle of bristles) {
        const x = targetX + bristle.offsetX;
        const y = targetY + bristle.offsetY;
        bristle.x1 = x;
        bristle.y1 = y;
        bristle.x2 = x;
        bristle.y2 = y;
        bristle.vx = 0;
        bristle.vy = 0;
      }
      hasMoved = true;
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if ("isPrimary" in event && !event.isPrimary) return;
    lastPointerMoveAt = performance.now();
    appendMove(event.clientX, event.clientY);
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (performance.now() - lastPointerMoveAt < 80) return;
    appendMove(event.clientX, event.clientY);
  };

  const onVisibilityChange = (): void => {
    if (document.hidden) resetPointer();
  };

  const loop = (): void => {
    if (destroyed) return;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0, 0, 0, .008)";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.globalCompositeOperation = "source-over";

    if (hasMoved) {
      lastBrushX = brushX;
      lastBrushY = brushY;
      const pullX = (targetX - brushX) * .2;
      const pullY = (targetY - brushY) * .2;
      brushVx = (brushVx + pullX) * .55;
      brushVy = (brushVy + pullY) * .55;
      brushX += brushVx;
      brushY += brushVy;

      const speed = Math.hypot(brushVx, brushVy);

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const coreThickness = Math.max(0, 22 - speed * .6);
      const coreAlpha = Math.max(0, .12 - speed * .003);
      if (speed > .08 && coreThickness > 0 && coreAlpha > 0) {
        ctx.beginPath();
        ctx.moveTo(lastBrushX, lastBrushY);
        ctx.lineTo(brushX, brushY);
        ctx.lineWidth = coreThickness;
        ctx.strokeStyle = `rgba(18, 11, 6, ${coreAlpha})`;
        ctx.stroke();
      }

      const spread = .8 + Math.min(speed * .02, .6);
      const bristleAlpha = Math.max(.015, .08 - speed * .0015);
      for (const bristle of bristles) {
        const targetBristleX = brushX + bristle.offsetX * spread;
        const targetBristleY = brushY + bristle.offsetY * spread;
        bristle.x1 = bristle.x2;
        bristle.y1 = bristle.y2;
        bristle.vx += (targetBristleX - bristle.x2) * bristle.spring;
        bristle.vx += (Math.random() - .5) * speed * .04;
        bristle.vx *= bristle.friction;
        bristle.vy += (targetBristleY - bristle.y2) * bristle.spring;
        bristle.vy += (Math.random() - .5) * speed * .04;
        bristle.vy *= bristle.friction;
        bristle.x2 += bristle.vx;
        bristle.y2 += bristle.vy;

        if (speed > .08) {
          ctx.beginPath();
          ctx.moveTo(bristle.x1, bristle.y1);
          ctx.lineTo(bristle.x2, bristle.y2);
          ctx.lineWidth = bristle.thickness;
          ctx.strokeStyle = `${bristle.color}${bristleAlpha})`;
          ctx.stroke();
        }
      }

      if (speed > .08 && speed < 1.5) {
        const radius = 12 + Math.random() * 20;
        const x = brushX + (Math.random() - .5) * 8;
        const y = brushY + (Math.random() - .5) * 8;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, "rgba(18, 11, 6, .014)");
        gradient.addColorStop(.42, "rgba(38, 25, 14, .005)");
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.fillStyle = gradient;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
    }

    frame = requestAnimationFrame(loop);
  };

  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("pointerleave", resetPointer);
  window.addEventListener("blur", resetPointer);
  document.addEventListener("visibilitychange", onVisibilityChange);
  loop();

  return () => {
    destroyed = true;
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("pointerleave", resetPointer);
    window.removeEventListener("blur", resetPointer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    cancelAnimationFrame(frame);
  };
}

function renderShelf(): string {
  return `
    <main class="shelf-page">
      <header class="viewbar">
        <button class="ghost-link" data-action="back-home">归案</button>
        <div>
          <div class="view-title">藏书阁</div>
        </div>
        <div class="shelf-actions">
          <button class="seal-mini" data-action="start-new">起新卷</button>
        </div>
      </header>
      <section class="bookcase-rack ${books.length ? "" : "empty-case"}">
        ${books.length ? books.map(renderBookSpine).join("") : `<div class="empty-bookcase">藏经阁尚空</div>`}
      </section>
    </main>
  `;
}

function renderBookSpine(book: BookRecord): string {
  const isFinished = book.status === "finished";
  return `
    <div class="book-spine-item"
      style="--paper:${book.coverStyle.paper}; --seal:${book.coverStyle.seal}"
      data-action="inspect-book"
      data-id="${book.id}"
      role="button"
      tabindex="0"
      title="${attr(book.title)}">
      <div class="spine-status-dot ${isFinished ? "finished" : "ongoing"}"></div>
      <div class="spine-title">${esc(book.title)}</div>
    </div>
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
  const ageStr = state.age != null ? `${state.age}春秋` : "";
  const infoLine = [state.world, ageStr, state.oneline].filter(Boolean).join(" · ");
  return `
    <main class="reader">
      <header id="topbar">
        <div id="whoami">
          <h1 id="name">${esc(book.title || "未名之卷")}</h1>
          <div id="sub">${esc(infoLine || "命运尚未启封")}</div>
        </div>
        <nav class="reader-nav">
          <button class="nav-text-link" data-action="back-home">归案</button>
          <button class="nav-text-link" data-action="open-stats">命格</button>
          <button class="nav-text-link" data-action="open-relationships">因缘</button>
          <button class="nav-text-link" data-action="open-settings">笔墨</button>
        </nav>
      </header>

      <button class="nav-wing left ${atStart ? "disabled" : ""}" data-action="prev-page" title="上一卷">前卷</button>
      <button class="nav-wing right ${atEnd ? "disabled" : ""}" data-action="next-page" title="下一卷">后卷</button>

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
      <div class="story settled-text"><span class="dropcap">命</span>运尚未落笔。启封新卷后，此处会逐页留下你的一生。</div>
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
      <div class="story settled-text">${storyHTML(page.narrative)}</div>
      ${page.event ? `<div class="event ink-anim"><b>变故 · </b>${esc(page.event)}</div>` : ""}
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
    <section id="dock">
      <div id="dock-content">
        ${busy ? `<div class="dock-hint">墨迹未干...</div>` : dead ? renderFinaleDock() : renderChoiceDock(state)}
      </div>
    </section>
  `;
}

function renderFinaleDock(): string {
  return `<div class="dock-hint">此生已成卷 <button id="openDeath" data-action="open-finale">展开终章笺</button></div>`;
}

function renderChoiceDock(state: LifeState): string {
  const choices = state.choices || [];
  const cnNums = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾"];
  const delay = (seconds: number) => `${seconds.toFixed(2)}s`;
  const freeDelay = delay(choices.length * 0.15 + 0.1);
  const rerollDelay = delay(choices.length * 0.15 + 0.2);
  return `
    <div class="choices">
      ${choices.map((choice, index) => `
        <button class="choice ink-anim" style="animation-delay:${delay(index * 0.15)}" data-action="choice" data-choice="${attr(choice)}">
          <span class="num">${cnNums[index] || index + 1}</span>
          <span class="txt">${esc(choice)}</span>
        </button>
      `).join("")}
    </div>
    <div class="freerow ink-anim" style="animation-delay:${freeDelay}">
      <input id="freein" placeholder="或，执笔写下你的去向…" autocomplete="off" ${busy ? "disabled" : ""}/>
      <button id="sendbtn" data-action="send-free" ${busy ? "disabled" : ""}>落笔</button>
    </div>
    <div class="reroll-row ink-anim" style="animation-delay:${rerollDelay}">
      <button id="newchoices" data-action="reroll">运势不佳，另求出路</button>
    </div>
  `;
}

function renderModal(): string {
  if (!modal) return "";
  if (modal === "inspect") {
    const book = inspectingBookId ? books.find((item) => item.id === inspectingBookId) : null;
    if (book) return renderBookInspectModal(book);
    return "";
  }
  if (modal === "settings") return renderSettingsModal();
  if (modal === "stats") return renderStatsModal();
  if (modal === "relationships") return renderRelationshipsModal();
  return renderFinaleModal();
}

function renderBookInspectModal(book: BookRecord): string {
  const age = book.state.age != null ? `${book.state.age}春秋` : "年岁未详";
  return `
    <div class="modal on inspect-modal" data-action="close-inspect">
      <div class="inspect-stage" aria-label="书本详情">
        <div class="inspect-book-cover" style="--paper:${book.coverStyle.paper}; --seal:${book.coverStyle.seal}">
          <div class="cover-binding"></div>
          <div class="cover-label">
            <h2 class="cover-title">${esc(book.title)}</h2>
          </div>
        </div>

        <div class="inspect-info">
          <div class="info-meta">${esc(book.protagonist || "无名者")} · ${esc(book.world)}</div>
          <div class="info-summary">${esc(book.summaryLine || age)}</div>
          <div class="info-time">落笔于 ${formatDate(book.updatedAt)}</div>

          <div class="inspect-actions">
            ${book.status === "ongoing" ? `<button class="action-btn" data-action="continue-book" data-id="${book.id}">续写本卷</button>` : ""}
            <button class="action-btn" data-action="read-book" data-id="${book.id}">翻阅生平</button>
            ${book.status === "finished" ? `<button class="action-btn" data-action="open-finale-book" data-id="${book.id}">查看终章</button>` : ""}
            <button class="action-btn danger" data-action="delete-book" data-id="${book.id}">焚毁此卷</button>
          </div>
        </div>
      </div>
    </div>
  `;
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
  if (actionEl.classList.contains("modal") && target !== actionEl) return;
  const action = actionEl.dataset.action || "";
  if (action === "close-modal") {
    event.preventDefault();
    const clickedBackdrop = actionEl.classList.contains("modal") && target === actionEl;
    const clickedCloseButton = actionEl.tagName === "BUTTON";
    if (clickedBackdrop || clickedCloseButton) {
      modal = null;
      inspectingBookId = null;
      renderApp();
    }
    return;
  }
  if (action === "close-inspect") {
    event.preventDefault();
    if (target.classList.contains("inspect-modal")) {
      modal = null;
      inspectingBookId = null;
      renderApp();
    }
    return;
  }
  event.preventDefault();

  if (action === "back-home") {
    view = "home";
    modal = null;
    inspectingBookId = null;
    renderApp();
  } else if (action === "open-shelf") {
    view = "shelf";
    modal = null;
    inspectingBookId = null;
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
  } else if (action === "inspect-book") {
    inspectingBookId = actionEl.dataset.id || null;
    modal = "inspect";
    renderApp();
  } else if (action === "start-new" || action === "reincarnate") {
    inspectingBookId = null;
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
  const target = event.target as HTMLElement;
  if (event.key === "Enter" && target.id === "freein") {
    event.preventDefault();
    await sendFreeInput();
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  const actionEl = target.closest<HTMLElement>('[data-action="inspect-book"]');
  if (actionEl) {
    event.preventDefault();
    actionEl.click();
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
  inspectingBookId = null;
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
  inspectingBookId = null;
  modal = null;
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
  if (story) {
    story.classList.add("streaming-text");
    story.classList.remove("settled-text", "ink-anim");
    story.innerHTML = `${storyHTML(page.narrative)}<span class="ink-cursor"></span>`;
  }
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
