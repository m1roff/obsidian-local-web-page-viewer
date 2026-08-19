import { App, FileSystemAdapter, FileView, Menu, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_LOCAL_PAGE = "local-web-page-view";

const RESOURCE_ATTRS = ["src", "href", "poster"];
const EXTERNAL_URL_RE = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const PAGE_EXTS = new Set(["html", "htm"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "ogg", "wav", "m4a", "flac", "opus"]);

function isExternal(url: string): boolean {
  return url === "" || EXTERNAL_URL_RE.test(url);
}

function extensionOf(vaultPath: string): string {
  const idx = vaultPath.lastIndexOf(".");
  return idx === -1 ? "" : vaultPath.slice(idx + 1).toLowerCase();
}

// Resolves a relative reference against a vault-relative directory, collapsing "../" segments -
// same job path.resolve() would do, but Obsidian's adapter API wants forward-slash vault paths,
// not filesystem paths, so this stays hand-rolled instead of pulling in "path".
function resolveVaultPath(baseDir: string, relative: string): string {
  const stack = baseDir === "" ? [] : baseDir.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  return stack.join("/");
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

// Builds a path of the form "div:nth-of-type(2) > p:nth-of-type(3)" from the root down to an
// element - not pretty, but stable enough to re-find the same node later without needing the
// page to have ids/classes of its own (most exports don't).
function buildSelector(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.tagName && node.tagName.toLowerCase() !== "html") {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    const index = sameTagSiblings.indexOf(node) + 1;
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
    node = parent;
  }
  return parts.join(" > ");
}

const ZOOM_STEP = 10;
const ZOOM_MIN = 25;
const ZOOM_MAX = 300;
const DEFAULT_ZOOM = 100;

export interface Bookmark {
  name: string;
  selector: string;
}

// Every toolbar action the view can show - which ones get their own icon in the tab header
// versus which get tucked into the "Page tools" menu (and in what order) is user-configurable
// from the settings tab, not hardcoded per platform.
export type ActionId =
  | "reload"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "fitToWidth"
  | "addBookmark"
  | "bookmarks"
  | "openExternally";

export const ACTION_IDS: ActionId[] = [
  "reload",
  "zoomIn",
  "zoomOut",
  "resetZoom",
  "fitToWidth",
  "addBookmark",
  "bookmarks",
  "openExternally",
];

export const ACTION_META: Record<ActionId, { icon: string; label: string; desktopOnly?: boolean }> = {
  reload: { icon: "rotate-cw", label: "Reload" },
  zoomIn: { icon: "zoom-in", label: "Zoom in" },
  zoomOut: { icon: "zoom-out", label: "Zoom out" },
  resetZoom: { icon: "rotate-ccw", label: "Reset zoom" },
  fitToWidth: { icon: "smartphone", label: "Fit to width" },
  addBookmark: { icon: "bookmark-plus", label: "Add bookmark" },
  bookmarks: { icon: "bookmark", label: "Bookmarks" },
  openExternally: { icon: "external-link", label: "Open in system browser", desktopOnly: true },
};

export interface ActionSetting {
  id: ActionId;
  pinned: boolean;
}

// Narrow interface instead of importing the Plugin class directly, so main.ts (which imports
// this file) and view.ts don't form a circular value-level dependency.
export interface ViewStore {
  getZoom(path: string): number | undefined;
  setZoom(path: string, zoom: number): void;
  getScroll(path: string): number | undefined;
  setScroll(path: string, fraction: number): void;
  getBookmarks(path: string): Bookmark[];
  addBookmark(path: string, bookmark: Bookmark): void;
  removeBookmark(path: string, index: number): void;
  getActionSettings(): ActionSetting[];
}

const SCROLL_SAVE_DEBOUNCE_MS = 300;

export class LocalPageView extends FileView {
  private frameHost!: HTMLElement;
  private iframe: HTMLIFrameElement | null = null;
  private zoomPercent = DEFAULT_ZOOM;
  private pickingBookmark = false;
  private scrollSaveTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private store: ViewStore
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_LOCAL_PAGE;
  }

  getIcon(): string {
    return "globe";
  }

  canAcceptExtension(extension: string): boolean {
    return ["html", "htm"].includes(extension.toLowerCase());
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("lpv-container");
    this.frameHost = this.contentEl.createDiv({ cls: "lpv-frame-host" });
    this.buildActionBar();
  }

  // Which actions get their own icon versus land in the "Page tools" menu, and in what order,
  // comes entirely from settings - see LocalPageViewerSettingTab. openExternally is dropped
  // outright on mobile (Platform.isDesktopApp electron API, not just hidden-but-reachable).
  private buildActionBar(): void {
    const isDesktop = this.app.vault.adapter instanceof FileSystemAdapter;
    const settings = this.store
      .getActionSettings()
      .filter((a) => !ACTION_META[a.id].desktopOnly || isDesktop);

    for (const action of settings) {
      if (!action.pinned) continue;
      const meta = ACTION_META[action.id];
      this.addAction(meta.icon, meta.label, (evt) => this.runAction(action.id, evt));
    }

    const tucked = settings.filter((a) => !a.pinned);
    if (tucked.length > 0) {
      this.addAction("menu", "Page tools", (evt) => this.showToolsMenu(evt, tucked));
    }
  }

  private runAction(id: ActionId, evt: MouseEvent): void {
    switch (id) {
      case "reload":
        void this.reload();
        break;
      case "zoomIn":
        this.zoomBy(ZOOM_STEP);
        break;
      case "zoomOut":
        this.zoomBy(-ZOOM_STEP);
        break;
      case "resetZoom":
        this.resetZoom();
        break;
      case "fitToWidth":
        this.fitToWidth();
        break;
      case "addBookmark":
        this.armBookmarkPicker();
        break;
      case "bookmarks":
        this.showBookmarksMenu(evt);
        break;
      case "openExternally":
        this.openExternally();
        break;
    }
  }

  private showToolsMenu(evt: MouseEvent, tucked: ActionSetting[]): void {
    const menu = new Menu();
    for (const action of tucked) {
      const meta = ACTION_META[action.id];
      menu.addItem((item) =>
        item
          .setTitle(meta.label)
          .setIcon(meta.icon)
          .onClick((menuEvt) =>
            // onClick can also hand back a KeyboardEvent, which has no coordinates - fall back
            // to this menu's own triggering event for anything that needs to position itself.
            this.runAction(action.id, menuEvt instanceof MouseEvent ? menuEvt : evt)
          )
      );
    }
    menu.showAtMouseEvent(evt);
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.zoomPercent = this.store.getZoom(file.path) ?? DEFAULT_ZOOM;
    this.pickingBookmark = false;
    await this.renderFile(file);
  }

  async onUnloadFile(): Promise<void> {
    this.persistScroll();
    this.cancelScheduledScrollSave();
    this.frameHost.empty();
    this.iframe = null;
    this.pickingBookmark = false;
  }

  private async renderFile(file: TFile): Promise<void> {
    this.cancelScheduledScrollSave();
    this.frameHost.empty();
    this.iframe = null;
    this.pickingBookmark = false;

    let srcdoc: string;
    try {
      srcdoc = await this.buildSrcdoc(file);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.frameHost.createEl("pre", { text: `Failed to render ${file.path}:\n${message}` });
      return;
    }

    const el = this.frameHost.createEl("iframe", { cls: "lpv-iframe" });
    el.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
    el.addEventListener("load", () => {
      this.applyZoom();
      this.wireInteractions();
      this.restoreScroll();
    });
    el.srcdoc = srcdoc;
    this.iframe = el;
  }

  // Restores the last scroll position on this device for this file - a fraction of scrollable
  // height rather than a raw pixel offset, so it stays sensible across zoom levels and screens.
  private restoreScroll(): void {
    const root = this.iframe?.contentDocument?.documentElement;
    if (!root || !this.file) return;
    const fraction = this.store.getScroll(this.file.path);
    if (fraction === undefined) return;
    const max = root.scrollHeight - root.clientHeight;
    if (max > 0) root.scrollTop = Math.max(0, Math.min(max, max * fraction));
  }

  private scheduleScrollSave(): void {
    this.cancelScheduledScrollSave();
    this.scrollSaveTimer = window.setTimeout(() => this.persistScroll(), SCROLL_SAVE_DEBOUNCE_MS);
  }

  private cancelScheduledScrollSave(): void {
    if (this.scrollSaveTimer !== null) {
      window.clearTimeout(this.scrollSaveTimer);
      this.scrollSaveTimer = null;
    }
  }

  private persistScroll(): void {
    const root = this.iframe?.contentDocument?.documentElement;
    if (!root || !this.file) return;
    const max = root.scrollHeight - root.clientHeight;
    this.store.setScroll(this.file.path, max > 0 ? root.scrollTop / max : 0);
  }

  // Zooms the loaded page's own document, not Obsidian's UI (Cmd +/- would zoom the whole app).
  // Works on any page regardless of whether it has its own responsive/mobile layout, since it
  // scales the already-rendered document rather than relying on the page cooperating.
  private zoomBy(deltaPercent: number): void {
    this.zoomPercent = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoomPercent + deltaPercent));
    this.applyZoom({ clipHorizontal: false });
    this.persistZoom();
  }

  // Shrinks (or grows) the page so its natural content width matches the visible pane, and
  // clips any leftover sub-pixel overhang so there's no horizontal scrollbar at all - the
  // generic substitute for a page that has no mobile/responsive layout of its own.
  private fitToWidth(): void {
    const doc = this.iframe?.contentDocument;
    const root = doc?.documentElement;
    if (!root) return;

    const availableWidth = this.frameHost.clientWidth;

    // scrollWidth alone only reports overflow past the current viewport - it says nothing
    // about a centered column narrower than the pane (e.g. a `max-width` + `margin: auto`
    // content block), which has no overflow to report even though it should be zoomed IN to
    // fill the pane. Temporarily letting the root shrink-wrap to its content's real size
    // (`width: max-content`) exposes the true natural width in both directions.
    const prevZoom = root.style.zoom;
    const prevWidth = root.style.width;
    root.setCssStyles({ zoom: "100%", width: "max-content" });
    const naturalWidth = root.scrollWidth;
    root.setCssStyles({ width: prevWidth, zoom: prevZoom });

    if (naturalWidth > 0 && availableWidth > 0) {
      // Floor (not round) and shave off a fraction more - rounding up, or landing exactly on
      // the edge, is what leaves a stray horizontal scrollbar from sub-pixel layout rounding.
      this.zoomPercent = Math.min(
        ZOOM_MAX,
        Math.max(ZOOM_MIN, Math.floor((availableWidth / naturalWidth) * 100 - 0.5))
      );
    }
    this.applyZoom({ clipHorizontal: true });
    this.persistZoom();
  }

  private resetZoom(): void {
    this.zoomPercent = DEFAULT_ZOOM;
    this.applyZoom({ clipHorizontal: false });
    this.persistZoom();
  }

  private applyZoom(opts: { clipHorizontal: boolean } = { clipHorizontal: false }): void {
    const root = this.iframe?.contentDocument?.documentElement;
    if (!root) return;
    // Only clip after an explicit fit - a manual zoom-in should stay horizontally scrollable
    // so wide content can still be reached, not get silently cut off at the pane edge.
    root.setCssStyles({
      zoom: `${this.zoomPercent}%`,
      overflowX: opts.clipHorizontal ? "hidden" : "",
    });
  }

  private persistZoom(): void {
    if (this.file) this.store.setZoom(this.file.path, this.zoomPercent);
  }

  // Two concerns share one click listener on the loaded document (same-origin, thanks to
  // srcdoc inheriting our origin - see buildSrcdoc's comment): placing a bookmark while armed,
  // and redirecting clicks on local media/file links that would otherwise navigate the iframe
  // away from the rendered page with no way back.
  private wireInteractions(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    doc.addEventListener(
      "click",
      (event) => {
        if (this.pickingBookmark) {
          event.preventDefault();
          event.stopPropagation();
          this.pickingBookmark = false;
          doc.documentElement.classList.remove("lpv-picking-cursor");
          this.promptBookmarkName(event.target as Element);
          return;
        }
        const anchor = (event.target as Element).closest?.("a[data-lpv-open]");
        if (!anchor) return;
        event.preventDefault();
        event.stopPropagation();
        const vaultPath = anchor.getAttribute("data-lpv-open");
        if (vaultPath) this.openLocalFile(vaultPath);
      },
      { capture: true }
    );
    doc.defaultView?.addEventListener("scroll", () => this.scheduleScrollSave(), {
      passive: true,
    });
  }

  private armBookmarkPicker(): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    this.pickingBookmark = true;
    doc.documentElement.classList.add("lpv-picking-cursor");
    new Notice("Click anywhere on the page to place a bookmark there");
  }

  private promptBookmarkName(target: Element): void {
    const file = this.file;
    if (!file) return;
    const selector = buildSelector(target);
    new BookmarkNameModal(this.app, (name) => {
      this.store.addBookmark(file.path, { name, selector });
    }).open();
  }

  private showBookmarksMenu(evt: MouseEvent): void {
    if (!this.file) return;
    const file = this.file;
    const bookmarks = this.store.getBookmarks(file.path);
    const menu = new Menu();
    if (bookmarks.length === 0) {
      menu.addItem((item) => item.setTitle("No bookmarks yet").setDisabled(true));
    } else {
      for (const bookmark of bookmarks) {
        menu.addItem((item) =>
          item
            .setTitle(bookmark.name)
            .setIcon("bookmark")
            .onClick(() => this.jumpToBookmark(bookmark))
        );
      }
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Manage bookmarks…")
        .setIcon("settings")
        .onClick(() => new ManageBookmarksModal(this.app, file.path, this.store).open())
    );
    menu.showAtMouseEvent(evt);
  }

  private jumpToBookmark(bookmark: Bookmark): void {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;
    let target: Element | null = null;
    try {
      target = doc.querySelector(bookmark.selector);
    } catch {
      target = null;
    }
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    else new Notice(`Couldn't find "${bookmark.name}" - the page may have changed.`);
  }

  // A link to another local file navigates the iframe away from the rendered page entirely,
  // with no address bar or back button to recover - so local media/file links are redirected
  // here instead of being left to navigate. Links to other .html/.htm pages are left alone.
  private openLocalFile(vaultPath: string): void {
    const ext = extensionOf(vaultPath);
    if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)) {
      new MediaModal(this.app, vaultPath, ext).open();
      return;
    }
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      void openInSystemApp(this.app.vault.adapter, vaultPath);
      return;
    }
    new Notice("This file type can't be previewed here.");
  }

  // Rewrites every relative resource reference (link/script/img/source/... and CSS url())
  // to an absolute vault resource path, and inlines <link rel="stylesheet"> as <style> text.
  //
  // Why: Obsidian's main process only allows app:// resource requests whose initiating frame
  // origin matches Obsidian's own trusted origin - a plain `iframe.src = "app://..."` navigation
  // gets its own distinct origin and every subresource it then requests gets silently cancelled
  // (net::ERR_BLOCKED_BY_CLIENT). A `srcdoc` document, by spec, inherits its origin from the
  // parent instead, so requests it makes pass that check. Obsidian's CSP only restricts
  // style-src (to 'self' + fonts.googleapis, with 'unsafe-inline' allowed) - hence inlining CSS
  // into a <style> tag rather than leaving a cross-origin <link href> in place.
  private async buildSrcdoc(file: TFile): Promise<string> {
    const adapter = this.app.vault.adapter;
    const rawHtml = await this.app.vault.read(file);
    const doc = new DOMParser().parseFromString(rawHtml, "text/html");
    const baseDir = file.parent?.path ?? "";

    const toResourceUrl = (relative: string): string =>
      adapter.getResourcePath(resolveVaultPath(baseDir, relative));

    for (const link of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
      const href = link.getAttribute("href");
      if (!href || isExternal(href)) continue;
      const cssPath = resolveVaultPath(baseDir, href);
      const cssText = await this.tryReadText(cssPath);
      const style = doc.createElement("style");
      style.textContent =
        cssText === null ? "" : this.rewriteCssUrls(cssText, dirname(cssPath));
      link.replaceWith(style);
    }

    // Tag every link to another local, non-page file so wireInteractions() can redirect the
    // click instead of letting it navigate the iframe away with no way back. This has to run
    // before the resource-attribute rewrite below - once an <a href> is rewritten to an
    // absolute app:// URL it looks "external" to isExternal() and would silently stop matching.
    for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href");
      if (!href || isExternal(href)) continue;
      const vaultPath = resolveVaultPath(baseDir, href);
      if (!PAGE_EXTS.has(extensionOf(vaultPath))) {
        a.setAttribute("data-lpv-open", vaultPath);
      }
    }

    for (const el of Array.from(doc.querySelectorAll("[src], [href], [poster], [srcset]"))) {
      if (el.tagName === "STYLE") continue;
      // <a href> is left as-is when tagged - wireInteractions() intercepts the click and never
      // lets the browser follow it, so rewriting it to a resource URL would be pointless.
      const skipHref = el.tagName === "A" && el.hasAttribute("data-lpv-open");
      for (const attr of RESOURCE_ATTRS) {
        if (skipHref && attr === "href") continue;
        const val = el.getAttribute(attr);
        if (val && !isExternal(val)) el.setAttribute(attr, toResourceUrl(val));
      }
      const srcset = el.getAttribute("srcset");
      if (srcset) {
        const rewritten = srcset
          .split(",")
          .map((part) => {
            const trimmed = part.trim();
            const spaceIdx = trimmed.indexOf(" ");
            const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
            const descriptor = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx);
            return isExternal(url) ? trimmed : toResourceUrl(url) + descriptor;
          })
          .join(", ");
        el.setAttribute("srcset", rewritten);
      }
    }

    // Toggled by armBookmarkPicker() while placing a bookmark - defined here (rather than set
    // as an inline style at runtime) because a static class is the guideline-approved way to
    // style an element, and this document has no access to the plugin's own styles.css anyway.
    const pickingStyle = doc.createElement("style");
    pickingStyle.textContent = ".lpv-picking-cursor, .lpv-picking-cursor * { cursor: crosshair !important; }";
    doc.head.appendChild(pickingStyle);

    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  private rewriteCssUrls(cssText: string, cssDir: string): string {
    const adapter = this.app.vault.adapter;
    return cssText.replace(CSS_URL_RE, (match, quote: string, url: string) => {
      if (isExternal(url) || url.startsWith("data:")) return match;
      const resolved = resolveVaultPath(cssDir, url);
      return `url(${quote}${adapter.getResourcePath(resolved)}${quote})`;
    });
  }

  private async tryReadText(vaultPath: string): Promise<string | null> {
    try {
      return await this.app.vault.adapter.read(vaultPath);
    } catch {
      return null;
    }
  }

  private async reload(): Promise<void> {
    if (this.file) await this.renderFile(this.file);
  }

  private openExternally(): void {
    if (!this.file || !(this.app.vault.adapter instanceof FileSystemAdapter)) return;
    void openInSystemApp(this.app.vault.adapter, this.file.path);
  }
}

