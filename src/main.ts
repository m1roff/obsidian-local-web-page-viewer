import { Platform, Plugin, TFile } from "obsidian";
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
  // Toolbar layout is keyed by device too, for the same reason - a desktop's wide toolbar and a
  // phone's minimal one are different arrangements, not one setting that should fight itself.
  zoomByDevice: Record<string, Record<string, number>>;
  scrollByDevice: Record<string, Record<string, number>>;
  actionsByDevice: Record<string, ActionSetting[]>;
  // Bookmarks are kept per file only, deliberately not per device - the point is to jump back
  // to the same spot on whichever device you're reading on.
  bookmarksByFile: Record<string, Bookmark[]>;
}

// Actions not in this set start tucked into the "Page tools" menu rather than as their own
// icon - a starting point anyone can expand from the settings tab. Mobile's default is just
// Fit to width (the one action a narrow phone screen actually needs unprompted); desktop's is
// the reload/zoom actions closest to core browser behavior. This only matters the first time a
// given device is seen - normalizeActionSettings falls back to it per-id, so it never overrides
// anything already saved.
const DEFAULT_PINNED = Platform.isMobile
  ? new Set<ActionId>(["fitToWidth"])
  : new Set<ActionId>(["reload", "zoomIn", "zoomOut"]);

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
  return { zoomByDevice: {}, scrollByDevice: {}, actionsByDevice: {}, bookmarksByFile: {} };
}

export default class LocalPageViewerPlugin extends Plugin {
  private data: LocalPageViewerData = defaultData();
  private deviceId = "";

  async onload(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<LocalPageViewerData> | null;
    this.data = Object.assign(defaultData(), loaded);
    this.deviceId = getDeviceId();
    this.registerView(VIEW_TYPE_LOCAL_PAGE, (leaf) => new LocalPageView(leaf, this));
    this.registerExtensions(["html", "htm"], VIEW_TYPE_LOCAL_PAGE);
    this.addSettingTab(new LocalPageViewerSettingTab(this.app, this));

    // A folder rename/move fires this event individually for every file under it (not once for
    // the folder), so a plain TFile check here handles both a direct file rename and a folder
    // one - confirmed against attachment-steward, which relies on the same behavior.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) void this.renamePath(oldPath, file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) void this.deletePath(file.path);
      })
    );
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
    return normalizeActionSettings(this.data.actionsByDevice[this.deviceId]);
  }

  async setActionSettings(actions: ActionSetting[]): Promise<void> {
    this.data.actionsByDevice[this.deviceId] = actions;
    await this.saveData(this.data);
    this.refreshOpenViews();
  }

  // Scoped to this device only - deleting its entry lets getActionSettings() fall back to
  // normalizeActionSettings(undefined), which is exactly the platform-appropriate default
  // (DEFAULT_PINNED per id), without duplicating that logic here. Other devices' arrangements
  // are untouched, matching how they were never affected by this device's changes either.
  async resetActionSettings(): Promise<void> {
    delete this.data.actionsByDevice[this.deviceId];
    await this.saveData(this.data);
    this.refreshOpenViews();
  }

  private refreshOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LOCAL_PAGE)) {
      if (leaf.view instanceof LocalPageView) leaf.view.refreshActionBar();
    }
  }

  // Everything else here is keyed by file path - a rename/move leaves those entries orphaned
  // under a path nothing points to anymore unless they're carried over to the new one.
  private async renamePath(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    for (const perDevice of [this.data.zoomByDevice, this.data.scrollByDevice]) {
      for (const deviceId of Object.keys(perDevice)) {
        const value = perDevice[deviceId][oldPath];
        if (value === undefined) continue;
        delete perDevice[deviceId][oldPath];
        perDevice[deviceId][newPath] = value;
        changed = true;
      }
    }
    if (this.data.bookmarksByFile[oldPath]) {
      this.data.bookmarksByFile[newPath] = this.data.bookmarksByFile[oldPath];
      delete this.data.bookmarksByFile[oldPath];
      changed = true;
    }
    if (changed) await this.saveData(this.data);
  }

  private async deletePath(path: string): Promise<void> {
    let changed = false;
    for (const perDevice of [this.data.zoomByDevice, this.data.scrollByDevice]) {
      for (const deviceId of Object.keys(perDevice)) {
        if (perDevice[deviceId][path] === undefined) continue;
        delete perDevice[deviceId][path];
        changed = true;
      }
    }
    if (this.data.bookmarksByFile[path]) {
      delete this.data.bookmarksByFile[path];
      changed = true;
    }
    if (changed) await this.saveData(this.data);
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
