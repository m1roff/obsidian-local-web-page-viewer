# Local Web Page Viewer

Opens local `.html` files in your vault as real rendered pages - CSS, images, and video all work, on desktop and mobile alike - instead of Obsidian refusing to display them at all.

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://buymeacoffee.com/miroff)

## Demo

### Desktop

**Rendering** - opening a `.html` file, zoom, page-native JS interactivity, following a link, opening and pinch/scroll-zooming an image, playing video in the in-app player.

<video src="https://github.com/user-attachments/assets/5b2c54ee-828c-4dc4-847e-2e63459eb123" autoplay loop muted controls></video>

**Settings** - pinning/unpinning toolbar actions, reordering them, resetting.

<video src="https://github.com/user-attachments/assets/33f0c580-762b-4027-95f2-aaa1a741344f" autoplay loop muted controls></video>

### Mobile

**Viewing** - Fit to width, playing video, following a link.

<video src="https://github.com/user-attachments/assets/768ec4cf-91a0-41b6-b4a4-9bb4a0548cb4" autoplay loop muted controls></video>


**Bookmarks** - opening the Bookmarks menu, jumping to a saved spot, managing bookmarks.

<video src="https://github.com/user-attachments/assets/7a74e036-ba44-4f28-99f1-91bb701061f6" autoplay loop muted controls></video>



## Why another HTML viewer plugin?

Obsidian doesn't render `.html` files - clicking one in the file explorer either does nothing useful or opens "unsupported file type." A common case: exporting a Telegram channel via Telegram Desktop produces `messages.html` plus `css/`, `images/`, `js/`, `photos/`, `video_files/` - a real static page, just sitting in your vault, unreadable from inside Obsidian.

Two existing approaches were tried and ruled out during development, for concrete, observed reasons - not just guesswork:

- **"HTML Reader"-style plugins** (inject the file's contents into an `iframe`/`srcdoc` without inlining its CSS) run straight into Obsidian's own Content-Security-Policy, which restricts `style-src` to `'self'` - an external stylesheet link inside that context gets silently blocked, so the page renders unstyled. Observed directly while comparing plugins during development: a real CSP violation in Obsidian's own console, naming exactly this.
- **A local-HTTP-server approach** (spin up `http://127.0.0.1:PORT` and point an iframe at it) genuinely works around Obsidian's restrictions, but by its own documentation is **desktop-only** - it needs Node's `http` module, which doesn't exist in Obsidian's mobile (Capacitor) runtime at all. Telegram exports are exactly the kind of thing you'd want to read on your phone.

Local Web Page Viewer takes a third path: no local server, no unstyled DOM injection. It reads the HTML, rewrites every relative resource reference (CSS, images, scripts) to a real vault resource path, inlines stylesheets as `<style>` text, and loads the result through `iframe.srcdoc` - which, unlike a plain `iframe.src` navigation, inherits the trusted origin needed to actually load those resources. No Node.js, no native code, no bundled browser engine - just the one every platform already has. The full mechanism, and why the alternatives above don't hold up, is in [How it works](#how-it-works).

## What makes this different from any of the alternatives

Nobody else does all of this - most existing HTML viewers stop at "the text is visible."

| | Local Web Page Viewer | "Inject into DOM" plugins | Local-HTTP-server plugins |
|---|---|---|---|
| CSS renders correctly | ✅ | ❌ (blocked by Obsidian's CSP) | ✅ |
| Works on mobile | ✅ | partial at best | ❌ desktop-only |
| Video actually plays | ✅ (in-app player + codec fallback) | - | - |
| Zoom / fit-to-width | ✅ | ❌ | ❌ |
| Bookmarks inside a page | ✅ | ❌ | ❌ |
| Remembers scroll position | ✅ (per device) | ❌ | ❌ |
| Configurable toolbar | ✅ (per device) | ❌ | ❌ |
| No local server, no native code | ✅ | ✅ | ❌ |

## Features

- **Real rendering, not DOM injection.** CSS, images, fonts, background images via `url()`, inline scripts - all load through the same mechanism Obsidian itself uses for resources embedded in notes, not a workaround that only handles the easy cases.
- **Zoom in / out / reset**, plus **Fit to width** - scales the page's own rendered content (not Obsidian's UI, so `Cmd +/-` still controls the app as normal). Works on any page regardless of whether it has a responsive layout of its own: a fixed-width "desktop only" export gets shrunk to fit a phone, or stretched to fill a wide pane instead of sitting tiny in the middle of it. Built on `transform: scale()`, not the CSS `zoom` property - WebKit has a long-standing bug ([webkit.org/b/77998](https://bugs.webkit.org/show_bug.cgi?id=77998)) where `zoom` both reads and applies unreliably, confirmed live on-device during development.
- **Photos and video open safely.** A link to another local file would otherwise navigate the frame away from the page entirely, with no back button to recover - those clicks are now intercepted and redirected to an in-app viewer instead: a real `<video controls>` player for video, pinch-to-zoom-and-pan for images (both mouse and touch).
- **Video codec fallback.** If a video can't be decoded here (HEVC/H.265 exports from iPhone are the common case, and Chromium doesn't support HEVC on every platform), you get a clear explanation and a one-click "open in system player" instead of a silent black box.
- **Bookmarks.** Click "Add bookmark," click the spot on the page you want to remember, name it - jump back to it later from the Bookmarks menu, or manage/remove them. Saved per file and synced across every device the vault syncs to.
- **Remembers where you left off, per device.** Scroll back into a page and it reopens exactly where you were - stored as a fraction of scrollable height, not a raw pixel offset, so it stays correct across different zoom levels and screen sizes.
- **Fully configurable toolbar, independently per device.** Pin whichever actions you actually use as their own icon in the tab header; unpinned ones tuck into one "Page tools" menu. Reorder with up/down arrows or jump an action straight to the top/bottom. Desktop and mobile keep separate arrangements - a phone defaults to a minimal toolbar (Fit to width front and center), a desktop keeps more icons pinned by default, and neither setting fights the other. Settings changes apply to already-open tabs immediately, no reload needed.
- **Never loses track of a file.** Renaming or moving a file (or a whole folder) automatically carries its zoom, scroll position, and bookmarks over to the new path; deleting a file cleans those records up instead of leaving orphaned entries behind.
- **Identical feature set on desktop and mobile.** Nothing here is a desktop-only add-on bolted onto a bare mobile fallback - zoom, bookmarks, scroll memory, the media viewer, all of it works the same on iOS, Android, and desktop, because none of it depends on anything platform-specific.

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

Once enabled, `.html` and `.htm` files open in this view automatically - Local Web Page Viewer registers itself as the handler for both extensions.

### Toolbar

| Action | What it does |
|---|---|
| Reload | Re-renders the page from disk |
| Zoom in / Zoom out | Scales the page's own content, not Obsidian's interface |
| Reset zoom | Back to 100% |
| Fit to width | Scales a page with no responsive layout of its own to fit the pane (mobile) |
| Add bookmark | Click a spot on the page, name it, jump back later |
| Bookmarks | Jump to a saved bookmark, or manage/remove them |
| Open in system browser | Desktop only |

Which of these show as their own icon versus live in the "Page tools" menu, and in what order, is set independently for each device under **Settings → Local Web Page Viewer**.

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