// Node's `require` isn't declared in the plugin's types, and the guidelines flag it directly
// (Node APIs aren't available on mobile at all) - a dynamic import guarded by the
// FileSystemAdapter check callers already do is the sanctioned alternative. `shell.openPath`
// resolves with an error string on failure instead of rejecting, so that's surfaced as a Notice
// rather than silently ignored.
async function openInSystemApp(adapter: FileSystemAdapter, vaultPath: string): Promise<void> {
  const [path, electron] = await Promise.all([import("path"), import("electron")]);
  const result = await electron.shell.openPath(path.join(adapter.getBasePath(), vaultPath));
  if (result) new Notice(`Couldn't open externally: ${result}`);
}

class MediaModal extends Modal {
  private mediaEl: HTMLMediaElement | null = null;

  constructor(
    app: App,
    private vaultPath: string,
    private ext: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("lpv-media-modal");
    const { contentEl } = this;
    const url = this.app.vault.adapter.getResourcePath(this.vaultPath);
    if (IMAGE_EXTS.has(this.ext)) {
      const wrap = contentEl.createDiv({ cls: "lpv-image-zoom-wrap" });
      const img = wrap.createEl("img", { cls: "lpv-media-modal-content", attr: { src: url } });
      wireImageZoom(img);
    } else if (VIDEO_EXTS.has(this.ext)) {
      // muted + playsinline are required for autoplay to actually start on iOS - without them
      // WebKit silently refuses to play and just shows a blocked-playback glyph. That's a
      // separate concern from the "error" listener below, which catches a genuinely
      // undecodable file (e.g. HEVC/H.265, which Chromium/Electron can't decode at all).
      const video = contentEl.createEl("video", {
        cls: "lpv-media-modal-content",
        attr: { src: url, controls: "", autoplay: "", muted: "", playsinline: "" },
      });
      this.mediaEl = video;
      video.addEventListener("error", () => this.showUnsupportedFallback());
    } else if (AUDIO_EXTS.has(this.ext)) {
      this.mediaEl = contentEl.createEl("audio", { attr: { src: url, controls: "", autoplay: "" } });
    }
  }

