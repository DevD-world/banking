import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, "netlify-publish");
const files = [
  "index.html",
  "mobile.html",
  "customer.html",
  "manager.html",
  "pitch.html",
  "app.js",
  "mobile.js",
  "config.js",
  "styles.css",
  "mobile.css",
  "service-worker.js",
  "manifest.webmanifest",
  "icon.svg",
  "icons"
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const file of files) {
  const source = path.join(root, file);
  if (existsSync(source)) {
    await cp(source, path.join(out, file), { recursive: true });
  }
}
