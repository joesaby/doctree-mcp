/**
 * Generic source file parser (fallback)
 *
 * Extracts structural symbols from source files using language-agnostic
 * regex patterns. Works for Go, Rust, Java, C#, Ruby, and other languages
 * with common declaration syntax.
 *
 * Less precise than language-specific parsers, but provides reasonable
 * tree navigation for any brace-delimited or indentation-based language.
 */

import type { CodeSymbol } from "../code-indexer";

/** Language detection from file extension */
export const GENERIC_EXTENSIONS = new Set([
  ".go", ".rs", ".java", ".kt", ".scala",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs", ".rb", ".swift", ".php",
  ".lua", ".r", ".R", ".sh", ".bash", ".zsh",
]);

/**
 * Detect language from file extension for tuned pattern matching.
 */
type Lang = "go" | "rust" | "java" | "c" | "ruby" | "shell" | "other";

function detectLang(ext: string): Lang {
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if ([".java", ".kt", ".scala", ".cs"].includes(ext)) return "java";
  if ([".c", ".cpp", ".cc", ".h", ".hpp"].includes(ext)) return "c";
  if (ext === ".rb") return "ruby";
  if ([".sh", ".bash", ".zsh"].includes(ext)) return "shell";
  return "other";
}

/**
 * Parse a source file using generic patterns.
 */
export function parseGeneric(source: string, docId: string, ext: string): CodeSymbol[] {
  const lines = source.split("\n");
  const symbols: CodeSymbol[] = [];
  let counter = 0;
  const lang = detectLang(ext);

  // ── Collect import block ────────────────────────────────────────

  const importPatterns: Record<Lang, RegExp> = {
    go: /^(?:import\s|import\s*\()/,
    rust: /^(?:use\s|extern\s+crate)/,
    java: /^(?:import\s|package\s)/,
    c: /^#\s*include\s/,
    ruby: /^(?:require\s|require_relative\s|include\s)/,
    shell: /^(?:source\s|\.(?:\s|\/))/,
    other: /^(?:import\s|#\s*include|require\s|use\s)/,
  };

  const importRegex = importPatterns[lang];
  let importStart = -1;
  let importEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (importRegex.test(trimmed)) {
      if (importStart === -1) importStart = i;
      importEnd = i;
      // Handle Go grouped imports: import ( ... )
      if (trimmed.includes("(") && !trimmed.includes(")")) {
        while (i < lines.length - 1 && !lines[i].includes(")")) {
          i++;
          importEnd = i;
        }
      }
    } else if (importStart !== -1 && trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("#")) {
      break;
    }
  }

  if (importStart !== -1) {
    counter++;
    symbols.push({
      id: `${docId}:n${counter}`,
      name: "imports",
      kind: "import",
      signature: `${importEnd - importStart + 1} import statements`,
      content: lines.slice(importStart, importEnd + 1).join("\n"),
      line_start: importStart + 1,
      line_end: importEnd + 1,
      exported: false,
      children_ids: [],
      parent_id: null,
    });
  }

  // ── Top-level declarations ──────────────────────────────────────

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;

    // Skip indented lines (not top-level)
    const indent = line.length - line.trimStart().length;
    if (indent > 0 && lang !== "java") continue;

    // --- Struct/class ---
    const structMatch =
      trimmed.match(/^(?:pub\s+)?(?:export\s+)?(?:abstract\s+)?(?:struct|class|data\s+class|object)\s+(\w+)/) ||
      (lang === "go" && trimmed.match(/^type\s+(\w+)\s+struct\b/)) ||
      (lang === "ruby" && trimmed.match(/^class\s+(\w+)/));

    if (structMatch) {
      const name = structMatch[1];
      const blockEnd = lang === "ruby" ? findRubyBlockEnd(lines, i) : findBraceBlockEnd(lines, i);
      counter++;
      const structId = `${docId}:n${counter}`;
      const childIds: string[] = [];

      // Parse members for brace-delimited languages
      const members = parseGenericMembers(lines, i + 1, blockEnd, docId, structId, counter, lang);
      counter += members.length;
      for (const m of members) childIds.push(m.id);

      symbols.push({
        id: structId,
        name,
        kind: "class",
        signature: trimmed.replace(/\{?\s*$/, "").trim(),
        content: lines.slice(i, blockEnd + 1).join("\n"),
        line_start: i + 1,
        line_end: blockEnd + 1,
        exported: isExported(trimmed, lang, name),
        children_ids: childIds,
        parent_id: null,
      });
      symbols.push(...members);
      i = blockEnd;
      continue;
    }

    // --- Interface / trait ---
    const ifaceMatch =
      trimmed.match(/^(?:pub\s+)?(?:export\s+)?(?:interface|trait|protocol)\s+(\w+)/) ||
      (lang === "go" && trimmed.match(/^type\s+(\w+)\s+interface\b/));

    if (ifaceMatch) {
      const name = ifaceMatch[1];
      const blockEnd = findBraceBlockEnd(lines, i);
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "interface",
        signature: trimmed.replace(/\{?\s*$/, "").trim(),
        content: lines.slice(i, blockEnd + 1).join("\n"),
        line_start: i + 1,
        line_end: blockEnd + 1,
        exported: isExported(trimmed, lang, name),
        children_ids: [],
        parent_id: null,
      });
      i = blockEnd;
      continue;
    }

    // --- Enum ---
    const enumMatch = trimmed.match(/^(?:pub\s+)?(?:export\s+)?enum\s+(\w+)/);
    if (enumMatch) {
      const name = enumMatch[1];
      const blockEnd = findBraceBlockEnd(lines, i);
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "enum",
        signature: trimmed.replace(/\{?\s*$/, "").trim(),
        content: lines.slice(i, blockEnd + 1).join("\n"),
        line_start: i + 1,
        line_end: blockEnd + 1,
        exported: isExported(trimmed, lang, name),
        children_ids: [],
        parent_id: null,
      });
      i = blockEnd;
      continue;
    }

    // --- Function / method ---
    const funcMatch =
      trimmed.match(/^(?:pub\s+)?(?:(?:async\s+)?fn|func|function|def|sub)\s+(\w+)\s*(?:<[^>]+>)?\s*\(/) ||
      (lang === "go" && trimmed.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/)) ||
      (lang === "ruby" && trimmed.match(/^def\s+(\w+)/)) ||
      (lang === "shell" && trimmed.match(/^(?:function\s+)?(\w+)\s*\(\s*\)/));

    if (funcMatch) {
      const name = funcMatch[1];
      const blockEnd = lang === "ruby" ? findRubyBlockEnd(lines, i) : findBraceBlockEnd(lines, i);
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "function",
        signature: trimmed.replace(/\{?\s*$/, "").trim(),
        content: lines.slice(i, blockEnd + 1).join("\n"),
        line_start: i + 1,
        line_end: blockEnd + 1,
        exported: isExported(trimmed, lang, name),
        children_ids: [],
        parent_id: null,
      });
      i = blockEnd;
      continue;
    }

    // --- Constant / type alias ---
    const constMatch =
      (lang === "go" && trimmed.match(/^(?:var|const)\s+(\w+)/)) ||
      (lang === "rust" && trimmed.match(/^(?:pub\s+)?(?:const|static|type)\s+(\w+)/));

    if (constMatch) {
      const name = constMatch[1];
      let endLine = i;
      if (trimmed.includes("{")) {
        endLine = findBraceBlockEnd(lines, i);
      } else {
        while (endLine < lines.length - 1 && !lines[endLine].trimEnd().match(/[;)]/)) endLine++;
      }
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "variable",
        signature: trimmed,
        content: lines.slice(i, endLine + 1).join("\n"),
        line_start: i + 1,
        line_end: endLine + 1,
        exported: isExported(trimmed, lang, name),
        children_ids: [],
        parent_id: null,
      });
      i = endLine;
      continue;
    }
  }

  return symbols;
}

