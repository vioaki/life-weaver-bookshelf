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

type Modal = null | "settings" | "stats" | "relationships" | "finale" | "inspect" | "burn";

interface PendingRetry {
  bookId: string;
  message: string;
  error: string;
}

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
let inspectingBookId: string | null = null;
let burnTargetId: string | null = null;
let pendingRetry: PendingRetry | null = null;
let streamFollow = true;
let followScrollFrame = 0;
let lastTouchY = 0;
let homeBookEngineCleanup: (() => void) | null = null;
let globalInkEngineCleanup: (() => void) | null = null;
let backdropPointerStarted = false;
let activeController: AbortController | null = null;
let homeEnginePending = false;
let renderedHomeSig = "";
let renderedShelfSig = "";
let renderedReaderSig = "";
let renderedModalKey = "";
let lastFocusedBeforeModal: HTMLElement | null = null;

app.addEventListener("pointerdown", handlePointerDown);
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
      <canvas id="fullscreen-ink-smoke-canvas" class="ink-fluid-overlay"></canvas>
      <div id="backdrop"></div>
      <div id="view-sandbox-home" class="view-sandbox"></div>
      <div id="view-sandbox-shelf" class="view-sandbox"></div>
      <div id="view-sandbox-reader" class="view-sandbox"></div>
    `;
    homeSandbox = app.querySelector<HTMLElement>("#view-sandbox-home")!;
    shelfSandbox = app.querySelector<HTMLElement>("#view-sandbox-shelf")!;
    readerSandbox = app.querySelector<HTMLElement>("#view-sandbox-reader")!;
    renderedHomeSig = "";
    renderedShelfSig = "";
    renderedReaderSig = "";
    renderedModalKey = "";
    globalInkEngineCleanup?.();
    globalInkEngineCleanup = initGlobalEtherealSmokeSolver();
    attachStreamFollowGuards(readerSandbox);
  }

  if (view === "home") {
    const homeSig = `${books.length}|${books.filter((b) => b.status === "ongoing").length}|${books.filter((b) => b.status === "finished").length}`;
    if (homeSig !== renderedHomeSig) {
      stopHomeBookEngine();
      homeSandbox.innerHTML = renderHome();
      renderedHomeSig = homeSig;
    }
    // 回到书案时合上此前翻开的封面。
    homeSandbox.querySelector("#mesh-stage")?.classList.remove("book-opening");
    if (!homeBookEngineCleanup && !homeEnginePending) {
      homeEnginePending = true;
      requestAnimationFrame(() => {
        homeEnginePending = false;
        if (view === "home" && !homeBookEngineCleanup) homeBookEngineCleanup = initTopTierInteractiveBook();
      });
    }
  } else {
    stopHomeBookEngine();
  }

  if (view === "shelf") {
    const shelfSig = `n${books.length}|` + books.map((b) => `${b.id}:${b.status}:${b.title}`).join("|");
    if (shelfSig !== renderedShelfSig) {
      shelfSandbox.innerHTML = renderShelf();
      renderedShelfSig = shelfSig;
    }
  }

  if (view === "reader") {
    const book = activeBook;
    const sig = book
      ? `${book.id}|${book.pages.length}|${busy}|${book.status}|${book.title}|${book.state.world ?? ""}|${book.state.oneline ?? ""}|${book.state.age ?? ""}|${pendingRetry ? "retry" : ""}`
      : "none";
    if (sig !== renderedReaderSig) {
      readerSandbox.innerHTML = renderReader();
      renderedReaderSig = sig;
    }
    syncReaderPage();
  }

  homeSandbox.classList.toggle("active-view", view === "home");
  shelfSandbox.classList.toggle("active-view", view === "shelf");
  readerSandbox.classList.toggle("active-view", view === "reader");

  const modalKey = modal ? `${modal}:${inspectingBookId ?? ""}:${burnTargetId ?? ""}` : "";
  if (modalKey !== renderedModalKey) {
    const current = app.querySelector<HTMLElement>(".modal-layer-global:not(.is-leaving)");
    if (modal) {
      app.querySelectorAll(".modal-layer-global.is-leaving").forEach((el) => el.remove());
      current?.remove();
      const layer = document.createElement("div");
      layer.className = "modal-layer-global";
      layer.innerHTML = renderModal();
      app.appendChild(layer);
      focusModal(layer);
    } else {
      if (current) dismissModalLayer(current);
      restoreFocusAfterModal();
    }
    renderedModalKey = modalKey;
  }
}

function syncReaderPage(): void {
  const slider = app.querySelector<HTMLElement>("#book-slider");
  if (!slider) return;
  slider.style.transform = `translateX(-${currentPageIndex * 100}%)`;
  const pages = slider.querySelectorAll<HTMLElement>(".book-page");
  pages.forEach((page, index) => page.classList.toggle("active", index === currentPageIndex));
  const total = activeBook?.pages.length || 0;
  const hasPages = total > 0;
  app.querySelector(".nav-wing.left")?.classList.toggle("disabled", currentPageIndex <= 0);
  app.querySelector(".nav-wing.right")?.classList.toggle("disabled", !hasPages || currentPageIndex >= total - 1);
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
          <button class="seal-btn" data-action="open-shelf">藏 书 阁</button>
        </div>

        <div class="ledger-strip">
          <span>藏书 <strong class="num-all">${books.length}</strong></span>
          <span>未竟 <strong class="num-ongoing">${ongoing}</strong></span>
          <span>终章 <strong class="num-finished">${finished}</strong></span>
        </div>
      </section>

      <section class="home-right-panel" id="interactive-desk-zone" aria-hidden="true">
        <div class="home-dust" aria-hidden="true"></div>
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
  let running = false;
  let currentX = 18;
  let currentY = -8;
  let targetX = 18;
  let targetY = -8;
  let isGyroActive = false;

  stage.style.transform = `rotateX(${currentX}deg) rotateY(${currentY}deg)`;

  const ensureRunning = (): void => {
    if (reducedMotion || destroyed || running) return;
    running = true;
    matrixFrame = requestAnimationFrame(loopMatrix);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (reducedMotion || isGyroActive) return;
    const rect = zone.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    targetY = -8 + ((x / rect.width) - .5) * 16;
    targetX = 18 - (((y / rect.height) - .5) * 12);
    ensureRunning();
  };

  const onPointerLeave = (): void => {
    if (isGyroActive) return;
    targetX = 18;
    targetY = -8;
    ensureRunning();
  };

  const onDeviceOrientation = (event: DeviceOrientationEvent): void => {
    if (reducedMotion || event.gamma === null || event.beta === null) return;

    isGyroActive = true;
    const gamma = Math.max(-35, Math.min(35, event.gamma));
    const beta = Math.max(10, Math.min(80, event.beta));

    targetY = -8 + (gamma / 35) * 14;
    targetX = 18 + ((45 - beta) / 35) * 10;
    ensureRunning();
  };

  const loopMatrix = (): void => {
    if (destroyed) return;
    currentX += (targetX - currentX) * .05;
    currentY += (targetY - currentY) * .05;
    stage.style.transform = `rotateX(${currentX}deg) rotateY(${currentY}deg)`;
    if (Math.abs(targetX - currentX) < .01 && Math.abs(targetY - currentY) < .01) {
      currentX = targetX;
      currentY = targetY;
      stage.style.transform = `rotateX(${currentX}deg) rotateY(${currentY}deg)`;
      running = false;
      return;
    }
    matrixFrame = requestAnimationFrame(loopMatrix);
  };

  let gyroBound = false;
  const bindGyro = (): void => {
    if (gyroBound || destroyed) return;
    gyroBound = true;
    window.addEventListener("deviceorientation", onDeviceOrientation);
  };
  // iOS 13+ 只在用户手势内调用 requestPermission 后才下发陀螺仪数据。
  const orientationCtor = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  const needsGyroPermission = typeof orientationCtor?.requestPermission === "function";
  const requestGyroPermission = (): void => {
    orientationCtor?.requestPermission?.()
      .then((state) => {
        if (state === "granted") bindGyro();
      })
      .catch(() => {});
  };
  if (needsGyroPermission) {
    window.addEventListener("pointerdown", requestGyroPermission, { once: true });
  } else {
    bindGyro();
  }

  zone.addEventListener("pointermove", onPointerMove);
  zone.addEventListener("pointerleave", onPointerLeave);

  return () => {
    destroyed = true;
    running = false;
    zone.removeEventListener("pointermove", onPointerMove);
    zone.removeEventListener("pointerleave", onPointerLeave);
    if (needsGyroPermission) window.removeEventListener("pointerdown", requestGyroPermission);
    if (gyroBound) window.removeEventListener("deviceorientation", onDeviceOrientation);
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
  let running = false;
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
  let inkVolatilityTimer: number | null = null;
  let inkClearTimer: number | null = null;

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

  const restoreCanvasOpacity = (): void => {
    if (inkClearTimer !== null) {
      window.clearTimeout(inkClearTimer);
      inkClearTimer = null;
    }
    canvas.style.transition = "";
    canvas.style.opacity = "";
  };

  const scheduleInkFade = (): void => {
    if (reducedMotion) return;
    if (inkVolatilityTimer !== null) window.clearTimeout(inkVolatilityTimer);
    restoreCanvasOpacity();
    inkVolatilityTimer = window.setTimeout(() => {
      canvas.style.transition = "opacity 3s ease";
      canvas.style.opacity = "0";
      inkClearTimer = window.setTimeout(() => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        restoreCanvasOpacity();
      }, 3000);
      inkVolatilityTimer = null;
    }, 8000);
  };

  const createInkSplash = (x: number, y: number): void => {
    if (reducedMotion) return;
    const radius = 10 + Math.random() * 14;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, "rgba(18, 11, 6, .055)");
    gradient.addColorStop(.35, "rgba(38, 25, 14, .018)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  };

  const appendMove = (clientX: number, clientY: number): void => {
    if (reducedMotion) return;
    if (!hasMoved) {
      targetX = clientX;
      targetY = clientY;
      brushX = clientX;
      brushY = clientY;
      lastBrushX = clientX;
      lastBrushY = clientY;
      for (const bristle of bristles) {
        const x = clientX + bristle.offsetX;
        const y = clientY + bristle.offsetY;
        bristle.x1 = x;
        bristle.y1 = y;
        bristle.x2 = x;
        bristle.y2 = y;
        bristle.vx = 0;
        bristle.vy = 0;
      }
      hasMoved = true;
      createInkSplash(clientX, clientY);
      scheduleInkFade();
      return;
    }

    const dx = clientX - brushX;
    const dy = clientY - brushY;
    if (Math.hypot(dx, dy) < 2) return;

    targetX = clientX;
    targetY = clientY;
    scheduleInkFade();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if ("isPrimary" in event && !event.isPrimary) return;
    resetPointer();
    lastPointerMoveAt = performance.now();
    appendMove(event.clientX, event.clientY);
    ensureRunning();
  };

  const onPointerMove = (event: PointerEvent): void => {
    if ("isPrimary" in event && !event.isPrimary) return;
    lastPointerMoveAt = performance.now();
    appendMove(event.clientX, event.clientY);
    ensureRunning();
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (performance.now() - lastPointerMoveAt < 80) return;
    appendMove(event.clientX, event.clientY);
    ensureRunning();
  };

  const onVisibilityChange = (): void => {
    if (document.hidden) resetPointer();
  };

  const loop = (): void => {
    if (destroyed) return;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0, 0, 0, .002)";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.globalCompositeOperation = "source-over";

    if (!hasMoved) {
      running = false;
      return;
    }

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

      const idle = performance.now() - lastPointerMoveAt > 600;
      const settled = Math.hypot(targetX - brushX, targetY - brushY) < .5 && speed < .05;
      if (idle && settled) {
        running = false;
        return;
      }
    }

    frame = requestAnimationFrame(loop);
  };

  const ensureRunning = (): void => {
    if (reducedMotion || destroyed || running) return;
    running = true;
    frame = requestAnimationFrame(loop);
  };

  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", resetPointer);
  window.addEventListener("pointercancel", resetPointer);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("pointerleave", resetPointer);
  window.addEventListener("blur", resetPointer);
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (!reducedMotion) ensureRunning();

  return () => {
    destroyed = true;
    if (inkVolatilityTimer !== null) window.clearTimeout(inkVolatilityTimer);
    if (inkClearTimer !== null) window.clearTimeout(inkClearTimer);
    restoreCanvasOpacity();
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", resetPointer);
    window.removeEventListener("pointercancel", resetPointer);
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
        ${books.length ? books.map(renderBookSpine).join("") : `<div class="empty-bookcase">藏书阁尚空</div>`}
      </section>
    </main>
  `;
}

