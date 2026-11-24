#!/usr/bin/env node
// Checks the files `npm pack` would publish: the built server must be there, sources, tests,
// scripts (with their live fixtures tooling) and local secrets must not.
// Usage: npm run build && npm pack --dry-run --json --ignore-scripts > pack.json && node scripts/check-pack.mjs pack.json
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2] ?? "pack.json", "utf8"));
const files = report[0].files.map((file) => file.path);
const required = [
  "dist/src/index.js",
  "dist/src/server.js",
  "skills/intermarche-shopping/SKILL.md",
  "skills/weekly-meal-plan/SKILL.md",
  "README.md",
  "LICENSE",
  "NOTICE",
];
const missing = required.filter((file) => !files.includes(file));
const forbidden = files.filter((file) => /^(tests|scripts|src)\/|(^|\/)\.env|\.log$/.test(file));

console.log(`${files.length} fichiers dans le paquet`);
if (missing.length > 0 || forbidden.length > 0) {
  console.error(JSON.stringify({ missing, forbidden }, null, 2));
  process.exit(1);
}