  private showUnsupportedFallback(): void {
    const { contentEl } = this;
    this.mediaEl = null;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "This video's codec can't be decoded here - common with HEVC/H.265 exports from iPhone, which Chromium (desktop) can't play at all.",
    });
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      const adapter = this.app.vault.adapter;
      const btn = contentEl.createEl("button", { text: "Open in system player", cls: "mod-cta" });
      btn.addEventListener("click", () => {
        void openInSystemApp(adapter, this.vaultPath);
        this.close();
      });
    }
  }

  onClose(): void {
    if (this.mediaEl) {
      this.mediaEl.pause();
      this.mediaEl.removeAttribute("src");
    }
    this.contentEl.empty();
  }
}

const ZOOM_IMG_MIN = 1;
const ZOOM_IMG_MAX = 4;

// Pinch-to-zoom + drag-to-pan for the image preview, using Pointer Events so the same code
// handles touch (pinch) and mouse (wheel + drag) without separate touch/mouse listeners.
function wireImageZoom(img: HTMLImageElement): void {
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let panStart: { x: number; y: number; tx: number; ty: number } | null = null;
  const pointers = new Map<number, { x: number; y: number }>();

  const clampScale = (s: number) => Math.min(ZOOM_IMG_MAX, Math.max(ZOOM_IMG_MIN, s));
  const apply = () => {
    if (scale <= 1) {
      translateX = 0;
      translateY = 0;
    }
    img.setCssStyles({ transform: `translate(${translateX}px, ${translateY}px) scale(${scale})` });
  };

  img.addEventListener("pointerdown", (e) => {
    img.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
      pinchStartScale = scale;
    } else if (pointers.size === 1) {
      panStart = { x: e.clientX, y: e.clientY, tx: translateX, ty: translateY };
    }
  });

  img.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = Array.from(pointers.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStartDist > 0) {
        scale = clampScale(pinchStartScale * (dist / pinchStartDist));
        apply();
      }
    } else if (pointers.size === 1 && panStart && scale > 1) {
      translateX = panStart.tx + (e.clientX - panStart.x);
      translateY = panStart.ty + (e.clientY - panStart.y);
      apply();
    }
  });

  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStartDist = 0;
    if (pointers.size === 0) panStart = null;
  };
  img.addEventListener("pointerup", endPointer);
  img.addEventListener("pointercancel", endPointer);

  img.addEventListener("dblclick", () => {
    scale = scale > 1 ? 1 : 2;
    apply();
  });

  img.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      scale = clampScale(scale - e.deltaY * 0.01);
      apply();
    },
    { passive: false }
  );
}