function renderBookSpine(book: BookRecord, index: number): string {
  const isFinished = book.status === "finished";
  return `
    <div class="book-spine-item"
      style="--paper:${book.coverStyle.paper}; --seal:${book.coverStyle.seal}; --spine-i:${index}"
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
  const currentAge = state.age != null ? state.age : "?";
  const infoLine = [state.world, state.oneline].filter(Boolean).join(" · ");
  return `
    <main class="reader">
      <header id="topbar">
        <div id="whoami">
          <h1 id="name">${esc(book.title || "未名之卷")}</h1>
          <div id="sub">${esc(infoLine || "命运尚未启封")}</div>
        </div>
        <div class="reader-age-seal" title="当前岁数">
          <span class="age-num">${esc(currentAge)}</span>
          <span class="age-unit">岁</span>
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
      <div class="story settled-text"><p class="p-lead"><span class="dropcap">命</span>运尚未落笔。启封新卷后，此处会逐页留下你的一生。</p></div>
      <div class="page-num">— 序 —</div>
    </article>
  `;
}

function renderPage(page: BookPage, index: number): string {
  const active = index === currentPageIndex ? "active" : "";
  const chapter = toChineseNumeral(index + 1);
  return `
    <article class="book-page ${active}" data-idx="${index}">
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
  const retry = pendingRetry && pendingRetry.bookId === book.id ? pendingRetry : null;
  return `
    <section id="dock">
      <div id="dock-content">
        ${busy ? `<div class="dock-hint writing">墨迹未干</div>` : retry ? renderRetryDock(retry) : dead ? renderFinaleDock() : renderChoiceDock(state)}
      </div>
    </section>
  `;
}