// ── Member parsing ────────────────────────────────────────────────────

function parseGenericMembers(
  lines: string[],
  startLine: number,
  endLine: number,
  docId: string,
  parentId: string,
  baseCounter: number,
  lang: Lang,
): CodeSymbol[] {
  const members: CodeSymbol[] = [];
  let counter = baseCounter;

  for (let i = startLine; i < endLine; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed === "{" || trimmed === "}" || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // Method / function inside struct/class
    const methodMatch =
      trimmed.match(/^(?:pub\s+)?(?:(?:async\s+)?fn|func|function|def)\s+(\w+)\s*\(/) ||
      (lang === "go" && trimmed.match(/^func\s+(\w+)\s*\(/)) ||
      (lang === "ruby" && trimmed.match(/^def\s+(\w+)/));

    if (methodMatch) {
      const name = methodMatch[1];
      const blockEnd = Math.min(
        lang === "ruby" ? findRubyBlockEnd(lines, i) : findBraceBlockEnd(lines, i),
        endLine
      );
      counter++;
      members.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "method",
        signature: trimmed.replace(/\{?\s*$/, "").trim(),
        content: lines.slice(i, blockEnd + 1).join("\n"),
        line_start: i + 1,
        line_end: blockEnd + 1,
        exported: isExported(trimmed, lang, name),
        children_ids: [],
        parent_id: parentId,
      });
      i = blockEnd;
    }
  }

  return members;
}

// ── Block boundary detection ──────────────────────────────────────────

function findBraceBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let foundOpen = false;

  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; foundOpen = true; }
      if (ch === "}") depth--;
      if (foundOpen && depth === 0) return i;
    }
  }
  return startLine;
}

function findRubyBlockEnd(lines: string[], startLine: number): number {
  let depth = 1;
  for (let i = startLine + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^(?:class|module|def|do|if|unless|while|until|for|case|begin)\b/.test(trimmed)) depth++;
    if (trimmed === "end" || trimmed.startsWith("end ")) depth--;
    if (depth <= 0) return i;
  }
  return lines.length - 1;
}

// ── Export detection ──────────────────────────────────────────────────

function isExported(line: string, lang: Lang, name: string): boolean {
  switch (lang) {
    case "go":
      return /^[A-Z]/.test(name); // Go: uppercase = exported
    case "rust":
      return line.includes("pub ");
    case "java":
      return line.includes("public ");
    case "ruby":
      return !name.startsWith("_");
    default:
      return line.includes("export ") || line.includes("pub ") || line.includes("public ");
  }
}
