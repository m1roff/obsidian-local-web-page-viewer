# Local Web Page Viewer

Opens local `.html` files in your vault as real rendered pages - CSS, images, and video all work, on desktop and mobile alike - instead of Obsidian refusing to display them at all.

## Why another HTML viewer plugin?

Obsidian doesn't render `.html` files - clicking one in the file explorer either does nothing useful or opens "unsupported file type." A common case: exporting a Telegram channel via Telegram Desktop produces `messages.html` plus `css/`, `images/`, `js/`, `photos/`, `video_files/` - a real static page, just sitting in your vault, unreadable from inside Obsidian.

Two existing approaches were tried and ruled out during development, for concrete, observed reasons - not just guesswork:

- **"HTML Reader"-style plugins** (inject the file's contents into an `iframe`/`srcdoc` without inlining its CSS) run straight into Obsidian's own Content-Security-Policy, which restricts `style-src` to `'self'` - an external stylesheet link inside that context gets silently blocked, so the page renders unstyled. Observed directly while comparing plugins during development: a real CSP violation in Obsidian's own console, naming exactly this.
- **A local-HTTP-server approach** (spin up `http://127.0.0.1:PORT` and point an iframe at it) genuinely works around Obsidian's restrictions, but by its own documentation is **desktop-only** - it needs Node's `http` module, which doesn't exist in Obsidian's mobile (Capacitor) runtime at all. Telegram exports are exactly the kind of thing you'd want to read on your phone.

Local Web Page Viewer takes a third path: no local server, no unstyled DOM injection. It reads the HTML, rewrites every relative resource reference (CSS, images, scripts) to a real vault resource path, inlines stylesheets as `<style>` text, and loads the result through `iframe.srcdoc` - which, unlike a plain `iframe.src` navigation, inherits the trusted origin needed to actually load those resources. The mechanism (and exactly why the alternatives above don't hold up) is documented in detail below. No Node.js, no native code, no bundled browser engine - just the one every platform already has.

## What it does beyond "just render the page"

- **Zoom in / out / reset**, plus **fit to width** - scales the page's own rendered content (not Obsidian's UI), so a page with no responsive layout of its own still fits a phone screen, or fills a wide desktop pane instead of sitting tiny in the middle of it.
- **Video actually plays.** Photo/video links that would otherwise navigate the frame away from the page (with no back button to recover) open in a proper in-app viewer instead - a real `<video controls>` player, with pinch-to-zoom and pan on images. If a video's codec can't be decoded here (HEVC/H.265 exports from iPhone are a common case - Chromium doesn't support HEVC at all, a platform limitation no plugin can route around), you get a clear message and a one-click "open in system player" instead of a silent black box.
- **Bookmarks.** Click "Add bookmark" on the page, click the spot you want to remember, name it - jump back to it later from the Bookmarks menu. Saved per file, synced across every device the vault syncs to.
- **Remembers where you left off**, per device - scroll back into a page and it reopens exactly where you were, without one device's position overwriting another's.
- **Configurable toolbar** - pin whichever actions you actually use as their own icon, tuck the rest into one menu, reorder either way. Settings → *Local Web Page Viewer*.
- **Same feature set on desktop and mobile.** Nothing here is a desktop-only add-on - zoom, bookmarks, scroll memory, the media viewer, all of it works identically on iOS, Android, and desktop, because none of it depends on anything platform-specific.

## How it works

No bundled browser engine - each platform already has one, reached through a sandboxed `<iframe>`:

- **Desktop** (Electron): renders in the same Chromium engine as the rest of the app. An Electron `<webview>` was tried first for extra isolation, but Obsidian's main window strips `webviewTag` support from any attached webview for security, leaving it unable to load anything - so a plain iframe is used instead.
- **iOS / iPadOS**: Apple requires WebKit under any in-app web rendering. This means iPad rendering follows Safari/WebKit's rules, not Chrome's - most pages look identical, but don't expect pixel-for-pixel parity with desktop for anything relying on Chromium-only behavior.
- **Android**: renders over the system's Chromium-based WebView.

The file isn't just pointed at with `iframe.src` - Obsidian's main process only allows `app://` resource requests whose *requesting frame* origin matches Obsidian's own trusted origin, and a `src`-navigated iframe gets a distinct origin of its own, so every subresource the page then requests (CSS, images, scripts) gets silently cancelled. A `srcdoc` document inherits its origin from the parent instead, which passes that check - so the plugin reads the HTML, rewrites every relative resource reference to an absolute vault resource path, inlines `<link rel="stylesheet">` as `<style>` text (Obsidian's CSP allows inline styles but not cross-origin stylesheet links), and loads the result via `iframe.srcdoc`.

A link to another local file (a photo, a video) would normally navigate the iframe away from the rendered page entirely, with no address bar or back button to recover - so those clicks are intercepted and redirected to an in-app media viewer instead, loaded from the trusted top-level context rather than through the sandboxed frame.

Scripts are allowed (`allow-scripts` in the sandbox) - the trust level is the same as opening the file in a regular browser: it only runs what you already put in your own vault.

### Known gaps

- CSS `@import` isn't inlined (only `url(...)` references are rewritten) - not needed for the Telegram-export case this was built for, but a page that splits its stylesheet across multiple `@import`ed files will be missing those rules.
- Very large linked binaries (e.g. multi-hundred-MB video files) load as regular resource requests, not inlined - fine for images and thumbnails, untested at scale for video-heavy exports.
- No back/forward navigation between pages within a viewed file (e.g. following a link from `messages.html` to `messages2.html`) - it just loads whatever file is opened.
- This plugin becomes the sole handler for `.html`/`.htm` files in your vault - by design, not an oversight.

## Installation

Not yet in the official Community Plugins directory. Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable the **BRAT** community plugin.
2. BRAT → *Add beta plugin* → enter this repository's URL.
3. Enable **Local Web Page Viewer** under Settings → Community plugins.

## Usage

Once enabled, `.html` and `.htm` files open in this view automatically - Local Web Page Viewer registers itself as the handler for both extensions. Which toolbar actions show up, and in what order, is configurable under Settings → *Local Web Page Viewer*.

## Development

Local dev tooling runs entirely in Docker - nothing is installed on the host beyond Docker itself.

```bash
docker compose build
docker compose run --rm build npm install
docker compose up -d      # watches src/ and rebuilds main.js on change
```

Symlink the build output into a test vault's `.obsidian/plugins/local-web-page-viewer/` folder, then reload plugins in Obsidian (`Cmd+P` → *Reload app without saving*) after each rebuild, or install the [Hot Reload](https://github.com/pjeby/hot-reload) community plugin for automatic reloading.

```bash
docker compose run --rm build npm run lint   # eslint-plugin-obsidianmd, same checks community.obsidian.md's scorecard runs
```

## License

MIT


[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://buymeacoffee.com/miroff)
