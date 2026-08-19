import { App, PluginSettingTab, Setting } from "obsidian";
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
      );

    const actions = this.plugin.getActionSettings();
    actions.forEach((action, index) => {
      const meta = ACTION_META[action.id];
      const setting = new Setting(containerEl).setName(meta.label);

      setting.addToggle((toggle) =>
        toggle
          .setTooltip("Pin as its own icon")
          .setValue(action.pinned)
          .onChange((value) => {
            action.pinned = value;
            void this.plugin.setActionSettings(actions);
          })
      );

      setting.addExtraButton((button) =>
        button
          .setIcon("arrow-up")
          .setTooltip("Move up")
          .setDisabled(index === 0)
          .onClick(() => this.moveAction(actions, index, index - 1))
      );

      setting.addExtraButton((button) =>
        button
          .setIcon("arrow-down")
          .setTooltip("Move down")
          .setDisabled(index === actions.length - 1)
          .onClick(() => this.moveAction(actions, index, index + 1))
      );
    });
  }

  private moveAction(actions: ActionSetting[], from: number, to: number): void {
    if (to < 0 || to >= actions.length) return;
    [actions[from], actions[to]] = [actions[to], actions[from]];
    void this.plugin.setActionSettings(actions);
    this.display();
  }
}
