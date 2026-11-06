#!/usr/bin/env bun
/**
 * Shows, plans, and verifies edits to the "This Week" column of a Weekly Recap Google Doc. Docs
 * positions are UTF-16 offsets that shift with every emoji and insert, so they are computed here.
 *
 *   doc-edits.ts show <read.json>
 *   doc-edits.ts plan <read.json> <edits.json>
 *   doc-edits.ts verify <before.json> <after.json> <edits.json>
 *
 * `read.json` is a saved read_doc result. `edits.json` is a list in final bullet order:
 *
 *   { "section": "Infra", "text": "✅ A new top-level bullet" }
 *   { "section": "Infra", "parent": "A group bullet", "text": "✅ A nested bullet" }
 *   { "section": "Infra", "replace": "🚧 An existing bullet", "text": "✅ An existing bullet" }
 *
 * `plan` prints the `requests` and `writeControl` for one update_doc call. `verify` prints each
 * problem it finds and exits non-zero if there are any.
 */
import { readFileSync } from "node:fs";

export type Edit = { section: string; text: string; parent?: string; replace?: string };

export type Paragraph = {
  start: number;
  end: number;
  text: string;
  listId?: string;
  level: number;
  suggested: boolean;
};

export type Section = { name: string; thisWeek: Paragraph[]; lastWeek: Paragraph[] };
export type Recap = { revisionId: string; tabId: string; sections: Section[] };
export type Plan = { requests: object[]; writeControl: { requiredRevisionId: string } };
type Insert = { anchor: Paragraph; level: number; items: string[] };
type Range = { startIndex: number; endIndex: number; tabId: string };

const BULLET_PRESET = "BULLET_DISC_CIRCLE_SQUARE";
const INDENT_STEP = 36;

const sectionKey = (name: string) => name.trim().replace(/:$/, "").toLowerCase();

function elementText(element: any): string {
  return (
    element.textRun?.content ??
    element.person?.personProperties?.name ??
    element.richLink?.richLinkProperties?.title ??
    ""
  );
}

function toParagraph(content: any): Paragraph {
  const { elements, bullet } = content.paragraph;
  return {
    start: content.startIndex,
    end: content.endIndex,
    text: elements.map(elementText).join("").replace(/\n$/, ""),
    listId: bullet?.listId,
    level: bullet?.nestingLevel ?? 0,
    suggested: elements.some(
      (element: any) =>
        element.textRun?.suggestedInsertionIds?.length > 0 || element.textRun?.suggestedDeletionIds?.length > 0,
    ),
  };
}

const cellParagraphs = (cell: any): Paragraph[] =>
  cell.content.filter((content: any) => content.paragraph).map(toParagraph);

export function parseRecap(read: any): Recap {
  const doc = read.content ?? read;
  for (const tab of doc.tabs ?? []) {
    for (const content of tab.documentTab?.body?.content ?? []) {
      const rows = content.table?.tableRows;
      const header = rows?.[0]?.tableCells[0] && cellParagraphs(rows[0].tableCells[0])[0]?.text;
      if (!header?.startsWith("This Week")) continue;
      return {
        revisionId: doc.revisionId,
        tabId: tab.tabProperties.tabId,
        sections: rows.slice(1).map((row: any) => {
          const thisWeek = cellParagraphs(row.tableCells[0]);
          return { name: thisWeek[0].text.trim(), thisWeek, lastWeek: cellParagraphs(row.tableCells[1]) };
        }),
      };
    }
  }
  throw new Error('No table with a "This Week" header in any tab.');
}

function findSection(recap: Recap, name: string): Section {
  const section = recap.sections.find((candidate) => sectionKey(candidate.name) === sectionKey(name));
  if (section) return section;
  throw new Error(`No section "${name}". Sections: ${recap.sections.map((s) => s.name).join(", ")}`);
}

function findBullet(section: Section, text: string): Paragraph {
  const matches = section.thisWeek.slice(1).filter((p) => p.text.trim() === text.trim());
  if (matches.length === 1) return matches[0];
  const state = matches.length === 0 ? "No" : "More than one";
  throw new Error(`${state} This Week bullet "${text}" in ${section.name}.`);
}

/** The paragraph to insert after, and the nesting level the new bullet needs. */
function locate(section: Section, edit: Edit): { anchor: Paragraph; level: number } {
  const body = section.thisWeek.slice(1);
  if (!edit.parent) return { anchor: body.filter((p) => p.listId).at(-1) ?? section.thisWeek[0], level: 0 };

  const parent = findBullet(section, edit.parent);
  let anchor = parent;
  for (const paragraph of body.slice(body.indexOf(parent) + 1)) {
    if (!paragraph.listId || paragraph.level <= parent.level) break;
    anchor = paragraph;
  }
  return { anchor, level: parent.level + 1 };
}

type Operation = { at: number; requests: object[]; growth: number; outdent?: { range: Range; level: number } };

