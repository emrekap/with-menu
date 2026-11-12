// Shows the menu PDF as one continuous web page: every page full width, stacked
// with no gaps, no toolbar and no page numbers. The TR / EN switch at the top
// of the screen changes between the Turkish and the English menu.

// One PDF per language. To add a language, add a line here and a button with
// the same data-lang in index.html.
const MENUS = {
  tr: {
    file: "menu-tr.pdf",
    title: "with — Menü",
    label: "Menü",
    failed: "Menü burada gösterilemedi.",
    open: "Menüyü aç",
  },
  en: {
    file: "menu-en.pdf",
    title: "with — Menu",
    label: "Menu",
    failed: "The menu could not be shown here.",
    open: "Open the menu",
  },
};
const DEFAULT_LANGUAGE = "tr";
const STORAGE_KEY = "menu-language";
const PDFJS_DIR = "vendor/pdfjs/";

// Browsers (iOS Safari especially) refuse to draw canvases larger than this.
const MAX_CANVAS_PIXELS = 16_777_216;

// Empty space at the sides of the PDF is trimmed off, so the menu itself fills
// the screen. This much is kept as a border on each side, as a share of the
// menu's own width (0.04 = 4%).
const SIDE_PADDING = 0.04;

// When a guest zooms in, the part on screen is drawn again, sharp. This much
// extra around the screen is drawn too (0.25 = a quarter of a screen on every
// side), so moving a little does not need a new drawing.
const DETAIL_MARGIN = 0.25;

const menu = document.getElementById("menu");
const switcher = document.querySelector(".lang");
const absolute = (path) => new URL(path, document.baseURI).href;

const pdfjsReady = import(absolute(`${PDFJS_DIR}pdf.min.mjs`)).then((pdfjs) => {
  pdfjs.GlobalWorkerOptions.workerSrc = absolute(`${PDFJS_DIR}pdf.worker.min.mjs`);
  return pdfjs;
});

const views = {}; // language → its opened menu, kept so switching back is quick
let wanted = null; // the language asked for most recently
let target = null; // the menu that should be on screen
let shown = null; // the menu that is on screen (the old one until a switch is done)
let renderPass = 0;
let currentTask = null;
let sharpenPass = 0;
let sharpenTask = null;
let sharpenTimer;

// Turkish, unless the guest picked another language on an earlier visit or the
// link asks for one (…/?lang=en).
function startLanguage() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be blocked (private mode); the default still works.
  }
  const fromLink = new URLSearchParams(location.search).get("lang")?.toLowerCase();
  return [fromLink, saved].find((lang) => Object.hasOwn(MENUS, lang ?? "")) ?? DEFAULT_LANGUAGE;
}

function remember(lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // See startLanguage.
  }
  // A ?lang= in the address wins over the saved choice, so keep it in step.
  const url = new URL(location.href);
  if (url.searchParams.has("lang")) {
    url.searchParams.set("lang", lang);
    history.replaceState(null, "", url);
  }
}

// Puts the menu for a language on screen. A newer call takes over from an
// older one that is still loading.
async function show(lang) {
  wanted = lang;
  for (const button of switcher.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
  }
  document.body.classList.remove("is-loaded"); // spinner on, current menu dimmed

  try {
    const view = await loadView(lang);
    if (wanted !== lang) return;
    target = view;
    await present(view);

    if (!view.hasExtras) {
      view.hasExtras = true;
      for (const entry of view.pages) {
        addLinks(entry).catch(console.error);
        addHiddenText(entry).catch(console.error);
      }
    }
  } catch (err) {
    console.error(err);
    if (wanted === lang) showFallback(lang);
  }
}

// Downloads and opens the PDF for a language, once.
function loadView(lang) {
  views[lang] ??= openMenu(lang).catch((err) => {
    delete views[lang]; // so the next try starts over
    throw err;
  });
  return views[lang];
}