function renderFinaleDock(): string {
  return `<div class="dock-hint">此生已成卷 <button id="openDeath" data-action="open-finale">展开终章笺</button></div>`;
}

function renderRetryDock(retry: PendingRetry): string {
  return `
    <div class="mishap ink-anim">
      <div class="mishap-title">笔 锋 中 断</div>
      <div class="mishap-reason">${esc(retry.error)}</div>
      <div class="mishap-actions">
        <button class="mishap-retry" data-action="retry-turn">补笔重试</button>
        <button class="mishap-dismiss" data-action="dismiss-retry">搁笔不提</button>
      </div>
    </div>
  `;
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
  if (modal === "burn") {
    const book = burnTargetId ? books.find((item) => item.id === burnTargetId) : null;
    if (book) return renderBurnModal(book);
    return "";
  }
  return renderFinaleModal();
}

function renderBookInspectModal(book: BookRecord): string {
  return `
    <div class="modal on inspect-modal" data-action="close-inspect">
      <div class="inspect-stage" role="dialog" aria-modal="true" aria-label="书本详情">
        <div class="inspect-book-cover" style="--paper:${book.coverStyle.paper}; --seal:${book.coverStyle.seal}">
          <div class="cover-binding"></div>
          <div class="cover-label">
            <h2 class="cover-title">${esc(book.title)}</h2>
          </div>
        </div>

        <div class="inspect-info">
          <div class="info-meta">${esc(book.protagonist || "无名者")} · ${esc(book.world)}</div>
          <div class="info-summary">${esc(makeSummaryLine(book.state))}</div>
          <div class="info-time">落笔于 ${formatDate(book.updatedAt)}</div>

          <div class="inspect-actions">
            ${book.status === "ongoing" ? `<button class="action-btn" data-action="continue-book" data-id="${book.id}">续写本卷</button>` : ""}
            <button class="action-btn" data-action="read-book" data-id="${book.id}">翻阅生平</button>
            ${book.status === "finished" ? `<button class="action-btn" data-action="open-finale-book" data-id="${book.id}">查看终章</button>` : ""}
            <button class="action-btn danger" data-action="delete-book" data-id="${book.id}">焚毁此卷</button>
            <button class="action-btn subtle" data-action="close-modal">放回架上</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderBurnModal(book: BookRecord): string {
  return `
    <div class="modal on burn-modal" data-action="close-modal">
      <div class="sheet burn-sheet" role="dialog" aria-modal="true" aria-label="焚毁确认">
        <h2>焚 毁 此 卷</h2>
        <p class="burn-line">${esc(book.title)} 将付之一炬。</p>
        <p class="burn-line dim">${esc(book.protagonist || "无名者")}的一生字句成灰，从此不可复得。</p>
        <div class="burn-actions">
          <button class="btn ghost" type="button" data-action="close-modal">且慢，放回</button>
          <button class="btn burn-confirm" type="button" data-action="confirm-burn" data-id="${attr(book.id)}">付之一炬</button>
        </div>
      </div>
    </div>
  `;
}

function renderSettingsModal(): string {
  return `
    <div class="modal on" data-action="close-modal">
      <form class="sheet" id="settingsForm" role="dialog" aria-modal="true" aria-label="笔墨与接口设置">
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
      <div class="sheet" role="dialog" aria-modal="true" aria-label="命格与纪事">
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
      <div class="sheet" role="dialog" aria-modal="true" aria-label="书中人物因缘">
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
  const statsHTML = renderFinalStats(book?.state);

  return `
    <div id="death" class="on">
      <div class="death-scroll" role="dialog" aria-modal="true" aria-label="终章">

        <div class="death-zen-circle"></div>

        <div class="death-header">
          <h1>此生已矣 · 盖棺定论</h1>
        </div>

        <div class="death-title">${esc(finale.title || book?.title || "无名的一生")}</div>
        <div class="death-meta">享年 ${book?.state.age ?? "?"} 春秋 <span>·</span> 命绝于：${esc(finale.cause || "未知")}</div>

        <div class="death-eulogy">
          <p>${esc(finale.summary || "")}</p>
          ${finale.analysis ? `<p class="analysis"><strong>【判词】</strong>${esc(finale.analysis)}</p>` : ""}
        </div>

        <div class="death-karma">
          <div class="karma-title">一生因果</div>
          <div class="finals">${statsHTML}</div>
        </div>

        <div class="death-actions">
          <button class="action-text" data-action="close-modal">默默合卷</button>
          <div class="action-divider"></div>
          <button class="action-seal" data-action="reincarnate">重入轮回</button>
        </div>
      </div>
    </div>
  `;
}

function handlePointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement;
  const actionEl = target.closest<HTMLElement>("[data-action]");
  backdropPointerStarted = !!actionEl?.classList.contains("modal") && target === actionEl;
}

async function handleClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement;
  const actionEl = target.closest<HTMLElement>("[data-action]");
  if (!actionEl) {
    backdropPointerStarted = false;
    return;
  }
  if (actionEl.classList.contains("modal") && target !== actionEl) return;
  const action = actionEl.dataset.action || "";
  if (action === "close-modal") {
    event.preventDefault();
    const clickedBackdrop = backdropPointerStarted && actionEl.classList.contains("modal") && target === actionEl;
    const clickedCloseButton = actionEl.tagName === "BUTTON";
    if (clickedBackdrop || clickedCloseButton) closeModal();
    backdropPointerStarted = false;
    return;
  }
  if (action === "close-inspect") {
    event.preventDefault();
    if (backdropPointerStarted && target.classList.contains("inspect-modal")) {
      modal = null;
      inspectingBookId = null;
      renderApp();
    }
    backdropPointerStarted = false;
    return;
  }
  event.preventDefault();

  if (action === "back-home") {
    cancelActiveTurn();
    view = "home";
    modal = null;
    inspectingBookId = null;
    renderApp();
  } else if (action === "open-shelf") {
    cancelActiveTurn();
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
    renderApp();
  } else if (action === "inspect-book") {
    inspectingBookId = actionEl.dataset.id || null;
    modal = "inspect";
    renderApp();
  } else if (action === "reincarnate") {
    playReincarnateEffect();
    cancelActiveTurn();
    view = "home";
    modal = null;
    inspectingBookId = null;
    renderApp();
  } else if (action === "start-new") {
    inspectingBookId = null;
    await startNewBook();
  } else if (action === "continue-latest") {
    const latest = books.find((book) => book.status === "ongoing") || books[0];
    if (latest) await openBook(latest.id);
  } else if (action === "continue-book") {
    await openBook(actionEl.dataset.id || "");
  } else if (action === "read-book") {
    await openBook(actionEl.dataset.id || "", undefined, "first");
  } else if (action === "open-finale-book") {
    await openBook(actionEl.dataset.id || "", "finale");
  } else if (action === "delete-book") {
    burnTargetId = actionEl.dataset.id || null;
    modal = "burn";
    renderApp();
  } else if (action === "confirm-burn") {
    await burnBook(actionEl.dataset.id || "");
  } else if (action === "retry-turn") {
    await retryFailedTurn();
  } else if (action === "dismiss-retry") {
    await dismissFailedTurn();
  } else if (action === "prev-page") {
    flipTo(currentPageIndex - 1);
  } else if (action === "next-page") {
    flipTo(currentPageIndex + 1);
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
  if (modal) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key === "Tab") {
      trapModalTab(event);
      return;
    }
  }
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

