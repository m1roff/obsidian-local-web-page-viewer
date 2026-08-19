import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import { ACTION_META, ActionSetting } from "./view";
import type LocalPageViewerPlugin from "./main";

export class LocalPageViewerSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LocalPageViewerPlugin
  ) {
    super(app, plugin);
  }

  // Imperative display() is deprecated since Obsidian 1.13.0 in favor of a declarative
  // getSettingDefinitions() API - not migrated for this first release, a small settings tab
  // like this one doesn't carry much cost either way.
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Toolbar")
      .setHeading()
      .setDesc(
        'Pin an action to give it its own icon in the file\'s tab header. Unpinned actions are ' +
          'tucked into the "Page tools" menu instead - handy for keeping a narrow phone screen ' +
          "uncluttered. Use the arrows to reorder."
      )
      .addButton((button) =>
        button
          .setButtonText("Reset to default")
          .setTooltip("Resets this device's toolbar only - other devices are untouched")
          .onClick(() => {
            void this.plugin.resetActionSettings();
            this.display();
          })
      );

    const actions = this.plugin.getActionSettings();
    actions.forEach((action, index) => {
      const meta = ACTION_META[action.id];
      const setting = new Setting(containerEl).setName(meta.label).setDesc(meta.desc);

      setting.addToggle((toggle) => {
        toggle
          .setTooltip("Pin as its own icon")
          .setValue(action.pinned)
          .onChange((value) => {
            action.pinned = value;
            void this.plugin.setActionSettings(actions);
          });
        // Fit to width only does anything on mobile - leave it toggleable from a phone's own
        // settings (where it applies), disabled here so it can't be turned on from a device
        // where it would just sit there doing nothing.
        if (action.id === "fitToWidth" && Platform.isDesktopApp) {
          toggle.setDisabled(true).setTooltip("Mobile only - toggle this from your phone");
        }
      });

      const isFirst = index === 0;
      const isLast = index === actions.length - 1;

      setting.addExtraButton((button) =>
        button
          .setIcon("arrow-up-to-line")
          .setTooltip("Move to top")
          .setDisabled(isFirst)
          .onClick(() => this.moveToEdge(actions, index, "top"))
      );

      setting.addExtraButton((button) =>
        button
          .setIcon("arrow-up")
          .setTooltip("Move up")
          .setDisabled(isFirst)
          .onClick(() => this.moveAction(actions, index, index - 1))
      );

      setting.addExtraButton((button) =>
        button
          .setIcon("arrow-down")
          .setTooltip("Move down")
          .setDisabled(isLast)
          .onClick(() => this.moveAction(actions, index, index + 1))
      );

      setting.addExtraButton((button) =>
        button
          .setIcon("arrow-down-to-line")
          .setTooltip("Move to bottom")
          .setDisabled(isLast)
          .onClick(() => this.moveToEdge(actions, index, "bottom"))
      );
    });
  }

  private moveAction(actions: ActionSetting[], from: number, to: number): void {
    if (to < 0 || to >= actions.length) return;
    [actions[from], actions[to]] = [actions[to], actions[from]];
    void this.plugin.setActionSettings(actions);
    this.display();
  }

  private moveToEdge(actions: ActionSetting[], from: number, edge: "top" | "bottom"): void {
    const [item] = actions.splice(from, 1);
    if (edge === "top") actions.unshift(item);
    else actions.push(item);
    void this.plugin.setActionSettings(actions);
    this.display();
  }
}
