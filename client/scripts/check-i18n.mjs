/**
 * i18n consistency check (run with `npm run check:i18n`):
 * 1. en.json and es.json define exactly the same keys.
 * 2. Every literal key used as t("...") in src/ exists in the dictionaries.
 * Exits with code 1 and lists the problems otherwise.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const flatten = (node, prefix = "") =>
  Object.entries(node).flatMap(([key, value]) =>
    typeof value === "object" && value !== null ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`]
  );

const en = new Set(flatten(JSON.parse(readFileSync(join(root, "locales/en.json"), "utf8"))));
const es = new Set(flatten(JSON.parse(readFileSync(join(root, "locales/es.json"), "utf8"))));
const problems = [];
for (const key of en) if (!es.has(key)) problems.push(`missing in es.json: ${key}`);
for (const key of es) if (!en.has(key)) problems.push(`missing in en.json: ${key}`);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(jsx?|tsx?)$/.test(name)) files.push(path);
  }
};
walk(root);

let used = 0;
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) {
    used++;
    if (!en.has(match[1])) problems.push(`${file.slice(root.length)}: unknown key "${match[1]}"`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`i18n OK: ${en.size} keys in each language, ${used} literal usages checked in ${files.length} files.`);
