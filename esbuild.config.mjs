import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";

const prod = process.argv[2] === "production";

const CLIENT_ID_PLACEHOLDER = "YOUR_GITHUB_OAUTH_CLIENT_ID";
let clientId = process.env.CLIENT_ID?.trim();

if (!clientId) {
  if (prod) {
    console.error(
      "Production build requires CLIENT_ID (e.g. CLIENT_ID=your_id npm run build)",
    );
    process.exit(1);
  }
  clientId = CLIENT_ID_PLACEHOLDER;
  console.warn(
    "CLIENT_ID not set. Using placeholder (GitHub connect will not work). Set CLIENT_ID to test OAuth.",
  );
}

esbuild.build({
  banner: { js: "/* obsidian-github-vault-sync */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
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
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  define: {
    __CLIENT_ID__: JSON.stringify(clientId),
  },
});