async function openMenu(lang) {
  const { file } = MENUS[lang];

  // Download the PDF and the PDF renderer at the same time.
  const [pdfjs, data] = await Promise.all([
    pdfjsReady,
    fetch(file).then((res) => {
      if (!res.ok) throw new Error(`Could not load ${file} (HTTP ${res.status})`);
      return res.arrayBuffer();
    }),
  ]);

  const pdf = await pdfjs.getDocument({
    data,
    wasmUrl: absolute(`${PDFJS_DIR}wasm/`),
    iccUrl: absolute(`${PDFJS_DIR}iccs/`),
    standardFontDataUrl: absolute(`${PDFJS_DIR}standard_fonts/`),
  }).promise;

  const pages = [];
  let emptySide = 0.5;
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const size = page.getViewport({ scale: 1 });
    const el = document.createElement("section");
    el.className = "page";
    pages.push({ page, size, el, crop: null, canvas: null, renderedFor: "", detail: null });
    emptySide = Math.min(emptySide, await measureEmptySide(page, size));
  }

  // Trim the empty sides. The same amount left and right and on every page,
  // so the menu stays centered and the pages line up.
  const menuWidth = 1 - 2 * emptySide;
  const trim = menuWidth > 0 ? Math.max(0, emptySide - menuWidth * SIDE_PADDING) : 0;
  const crop = { left: trim, width: 1 - 2 * trim }; // shares of the page width
  for (const entry of pages) {
    entry.crop = crop;
    // A box with the right shape for every page, so nothing jumps while rendering.
    entry.el.style.aspectRatio = `${entry.size.width * crop.width} / ${entry.size.height}`;
  }
  return { lang, pages, hasExtras: false };
}

// How much of a page's sides is empty: the share of its width, counted in from
// both edges, where nothing is drawn. Measured on a small drawing of the page.
async function measureEmptySide(page, size) {
  const viewport = page.getViewport({ scale: 400 / size.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;

  const { width, height } = canvas;
  const { data } = canvas.getContext("2d").getImageData(0, 0, width, height);
  // Empty = about the same color as the top left corner.
  const isEmpty = (x, y) => {
    const i = (y * width + x) * 4;
    return (
      Math.abs(data[i] - data[0]) +
        Math.abs(data[i + 1] - data[1]) +
        Math.abs(data[i + 2] - data[2]) <
      30
    );
  };
  let empty = Math.floor(width / 2);
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < empty && isEmpty(x, y) && isEmpty(width - 1 - x, y)) x++;
    empty = x;
  }
  canvas.width = canvas.height = 0; // free memory on iOS
  return empty / width;
}

// Draws a menu at the current screen width and puts it on screen. Calling it
// again (resize, language switch) cancels the previous run.
async function present(view) {
  const pass = ++renderPass;
  currentTask?.cancel();

  // First visit: reserve the space right away and let the pages fade in as they
  // are drawn. Language switch: the old menu stays up until the new one is drawn.
  if (!shown) mount(view);

  const cssWidth = menu.clientWidth;
  for (const entry of view.pages) {
    try {
      await renderPage(entry, cssWidth);
    } catch (err) {
      if (err?.name === "RenderingCancelledException") return;
      throw err;
    }
    if (pass !== renderPass) return;
    if (shown === view && entry === view.pages[0]) reveal(view);
  }

  if (shown !== view) {
    mount(view);
    reveal(view);
  }
  scheduleSharpen(); // in case the guest is zoomed in
}