function replaceOperation(paragraph: Paragraph, text: string, tabId: string): Operation {
  if (paragraph.end - paragraph.start - 1 !== paragraph.text.length) {
    throw new Error(`Bullet "${paragraph.text}" holds a chip, so its offsets cannot be derived from its text.`);
  }
  const from = Array.from(paragraph.text);
  const to = Array.from(text);
  const shared = Math.min(from.length, to.length);
  let head = 0;
  while (head < shared && from[head] === to[head]) head++;
  let tail = 0;
  while (tail < shared - head && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail++;

  const at = paragraph.start + from.slice(0, head).join("").length;
  const removed = from.slice(head, from.length - tail).join("");
  const added = to.slice(head, to.length - tail).join("");
  const requests: object[] = [];
  if (removed) {
    requests.push({ deleteContentRange: { range: { startIndex: at, endIndex: at + removed.length, tabId } } });
  }
  if (added) requests.push({ insertText: { location: { index: at, tabId }, text: added } });
  return { at, requests, growth: added.length - removed.length };
}

function insertOperation(insert: Insert, rebuild: boolean, tabId: string): Operation {
  const { anchor, level, items } = insert;
  const fill = anchor.listId !== undefined && anchor.text.trim() === "";
  const tabs = rebuild ? "\t".repeat(Math.max(level - anchor.level, 0)) : "";
  const lines = items.map((item) => tabs + item).join("\n");
  const text = fill ? lines : `\n${lines}`;
  const at = fill ? anchor.start : anchor.end - 1;
  const range = { startIndex: fill ? at : at + 1, endIndex: at + text.length, tabId };
  const requests: object[] = [{ insertText: { location: { index: at, tabId }, text } }];

  if (anchor.listId === undefined) {
    // A section heading is bold, and new text inherits that.
    requests.push({ updateTextStyle: { range, textStyle: { bold: false }, fields: "bold" } });
    requests.push({ createParagraphBullets: { range, bulletPreset: BULLET_PRESET } });
  }
  const outdent = rebuild && anchor.listId !== undefined && level < anchor.level ? { range, level } : undefined;
  return { at, requests, growth: text.length, outdent };
}

/** Sets a rebuilt paragraph's kept indent, which must happen after its old bullet is removed. */
function outdentRequest(operation: Operation, operations: Operation[]): object {
  const { range, level } = operation.outdent;
  const shift = operations.filter((o) => o.at < operation.at).reduce((total, o) => total + o.growth, 0);
  const paragraphStyle = {
    indentStart: { magnitude: INDENT_STEP * (level + 1), unit: "PT" },
    indentFirstLine: { magnitude: INDENT_STEP * level + INDENT_STEP / 2, unit: "PT" },
  };
  return {
    updateParagraphStyle: {
      range: { ...range, startIndex: range.startIndex + shift, endIndex: range.endIndex + shift },
      paragraphStyle,
      fields: "indentStart,indentFirstLine",
    },
  };
}

const highestFirst = (a: Operation, b: Operation) => b.at - a.at;

function sectionOperations(section: Section, edits: Edit[], tabId: string): Operation[] {
  const operations: Operation[] = [];
  const inserts = new Map<string, Insert>();

  for (const edit of edits) {
    if (edit.replace) {
      const paragraph = findBullet(section, edit.replace);
      if (paragraph.suggested) throw new Error(`Bullet "${edit.replace}" has a pending suggestion.`);
      operations.push(replaceOperation(paragraph, edit.text, tabId));
      continue;
    }
    const { anchor, level } = locate(section, edit);
    if (anchor.suggested) throw new Error(`Bullet "${anchor.text}" has a pending suggestion.`);
    const key = `${anchor.start}:${level}`;
    const insert = inserts.get(key) ?? { anchor, level, items: [] };
    insert.items.push(edit.text);
    inserts.set(key, insert);
  }

  // A new paragraph inherits its anchor's list, level, and indent, and Docs has no request that sets
  // a level inside a list. createParagraphBullets ignores tabs on bulleted paragraphs and gives a
  // paragraph that joins a list its neighbor's level. So a level change rebuilds the section's list
  // from its first bullet, where the heading above stops that merge. The rebuilt level of each
  // paragraph is then its kept indent plus its leading tabs, so existing bullets need no change.
  const rebuild = [...inserts.values()].some(({ anchor, level }) => anchor.listId && anchor.level !== level);
  operations.push(...[...inserts.values()].map((insert) => insertOperation(insert, rebuild, tabId)));
  if (!rebuild) return operations;

  const body = section.thisWeek.slice(1);
  const bullets = body.filter((p) => p.listId);
  const [first, last] = [bullets[0], bullets.at(-1)];
  if (body.slice(body.indexOf(first), body.indexOf(last)).some((p) => !p.listId)) {
    throw new Error(`${section.name} has a paragraph between its bullets, so its list cannot be rebuilt.`);
  }
  if (bullets.some((p) => p.suggested)) throw new Error(`${section.name} has a pending suggestion.`);

  const growth = operations.reduce((total, operation) => total + operation.growth, 0);
  const range = { startIndex: first.start, endIndex: last.end - 1 + growth, tabId };
  const requests = [
    ...operations.sort(highestFirst).flatMap((operation) => operation.requests),
    { deleteParagraphBullets: { range } },
    ...operations.filter((operation) => operation.outdent).map((operation) => outdentRequest(operation, operations)),
    { createParagraphBullets: { range, bulletPreset: BULLET_PRESET } },
  ];
  return [{ at: first.start, requests, growth }];
}

export function planEdits(recap: Recap, edits: Edit[]): Plan {
  const bySection = new Map<Section, Edit[]>();
  for (const edit of edits) {
    const section = findSection(recap, edit.section);
    bySection.set(section, [...(bySection.get(section) ?? []), edit]);
  }

  // Highest index first, so no request moves a position a later request relies on.
  const operations = [...bySection].flatMap(([section, list]) => sectionOperations(section, list, recap.tabId));
  return {
    requests: operations.sort(highestFirst).flatMap((operation) => operation.requests),
    writeControl: { requiredRevisionId: recap.revisionId },
  };
}

const texts = (paragraphs: Paragraph[]) => paragraphs.map((p) => p.text.trim()).filter(Boolean);

export function verifyEdits(before: Recap, after: Recap, edits: Edit[]): string[] {
  const problems: string[] = [];

  for (const section of before.sections) {
    const updated = after.sections.find((candidate) => sectionKey(candidate.name) === sectionKey(section.name));
    if (!updated) {
      problems.push(`Section ${section.name} is gone.`);
      continue;
    }
    if (texts(section.lastWeek).join("\n") !== texts(updated.lastWeek).join("\n")) {
      problems.push(`Last Week changed in ${section.name}.`);
    }
    const replaced = edits.filter((e) => e.replace && sectionKey(e.section) === sectionKey(section.name));
    const expected = new Set(replaced.map((e) => e.replace.trim()));
    for (const paragraph of section.thisWeek.filter((p) => p.text.trim() && !expected.has(p.text.trim()))) {
      const kept = updated.thisWeek.find((p) => p.text.trim() === paragraph.text.trim());
      if (!kept) problems.push(`Lost "${paragraph.text.trim()}" from ${section.name}.`);
      else if (kept.level !== paragraph.level) problems.push(`"${paragraph.text.trim()}" changed level.`);
    }
    const lists = (paragraphs: Paragraph[]) => new Set(paragraphs.flatMap((p) => p.listId ?? []));
    if (lists(section.thisWeek).size > 0 && lists(updated.thisWeek).size > lists(section.thisWeek).size) {
      problems.push(`The bullets in ${section.name} split into separate lists.`);
    }
  }

  for (const edit of edits) {
    const section = findSection(after, edit.section);
    const paragraph = section.thisWeek.slice(1).find((p) => p.text.trim() === edit.text.trim());
    if (!paragraph) {
      problems.push(`Missing "${edit.text}" in ${section.name}.`);
    } else if (!paragraph.listId) {
      problems.push(`"${edit.text}" is not a bullet.`);
    } else if (edit.parent) {
      const parent = section.thisWeek.find((p) => p.text.trim() === edit.parent.trim());
      if (!parent || paragraph.start < parent.start || paragraph.level !== parent.level + 1) {
        problems.push(`"${edit.text}" is not nested under "${edit.parent}".`);
      }
    } else if (!edit.replace && paragraph.level !== 0) {
      problems.push(`"${edit.text}" is not a top-level bullet.`);
    }
  }
  return problems;
}

export function renderRecap(recap: Recap): string {
  const bullets = (paragraphs: Paragraph[]) =>
    paragraphs.slice(1).flatMap((p) => (p.listId ? [`${"  ".repeat(p.level + 1)}- ${p.text.trim()}`] : []));
  const lines = [`revision: ${recap.revisionId}`, `tab: ${recap.tabId}`];
  for (const section of recap.sections) {
    lines.push("", `## ${section.name}`, "This Week:", ...bullets(section.thisWeek));
    lines.push("Last Week:", ...bullets(section.lastWeek));
  }
  return lines.join("\n");
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function main([command, ...args]: string[]): number {
  if (command === "show" && args.length === 1) {
    console.log(renderRecap(parseRecap(readJson(args[0]))));
    return 0;
  }
  if (command === "plan" && args.length === 2) {
    console.log(JSON.stringify(planEdits(parseRecap(readJson(args[0])), readJson(args[1])), null, 2));
    return 0;
  }
  if (command === "verify" && args.length === 3) {
    const problems = verifyEdits(parseRecap(readJson(args[0])), parseRecap(readJson(args[1])), readJson(args[2]));
    for (const problem of problems) console.log(problem);
    if (problems.length === 0) console.log("OK");
    return problems.length === 0 ? 0 : 1;
  }
  console.error(
    "Usage: doc-edits.ts show <read.json> | plan <read.json> <edits.json> | verify <before> <after> <edits>",
  );
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
