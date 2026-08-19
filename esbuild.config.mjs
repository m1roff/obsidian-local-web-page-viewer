import esbuild from "esbuild";
import { builtinModules } from "node:module";
import chokidar from "chokidar";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
  ],
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  logLevel: "info",
});

await ctx.rebuild();

if (prod) {
  await ctx.dispose();
  process.exit(0);
}

// esbuild's native watch mode relies on fsevents, which Docker Desktop on
// macOS does not reliably forward into the container. Poll instead.
chokidar
  .watch(["src", "manifest.json", "styles.css"], {
    usePolling: true,
    interval: 400,
    ignoreInitial: true,
  })
  .on("all", () => {
    ctx.rebuild().catch((err) => console.error(err));
  });

console.log("[esbuild] watching for changes (polling)...");