async function renderPage(entry, cssWidth) {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
  const key = `${cssWidth}@${pixelRatio}`;
  if (entry.renderedFor === key) return;

  // Only the part between the trimmed sides is drawn.
  const { size, crop } = entry;
  const keptWidth = size.width * crop.width;
  let scale = (cssWidth / keptWidth) * pixelRatio;
  const pixels = keptWidth * size.height * scale * scale;
  if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

  const viewport = entry.page.getViewport({ scale, offsetX: -size.width * crop.left * scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(keptWidth * scale);
  canvas.height = Math.floor(viewport.height);
  canvas.setAttribute("aria-hidden", "true");

  // Draw off-screen first, then swap, so resizing never flashes blank.
  const task = entry.page.render({ canvas, viewport });
  currentTask = task;
  await task.promise;
  if (currentTask === task) currentTask = null;

  if (entry.canvas) {
    entry.canvas.replaceWith(canvas);
    entry.canvas.width = entry.canvas.height = 0; // free memory on iOS
  } else {
    entry.el.prepend(canvas);
  }
  entry.canvas = canvas;
  entry.renderedFor = key;
  entry.el.classList.add("is-ready");
}

// Swaps a menu into the page.
function mount(view) {
  const previous = shown;
  const scroller = document.scrollingElement;
  const progress = scroller.scrollTop / scroller.scrollHeight;

  menu.replaceChildren(...view.pages.map((entry) => entry.el));
  shown = view;
  setPageLanguage(view.lang);

  if (previous) {
    // Stay at the same place in the menu after a language switch.
    scroller.scrollTop = progress * scroller.scrollHeight;
    release(previous);
  }
}

// Called once the first page of a menu is on screen and drawn.
function reveal(view) {
  if (document.body.classList.contains("is-loaded")) return;
  matchBackground(view.pages[0].canvas);
  document.body.classList.add("is-loaded");
}

// Drops the drawings of a menu that left the screen. The opened PDF is kept,
// so it can be drawn again quickly.
function release(view) {
  for (const entry of view.pages) {
    dropDetail(entry);
    if (!entry.canvas) continue;
    entry.canvas.remove();
    entry.canvas.width = entry.canvas.height = 0; // free memory on iOS
    entry.canvas = null;
    entry.renderedFor = "";
    entry.el.classList.remove("is-ready");
  }
}

// Zoomed in, the picture of a page is only stretched, which makes the text
// blurry. So shortly after the guest stops zooming or moving, the part that is
// on screen is drawn again at the zoomed size and laid on top of the page.
function scheduleSharpen() {
  clearTimeout(sharpenTimer);
  sharpenTimer = setTimeout(() => sharpen().catch(console.error), 150);
}

async function sharpen() {
  const pass = ++sharpenPass;
  sharpenTask?.cancel();
  const view = shown;
  const screen = window.visualViewport;
  if (!view || !screen) return;

  if (screen.scale < 1.05) {
    view.pages.forEach(dropDetail); // not zoomed in: the page itself is sharp
    return;
  }

  for (const entry of view.pages) {
    if (!entry.canvas) continue; // the page itself is not drawn yet
    const box = entry.el.getBoundingClientRect();
    const seen = visiblePart(box, screen, 0);
    if (seen.right <= seen.left || seen.bottom <= seen.top) {
      dropDetail(entry); // page is off screen
      continue;
    }
    const part = visiblePart(box, screen, DETAIL_MARGIN);

    // Canvas pixels per CSS pixel at this zoom.
    let ratio = Math.min(window.devicePixelRatio || 1, 3) * screen.scale;
    const pixels = (part.right - part.left) * (part.bottom - part.top) * ratio * ratio;
    if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

    // Size the whole page box would have at this zoom. Only `part` of it is drawn.
    const fullWidth = box.width * ratio;
    const fullHeight = box.height * ratio;
    const scale = fullWidth / (entry.size.width * entry.crop.width);
    const trimmed = entry.size.width * entry.crop.left * scale; // cut off at the left

    // Nothing to do if the last sharp drawing still covers the screen.
    const old = entry.detail;
    if (
      old &&
      Math.abs(old.scale / scale - 1) < 0.05 &&
      old.left <= seen.left / box.width + 0.0005 &&
      old.top <= seen.top / box.height + 0.0005 &&
      old.right >= seen.right / box.width - 0.0005 &&
      old.bottom >= seen.bottom / box.height - 0.0005
    ) {
      continue;
    }

    // Whole canvas pixels, so the sharp drawing lines up exactly with the page.
    const x = Math.floor(part.left * ratio);
    const y = Math.floor(part.top * ratio);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(part.right * ratio) - x;
    canvas.height = Math.ceil(part.bottom * ratio) - y;
    canvas.className = "detail";
    canvas.setAttribute("aria-hidden", "true");
    // Percentages keep it in place if the page changes size.
    Object.assign(canvas.style, {
      left: `${(x / fullWidth) * 100}%`,
      top: `${(y / fullHeight) * 100}%`,
      width: `${(canvas.width / fullWidth) * 100}%`,
      height: `${(canvas.height / fullHeight) * 100}%`,
    });

    const task = entry.page.render({
      canvas,
      viewport: entry.page.getViewport({ scale, offsetX: -x - trimmed, offsetY: -y }),
    });
    sharpenTask = task;
    try {
      await task.promise;
    } catch (err) {
      canvas.width = canvas.height = 0; // free memory on iOS
      if (err?.name === "RenderingCancelledException") return;
      throw err;
    }
    if (sharpenTask === task) sharpenTask = null;
    if (pass !== sharpenPass || shown !== view) {
      canvas.width = canvas.height = 0;
      return;
    }

    dropDetail(entry);
    entry.el.append(canvas);
    entry.detail = {
      canvas,
      scale,
      left: x / fullWidth,
      top: y / fullHeight,
      right: (x + canvas.width) / fullWidth,
      bottom: (y + canvas.height) / fullHeight,
    };
  }
}

// The part of a page that is on screen (plus `margin` screens around it), in
// CSS pixels measured from the page's top left corner.
function visiblePart(box, screen, margin) {
  const marginX = screen.width * margin;
  const marginY = screen.height * margin;
  return {
    left: Math.max(0, screen.offsetLeft - box.left - marginX),
    top: Math.max(0, screen.offsetTop - box.top - marginY),
    right: Math.min(box.width, screen.offsetLeft + screen.width - box.left + marginX),
    bottom: Math.min(box.height, screen.offsetTop + screen.height - box.top + marginY),
  };
}

function dropDetail(entry) {
  if (!entry.detail) return;
  entry.detail.canvas.remove();
  entry.detail.canvas.width = entry.detail.canvas.height = 0; // free memory on iOS
  entry.detail = null;
}

function setPageLanguage(lang) {
  document.documentElement.lang = lang;
  document.title = MENUS[lang].title;
  menu.setAttribute("aria-label", MENUS[lang].label);
}

function showFallback(lang) {
  const { file, failed, open } = MENUS[lang];
  renderPass++;
  currentTask?.cancel();
  if (shown) release(shown);
  shown = target = wanted = null; // tapping the language again retries

  const link = document.createElement("a");
  link.href = file;
  link.textContent = open;
  const note = document.createElement("p");
  note.className = "fallback";
  note.append(`${failed} `, link);
  menu.replaceChildren(note);
  setPageLanguage(lang);
  document.body.classList.add("is-loaded");
}

// Uses the color at the top corners of the first page as the site background,
// so the space around the menu (and the phone's browser bar) matches it.
function matchBackground(canvas) {
  const ctx = canvas.getContext("2d");
  const left = ctx.getImageData(2, 2, 1, 1).data;
  const right = ctx.getImageData(canvas.width - 3, 2, 1, 1).data;
  const diff =
    Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2]);
  if (diff > 30) return; // corners differ, keep the default from index.html

  const color = `rgb(${left[0]}, ${left[1]}, ${left[2]})`;
  const root = document.documentElement.style;
  root.setProperty("--bg", color);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);

  // Keep the language switch readable on a dark menu.
  const isDark = left[0] * 0.299 + left[1] * 0.587 + left[2] * 0.114 < 128;
  if (isDark) root.setProperty("--ink", "#ffffff");
  else root.removeProperty("--ink");
}

