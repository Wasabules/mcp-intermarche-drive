// Structure checks for the companion skills shipped in skills/: Claude only sees a skill through its
// frontmatter (name + description), so a malformed header silently disables it.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../../skills/", import.meta.url);
const skills = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, "SKILL.md doit commencer par un en-tête YAML délimité par ---");
  const fields: Record<string, string> = {};
  let current: string | undefined;
  for (const line of match[1].split("\n")) {
    const field = /^([a-z][a-z0-9_-]*):\s*(.*)$/.exec(line);
    if (field) {
      current = field[1];
      fields[current] = /^[>|]-?$/.test(field[2]) ? "" : field[2].replace(/^["']|["']$/g, "");
    } else if (current && /^\s+\S/.test(line)) {
      fields[current] = `${fields[current]} ${line.trim()}`.trim();
    }
  }
  return { fields, body: match[2] };
}

test("companion skills are present", () => {
  assert.deepEqual(skills.sort(), ["intermarche-shopping", "weekly-meal-plan"]);
});

for (const name of skills) {
  test(`skill ${name} has a valid header and a reasonable body`, () => {
    const text = readFileSync(new URL(`${name}/SKILL.md`, root), "utf8");
    const { fields, body } = frontmatter(text);
    assert.equal(fields.name, name, "name doit être identique au nom du dossier");
    assert.match(fields.name, /^[a-z0-9-]{1,64}$/);
    assert.ok(fields.description && fields.description.length >= 100, "description trop courte pour déclencher le skill");
    assert.ok(fields.description.length <= 1024, `description trop longue (${fields.description.length} > 1024)`);
    assert.match(fields.description, /«[^»]+»/, "la description doit contenir des déclencheurs en français");
    const lines = body.split("\n").length;
    assert.ok(lines >= 20 && lines < 500, `corps de ${lines} lignes (attendu 20 à 499)`);
  });

  test(`skill ${name} contains no personal data`, () => {
    const text = readFileSync(new URL(`${name}/SKILL.md`, root), "utf8");
    assert.doesNotMatch(text, /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i, "adresse e-mail");
    assert.doesNotMatch(text, /(?:\+33\s?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/, "numéro de téléphone");
    assert.doesNotMatch(text, /\b\d{2,3}\s?kg\b|\b1\s?m\s?\d{2}\b/i, "mensurations personnelles");
  });
}