function closeModal(): void {
  if (modal === "burn" && inspectingBookId) {
    // 焚毁确认若是从详阅面板进入的，取消时应放回详阅，而不是一并关掉。
    modal = "inspect";
    burnTargetId = null;
  } else {
    modal = null;
    inspectingBookId = null;
    burnTargetId = null;
  }
  renderApp();
}

function modalFocusables(layer: HTMLElement): HTMLElement[] {
  return Array.from(
    layer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function trapModalTab(event: KeyboardEvent): void {
  const layer = app.querySelector<HTMLElement>(".modal-layer-global");
  if (!layer) return;
  const items = modalFocusables(layer);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (event.shiftKey && (active === first || !layer.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function focusModal(layer: HTMLElement): void {
  lastFocusedBeforeModal = (document.activeElement as HTMLElement) || null;
  const items = modalFocusables(layer);
  if (items[0]) {
    items[0].focus({ preventScroll: true });
  } else {
    layer.tabIndex = -1;
    layer.focus({ preventScroll: true });
  }
  layer.querySelectorAll<HTMLElement>("#death, .modal").forEach((el) => {
    el.scrollTop = 0;
  });
}

function restoreFocusAfterModal(): void {
  const el = lastFocusedBeforeModal;
  lastFocusedBeforeModal = null;
  if (el && document.contains(el)) el.focus();
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function dismissModalLayer(layer: HTMLElement): void {
  if (prefersReducedMotion()) {
    layer.remove();
    return;
  }
  layer.classList.add("is-leaving");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    layer.remove();
  };
  layer.addEventListener("animationend", finish, { once: true });
  window.setTimeout(finish, 460);
}

function playReincarnateEffect(): void {
  if (prefersReducedMotion()) return;

  const layer = document.createElement("div");
  layer.className = "reincarnate-fx fx-petal";
  layer.setAttribute("aria-hidden", "true");

  const label = document.createElement("div");
  label.className = "reincarnate-fx-label";
  label.textContent = "花谢花开 · 又是一生";
  layer.appendChild(label);

  const rand = (min: number, max: number) => min + Math.random() * (max - min);

  // Spread is driven by the real viewport: each petal flies toward the screen
  // edge along its own angle, so larger screens disperse the bloom wider.
  const hw = window.innerWidth / 2;
  const hh = window.innerHeight / 2;
  const diag = Math.hypot(hw, hh);
  const count = Math.round(Math.min(66, Math.max(40, diag / 15)));
  for (let i = 0; i < count; i++) {
    const p = document.createElement("span");
    p.className = "fx-particle";

    // Bloom outward from the center in every direction. Angles are spread
    // evenly around the full circle with jitter so it reads as organic.
    const baseAngle = (i / count) * Math.PI * 2;
    const angle = baseAngle + rand(-0.3, 0.3);
    const ax = Math.max(Math.abs(Math.cos(angle)), 1e-3);
    const ay = Math.max(Math.abs(Math.sin(angle)), 1e-3);
    // Distance to the viewport edge along this angle, then carry most petals
    // out near (or just past) the rim for an airy, far-reaching scatter.
    const edge = Math.min(hw / ax, hh / ay);
    const dist = edge * rand(0.62, 1.04);
    const startX = rand(-10, 10);
    const startY = rand(-10, 10);
    const tx = Math.cos(angle) * dist;
    const ty = Math.sin(angle) * dist + rand(12, 46);   // gentle downward settle
    // Curve the path: bow the midpoint perpendicular to travel.
    const perp = angle + Math.PI / 2;
    const curve = rand(-46, 46);
    const midX = tx * 0.5 + Math.cos(perp) * curve;
    const midY = ty * 0.45 + Math.sin(perp) * curve - rand(10, 34);

    p.style.setProperty("--x0", `${startX}px`);
    p.style.setProperty("--y0", `${startY}px`);
    p.style.setProperty("--mx", `${midX}px`);
    p.style.setProperty("--my", `${midY}px`);
    p.style.setProperty("--tx", `${tx}px`);
    p.style.setProperty("--ty", `${ty}px`);
    p.style.setProperty("--r0", `${rand(-30, 30)}deg`);
    p.style.setProperty("--r1", `${rand(-160, 160)}deg`);
    p.style.setProperty("--rot", `${rand(-320, 320)}deg`);
    p.style.setProperty("--scale", `${rand(0.7, 1.7)}`);
    p.style.setProperty("--peak", `${rand(0.82, 1)}`);
    p.style.setProperty("--delay", `${rand(0, 0.55)}s`);
    p.style.setProperty("--dur", `${rand(3, 4.4)}s`);
    p.style.setProperty("--hue", `${rand(-16, 16)}deg`);
    layer.appendChild(p);
  }

  document.body.appendChild(layer);
  window.setTimeout(() => layer.remove(), 5400);
}

// 焚毁书卷：一页信纸自下而上焦黑蜷曲，火星与纸灰升腾散尽。
function playBurnEffect(book: BookRecord): void {
  if (prefersReducedMotion()) return;

  const layer = document.createElement("div");
  layer.className = "burn-fx";
  layer.setAttribute("aria-hidden", "true");

  const paper = document.createElement("div");
  paper.className = "burn-fx-paper";
  paper.style.setProperty("--paper", book.coverStyle.paper);
  paper.style.setProperty("--seal", book.coverStyle.seal);
  const title = document.createElement("div");
  title.className = "burn-fx-title";
  title.textContent = book.title;
  paper.appendChild(title);
  layer.appendChild(paper);

  const label = document.createElement("div");
  label.className = "burn-fx-label";
  label.textContent = "字句成灰 · 就此别过";
  layer.appendChild(label);

  const rand = (min: number, max: number) => min + Math.random() * (max - min);
  for (let i = 0; i < 30; i++) {
    const spark = document.createElement("span");
    spark.className = i % 3 === 0 ? "burn-fx-ash" : "burn-fx-ember";
    spark.style.setProperty("--bx0", `${rand(-92, 92)}px`);
    spark.style.setProperty("--bx1", `${rand(-150, 150)}px`);
    spark.style.setProperty("--by1", `${rand(-330, -150)}px`);
    spark.style.setProperty("--bdelay", `${rand(0.5, 1.9)}s`);
    spark.style.setProperty("--bdur", `${rand(1.2, 2.3)}s`);
    spark.style.setProperty("--bscale", `${rand(0.5, 1.2)}`);
    layer.appendChild(spark);
  }

  document.body.appendChild(layer);
  window.setTimeout(() => layer.remove(), 3600);
}

// 起卷/续卷时，书案上那本书先翻开封面再入长卷，衔接「翻开一本书」的心象。
async function playBookOpenTransition(): Promise<void> {
  if (view !== "home" || prefersReducedMotion()) return;
  const stage = app.querySelector<HTMLElement>("#mesh-stage");
  if (!stage || stage.classList.contains("book-opening")) return;
  stopHomeBookEngine();
  stage.classList.add("book-opening");
  await new Promise((resolve) => window.setTimeout(resolve, 560));
}

async function startNewBook(): Promise<void> {
  if (!cfg.key.trim()) {
    modal = "settings";
    renderApp();
    return;
  }
  cancelActiveTurn();
  pendingRetry = null;
  await playBookOpenTransition();
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
  renderApp();
  await runTurn("游戏开始。请随机生成时代背景、我的性别(男女各50%)、外貌、姓名、出身家庭与健康等设定，并从0~10岁阶段开始对我提出第一个抉择。记得输出STATE。");
}

async function openBook(id: string, openModal?: Modal, startAt: "first" | "last" = "last"): Promise<void> {
  const book = await getBook(id);
  if (!book) return;
  cancelActiveTurn();
  pendingRetry = null;
  await playBookOpenTransition();
  if (book.pages.length === 0 && book.history.length > 0) {
    book.pages = rebuildPagesFromHistory(book.history);
    await saveBook(book);
  }
  activeBook = book;
  setActiveBookId(book.id);
  view = "reader";
  modal = openModal || null;
  inspectingBookId = null;
  currentPageIndex = startAt === "first" ? 0 : Math.max(0, book.pages.length - 1);
  renderApp();
}

async function burnBook(id: string): Promise<void> {
  const book = books.find((item) => item.id === id);
  if (!book) return;
  if (activeBook?.id === id) cancelActiveTurn();
  if (pendingRetry?.bookId === id) pendingRetry = null;
  modal = null;
  inspectingBookId = null;
  burnTargetId = null;
  playBurnEffect(book);
  await deleteBook(id);
  if (activeBook?.id === id) activeBook = null;
  await refreshBooks();
  view = "shelf";
  renderApp();
}

async function retryFailedTurn(): Promise<void> {
  const retry = pendingRetry;
  const book = activeBook;
  if (!retry || !book || book.id !== retry.bookId || busy) return;
  pendingRetry = null;
  await runTurn(retry.message);
}

async function dismissFailedTurn(): Promise<void> {
  const retry = pendingRetry;
  const book = activeBook;
  pendingRetry = null;
  if (retry && book && book.id === retry.bookId) {
    const last = book.pages[book.pages.length - 1];
    if (last?.choiceMade && retry.message === `我的选择：${last.choiceMade}`) {
      last.choiceMade = "";
      await saveBook(book);
    }
  }
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

function cancelActiveTurn(): void {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
  busy = false;
}

async function runTurn(userMsg: string): Promise<void> {
  const book = activeBook;
  if (!book || busy) return;
  busy = true;
  pendingRetry = null;
  const historyEntry: ChatMessage = { role: "user", content: userMsg };
  book.history.push(historyEntry);
  const pageIndex = book.pages.length;
  const draftPage: BookPage = { era_label: "起笔中…", narrative: "", event: "", deltas: [], choiceMade: "", choices: [], dead: false, death: null };
  book.pages.push(draftPage);
  currentPageIndex = pageIndex;
  renderApp();
  beginStreamFollow();

  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;

  // 失败或中断时把这次的草稿页和输入撤干净，不往书里留垃圾页。
  const rollbackDraft = (): void => {
    if (book.pages[book.pages.length - 1] === draftPage) book.pages.pop();
    if (book.history[book.history.length - 1] === historyEntry) book.history.pop();
    currentPageIndex = Math.min(currentPageIndex, Math.max(0, book.pages.length - 1));
  };

  let fullText = "";
  try {
    fullText = await callModel(
      cfg,
      [{ role: "system", content: systemPrompt(cfg) }, ...book.history],
      (acc) => {
        if (activeBook !== book || controller.signal.aborted) return;
        draftPage.narrative = narrativeOnly(acc);
        updateStreamingStory(pageIndex, draftPage);
      },
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.aborted || (error as Error).name === "AbortError") {
      rollbackDraft();
      return;
    }
    rollbackDraft();
    pendingRetry = { bookId: book.id, message: userMsg, error: (error as Error).message || "接口未响应" };
    busy = false;
    if (activeBook === book) renderApp();
    return;
  } finally {
    if (activeController === controller) activeController = null;
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
  if (activeBook === book) renderApp();
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

// 按页索引精确定位落墨页：流式期间即使玩家翻回旧页，墨也只写进草稿页。
function updateStreamingStory(pageIndex: number, page: BookPage): void {
  const pageEl = app.querySelector<HTMLElement>(`.book-page[data-idx="${pageIndex}"]`);
  if (!pageEl) return;
  const story = pageEl.querySelector<HTMLElement>(".story");
  const title = pageEl.querySelector<HTMLElement>(".era .ttl");
  if (title && title.textContent !== page.era_label) title.textContent = page.era_label;
  if (!story) return;
  if (!story.classList.contains("streaming-text")) {
    story.classList.add("streaming-text");
    story.classList.remove("settled-text", "ink-anim");
    story.textContent = "";
  }
  reconcileStreamingStory(story, page.narrative);
  if (pageEl.classList.contains("active")) followStream();
}

// 流式渲染只追加新墨，不重建整段 DOM：长文不再随字数增长而卡顿、闪烁。
function reconcileStreamingStory(story: HTMLElement, narrative: string): void {
  const paras = storyParagraphs(narrative);
  const cursor = ensureInkCursor(story);
  const nodes = Array.from(story.children).filter((el): el is HTMLParagraphElement => el.tagName === "P");
  for (let i = 0; i < paras.length; i++) {
    let p = nodes[i];
    if (!p) {
      p = document.createElement("p");
      if (i === 0) p.classList.add("p-lead");
      story.appendChild(p);
      nodes.push(p);
    }
    const wanted = paras[i];
    const current = p.textContent || "";
    if (current === wanted) continue;
    if (wanted.startsWith(current)) {
      appendStreamChunk(p, wanted.slice(current.length), i === 0 && current.length === 0);
    } else {
      setStreamParagraph(p, wanted, i === 0);
    }
  }
  // 段落数回缩时（如半截 <STATE 被识别后从正文剔除）清掉多余的尾段。
  for (let i = nodes.length - 1; i >= Math.max(paras.length, 1); i--) {
    nodes[i].remove();
    nodes.pop();
  }
  const lastP = nodes[Math.min(paras.length, nodes.length) - 1];
  if (lastP && cursor.parentElement !== lastP) lastP.appendChild(cursor);
}

function appendStreamChunk(p: HTMLParagraphElement, text: string, leadStart: boolean): void {
  if (!text) return;
  const frag = document.createDocumentFragment();
  let rest = text;
  if (leadStart) {
    const [first] = Array.from(rest);
    if (first) {
      const drop = document.createElement("span");
      drop.className = "dropcap";
      drop.textContent = first;
      frag.appendChild(drop);
      rest = rest.slice(first.length);
    }
  }
  if (rest) {
    const chunk = document.createElement("span");
    chunk.className = "ink-fresh";
    chunk.textContent = rest;
    frag.appendChild(chunk);
  }
  p.insertBefore(frag, p.querySelector(".ink-cursor"));
}

function setStreamParagraph(p: HTMLParagraphElement, text: string, lead: boolean): void {
  const cursor = p.querySelector<HTMLElement>(".ink-cursor");
  p.textContent = "";
  appendStreamChunk(p, text, lead);
  if (cursor) p.appendChild(cursor);
}

function ensureInkCursor(story: HTMLElement): HTMLElement {
  let cursor = story.querySelector<HTMLElement>(".ink-cursor");
  if (!cursor) {
    cursor = document.createElement("span");
    cursor.className = "ink-cursor";
    story.appendChild(cursor);
  }
  return cursor;
}

function readerScroller(): HTMLElement | null {
  return app.querySelector<HTMLElement>("#view-sandbox-reader");
}

function beginStreamFollow(): void {
  streamFollow = true;
  readerScroller()?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

// 贴底自动跟随：光标滑出视野就把它带回来；玩家上滚即暂停，滚回底部自动恢复。
function attachStreamFollowGuards(scroller: HTMLElement): void {
  scroller.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaY < 0) streamFollow = false;
    },
    { passive: true },
  );
  scroller.addEventListener(
    "touchstart",
    (event) => {
      lastTouchY = event.touches[0]?.clientY ?? 0;
    },
    { passive: true },
  );
  scroller.addEventListener(
    "touchmove",
    (event) => {
      const y = event.touches[0]?.clientY ?? 0;
      if (y > lastTouchY + 4) streamFollow = false;
      lastTouchY = y;
    },
    { passive: true },
  );
  scroller.addEventListener(
    "scroll",
    () => {
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48) streamFollow = true;
    },
    { passive: true },
  );
}

function followStream(): void {
  if (!streamFollow || followScrollFrame) return;
  followScrollFrame = requestAnimationFrame(() => {
    followScrollFrame = 0;
    if (!streamFollow) return;
    const cursor = document.querySelector<HTMLElement>(".book-page.active .ink-cursor");
    cursor?.scrollIntoView({ block: "nearest", behavior: "auto" });
  });
}

function flipTo(index: number): void {
  const total = activeBook?.pages.length || 0;
  if (index < 0 || index >= total || index === currentPageIndex) return;
  const slider = app.querySelector<HTMLElement>("#book-slider");
  const outgoing = slider?.querySelector<HTMLElement>(".book-page.active");
  if (slider && outgoing && !prefersReducedMotion()) {
    // 旧页保持展开随滑动移出，等 transitionend 再折叠，翻页过程不再露出空白。
    slider.querySelectorAll(".book-page.leaving").forEach((el) => el.classList.remove("leaving"));
    outgoing.classList.add("leaving");
    let collapsed = false;
    const collapse = (): void => {
      if (collapsed) return;
      collapsed = true;
      outgoing.classList.remove("leaving");
    };
    slider.addEventListener("transitionend", collapse, { once: true });
    window.setTimeout(collapse, 620);
  }
  currentPageIndex = index;
  renderApp();
  readerScroller()?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
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

function narrativeOnly(text: string): string {
  const open = text.indexOf("<STATE");
  let cut = open >= 0 ? text.slice(0, open) : text;
  // 流式末尾可能恰好停在 "<STA" 这类半截标签上，先藏起来等后续字符。
  const tail = cut.lastIndexOf("<");
  if (tail >= 0 && cut.length - tail < 6 && "<STATE".startsWith(cut.slice(tail))) {
    cut = cut.slice(0, tail);
  }
  return cut.trim();
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

// 正文按空行切成段落：首段带朱色首字，不缩进；后续段落统一 2em 缩进（见 .story p 样式）。
function storyParagraphs(narrative: string): string[] {
  return String(narrative || "")
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function storyHTML(narrative: string): string {
  return storyParagraphs(narrative)
    .map((par, index) => {
      if (index > 0) return `<p>${esc(par)}</p>`;
      const [first] = Array.from(par);
      return `<p class="p-lead"><span class="dropcap">${esc(first)}</span>${esc(par.slice(first.length))}</p>`;
    })
    .join("");
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
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ts);
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