// Keeps links from the PDF (website, Instagram, phone number...) clickable.
async function addLinks({ page, size, crop, el }) {
  const annotations = await page.getAnnotations();
  for (const a of annotations) {
    if (a.subtype !== "Link" || !a.url) continue;

    const [x1, y1] = size.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [x2, y2] = size.convertToViewportPoint(a.rect[2], a.rect[3]);
    const link = document.createElement("a");
    link.href = a.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.setAttribute("aria-label", a.url);
    // Percentages keep the link in place at any screen size. Left and width
    // are counted inside the part of the page that is left after trimming.
    Object.assign(link.style, {
      left: `${((Math.min(x1, x2) / size.width - crop.left) / crop.width) * 100}%`,
      top: `${(Math.min(y1, y2) / size.height) * 100}%`,
      width: `${(Math.abs(x2 - x1) / size.width / crop.width) * 100}%`,
      height: `${(Math.abs(y2 - y1) / size.height) * 100}%`,
    });
    el.append(link);
  }
}

// Invisible copy of the menu text for screen readers and search engines.
async function addHiddenText({ page, el }) {
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("");
  if (!text.trim()) return;

  const hidden = document.createElement("div");
  hidden.className = "sr-only";
  hidden.textContent = text;
  el.append(hidden);
}

switcher.addEventListener("click", (event) => {
  const lang = event.target.closest("button")?.dataset.lang;
  if (!lang || lang === wanted) return;
  remember(lang);
  show(lang);
});

// Redraw sharply when the width changes (phone rotated, window resized).
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (target) present(target).catch(console.error);
  }, 150);
});

// Zooming, or moving around while zoomed in: sharpen what is on screen.
window.visualViewport?.addEventListener("resize", scheduleSharpen);
window.visualViewport?.addEventListener("scroll", scheduleSharpen);
window.addEventListener("scroll", scheduleSharpen, { passive: true });

show(startLanguage());