class BookmarkNameModal extends Modal {
  constructor(
    app: App,
    private onSubmit: (name: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Bookmark name");
    const input = contentEl.createEl("input", { type: "text", cls: "lpv-bookmark-input" });
    input.focus();
    const submit = () => {
      const name = input.value.trim();
      if (name) {
        this.onSubmit(name);
        this.close();
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    const buttonRow = contentEl.createDiv({ cls: "lpv-modal-buttons" });
    const saveBtn = buttonRow.createEl("button", { text: "Save", cls: "mod-cta" });
    saveBtn.addEventListener("click", submit);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ManageBookmarksModal extends Modal {
  constructor(
    app: App,
    private filePath: string,
    private store: ViewStore
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Manage bookmarks");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const bookmarks = this.store.getBookmarks(this.filePath);
    if (bookmarks.length === 0) {
      contentEl.createEl("p", { text: "No bookmarks yet." });
      return;
    }
    for (let i = 0; i < bookmarks.length; i++) {
      const row = contentEl.createDiv({ cls: "lpv-bookmark-row" });
      row.createSpan({ text: bookmarks[i].name });
      const removeBtn = row.createEl("button", { text: "Remove" });
      removeBtn.addEventListener("click", () => {
        this.store.removeBookmark(this.filePath, i);
        this.render();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
