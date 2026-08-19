import { Plugin } from "obsidian";
import {
  ACTION_IDS,
  ActionId,
  ActionSetting,
  Bookmark,
  LocalPageView,
  VIEW_TYPE_LOCAL_PAGE,
} from "./view";
import { LocalPageViewerSettingTab } from "./settings-tab";

interface LocalPageViewerData {
  // *ByDevice[deviceId][filePath] = value. Keyed by device, not just file - data.json itself
  // syncs across devices (Obsidian Sync / iCloud etc.), so without this a zoom level or scroll
  // position set on a desktop's wide screen would silently overwrite what's readable on a phone.
  zoomByDevice: Record<string, Record<string, number>>;
  // 0..1 fraction of the page's scrollable height, not a raw pixel offset - stays valid across
  // zoom changes and different screen sizes on different devices.
  scrollByDevice: Record<string, Record<string, number>>;
  // Bookmarks are kept per file only, deliberately not per device - the point is to jump back
  // to the same spot on whichever device you're reading on.
  bookmarksByFile: Record<string, Bookmark[]>;
  // Toolbar layout, deliberately global (not per-device) - a one-time "how I like it arranged"
  // preference, same spirit as any other plugin setting.
  actions: ActionSetting[];
}

// Actions not in this set start tucked into the "Page tools" menu rather than as their own
// icon - a reasonable default for a narrow phone screen that desktop users with room to spare
// can freely repin from the settings tab.
const DEFAULT_PINNED = new Set<ActionId>([
  "reload",
  "zoomIn",
  "zoomOut",
  "resetZoom",
  "addBookmark",
  "bookmarks",
]);

function defaultActionSettings(): ActionSetting[] {
  return ACTION_IDS.map((id) => ({ id, pinned: DEFAULT_PINNED.has(id) }));
}

const DEVICE_ID_KEY = "local-web-page-viewer-device-id";

// localStorage is local to this specific app installation - unlike the vault's data.json,
// it never travels with iCloud/Obsidian Sync, which makes it exactly what a per-device id needs.
function getDeviceId(): string {
  let id = window.localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

// Reconciles saved action settings against the current ACTION_IDS list: keeps the saved order
// and pinned state for known ids, drops ids that no longer exist, and appends any new ids (from
// a plugin update) at their default position - so a future added action doesn't silently vanish
// from settings that predate it.
function normalizeActionSettings(saved: unknown): ActionSetting[] {
  const savedArr = Array.isArray(saved) ? (saved as ActionSetting[]) : [];
  const savedById = new Map(savedArr.map((a) => [a.id, a]));
  const seen = new Set<ActionId>();
  const result: ActionSetting[] = [];
  for (const entry of savedArr) {
    if (!ACTION_IDS.includes(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push({ id: entry.id, pinned: entry.pinned });
  }
  for (const id of ACTION_IDS) {
    if (seen.has(id)) continue;
    result.push({ id, pinned: savedById.get(id)?.pinned ?? DEFAULT_PINNED.has(id) });
  }
  return result;
}

function defaultData(): LocalPageViewerData {
  return { zoomByDevice: {}, scrollByDevice: {}, bookmarksByFile: {}, actions: defaultActionSettings() };
}

export default class LocalPageViewerPlugin extends Plugin {
  private data: LocalPageViewerData = defaultData();
  private deviceId = "";

  async onload(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<LocalPageViewerData> | null;
    this.data = Object.assign(defaultData(), loaded);
    this.data.actions = normalizeActionSettings(loaded?.actions);
    this.deviceId = getDeviceId();
    this.registerView(VIEW_TYPE_LOCAL_PAGE, (leaf) => new LocalPageView(leaf, this));
    this.registerExtensions(["html", "htm"], VIEW_TYPE_LOCAL_PAGE);
    this.addSettingTab(new LocalPageViewerSettingTab(this.app, this));
  }

  getZoom(path: string): number | undefined {
    return this.data.zoomByDevice[this.deviceId]?.[path];
  }

  async setZoom(path: string, zoom: number): Promise<void> {
    await this.setDeviceValue(this.data.zoomByDevice, path, zoom);
  }

  getScroll(path: string): number | undefined {
    return this.data.scrollByDevice[this.deviceId]?.[path];
  }

  async setScroll(path: string, fraction: number): Promise<void> {
    await this.setDeviceValue(this.data.scrollByDevice, path, fraction);
  }

  getBookmarks(path: string): Bookmark[] {
    return this.data.bookmarksByFile[path] ?? [];
  }

  async addBookmark(path: string, bookmark: Bookmark): Promise<void> {
    if (!this.data.bookmarksByFile[path]) this.data.bookmarksByFile[path] = [];
    this.data.bookmarksByFile[path].push(bookmark);
    await this.saveData(this.data);
  }

  async removeBookmark(path: string, index: number): Promise<void> {
    this.data.bookmarksByFile[path]?.splice(index, 1);
    await this.saveData(this.data);
  }

  getActionSettings(): ActionSetting[] {
    return this.data.actions;
  }

  async setActionSettings(actions: ActionSetting[]): Promise<void> {
    this.data.actions = actions;
    await this.saveData(this.data);
  }

  private async setDeviceValue(
    store: Record<string, Record<string, number>>,
    path: string,
    value: number
  ): Promise<void> {
    if (!store[this.deviceId]) store[this.deviceId] = {};
    store[this.deviceId][path] = value;
    await this.saveData(this.data);
  }
}
