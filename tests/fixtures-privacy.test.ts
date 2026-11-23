// Guards what gets published: the fixtures are sanitized live responses, re-recorded from a real
// signed-in session, then committed to a public repository. Fails when one looks like it still holds
// personal data or identifiers that the recorder should have removed.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../../tests/fixtures/", import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

const FORBIDDEN_KEY =
  /^(tracking|sponsorShipTag|privateData|customer.*|client.*|consommateur.*|email|mail|phone|telephone|mobile.*|adresse.*|address.*|.*fidel.*|.*loyalty.*|benefits|stickers.*|token|session.*|user.*|nom|prenom|firstName|lastName|civilit.*|birth.*)$/i;
const VALUE_PATTERNS: Array<[string, RegExp]> = [
  ["adresse e-mail", /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i],
  ["numéro de téléphone", /(?:\+33\s?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/],
  ["identifiant UUID non anonymisé", /\b(?!00000000-0000-0000-0000-000000000000\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["jeton JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

function findings(value: unknown, path: string, out: string[]): string[] {
  if (Array.isArray(value)) value.forEach((item, index) => findings(item, `${path}[${index}]`, out));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) out.push(`${path}.${key} : clé interdite`);
      findings(child, `${path}.${key}`, out);
    }
  } else if (typeof value === "string") {
    for (const [label, pattern] of VALUE_PATTERNS) if (pattern.test(value)) out.push(`${path} : ${label}`);
  }
  return out;
}

test("fixtures exist", () => {
  assert.ok(files.length > 0, "aucune fixture dans tests/fixtures");
});

for (const file of files) {
  test(`fixture ${file} holds no personal data or live identifiers`, () => {
    const data = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as unknown;
    const problems = findings(data, file, []);
    assert.deepEqual(problems, [], `Relance npm run fixtures:record ou nettoie la fixture :\n${problems.join("\n")}`);
  });
}

test("the basket fixture keeps a single line", () => {
  const cart = JSON.parse(readFileSync(new URL("cart.json", dir), "utf8")) as { carts: Array<{ items: unknown[] }> };
  assert.equal(cart.carts.reduce((sum, sub) => sum + sub.items.length, 0), 1);
});
