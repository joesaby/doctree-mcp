/**
 * Python source file parser
 *
 * Extracts structural symbols from Python files using regex patterns.
 * Maps classes, functions, and imports into a hierarchy compatible
 * with doctree-mcp's TreeNode model.
 *
 * Relies on indentation-based block detection (Python's natural structure).
 */

import type { CodeSymbol } from "../code-indexer";

/** Supported file extensions for this parser */
export const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);

/**
 * Parse a Python source file into code symbols.
 *
 * Extracts:
 *  - Classes (with methods as children)
 *  - Standalone functions
 *  - Import blocks
 *  - Module-level constants (UPPER_CASE assignments)
 */
export function parsePython(source: string, docId: string): CodeSymbol[] {
  const lines = source.split("\n");
  const symbols: CodeSymbol[] = [];
  let counter = 0;

  // ── Collect imports ──────────────────────────────────────────────

  let importStart = -1;
  let importEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("import ") || trimmed.startsWith("from ")) {
      if (importStart === -1) importStart = i;
      importEnd = i;
      // Handle multi-line imports with backslash or parentheses
      while (i < lines.length - 1 && (trimmed.endsWith("\\") || (trimmed.includes("(") && !trimmed.includes(")")))) {
        i++;
        importEnd = i;
      }
    } else if (importStart !== -1 && trimmed !== "" && !trimmed.startsWith("#")) {
      // End of import block
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

  // ── Find top-level symbols ──────────────────────────────────────

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments, empty lines, imports (already captured)
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("import ") || trimmed.startsWith("from ")) continue;

    // Check indentation — top-level symbols have 0 indent
    const indent = line.length - line.trimStart().length;
    if (indent > 0) continue;

    // --- Decorators ---
    let decorators: string[] = [];
    let decoratorStart = i;
    if (trimmed.startsWith("@")) {
      while (i < lines.length && lines[i].trim().startsWith("@")) {
        decorators.push(lines[i].trim());
        i++;
      }
      // Now lines[i] should be the class/function definition
      if (i >= lines.length) break;
    }

    const currentLine = lines[i];
    const currentTrimmed = currentLine.trim();

    // --- Class declaration ---
    const classMatch = currentTrimmed.match(/^class\s+(\w+)(?:\s*\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const name = classMatch[1];
      const bases = classMatch[2] || "";
      const blockEnd = findPythonBlockEnd(lines, i);
      counter++;
      const classId = `${docId}:n${counter}`;
      const classBody = lines.slice(decoratorStart, blockEnd + 1).join("\n");
      const childIds: string[] = [];

      // Parse class methods
      const methods = parseClassMethods(lines, i + 1, blockEnd, docId, classId, counter);
      counter += methods.length;
      for (const m of methods) childIds.push(m.id);

      const sig = decorators.length > 0
        ? `${decorators.join("\n")}\nclass ${name}(${bases})`
        : `class ${name}(${bases})`;

      symbols.push({
        id: classId,
        name,
        kind: "class",
        signature: sig,
        content: classBody,
        line_start: decoratorStart + 1,
        line_end: blockEnd + 1,
        exported: !name.startsWith("_"),
        children_ids: childIds,
        parent_id: null,
      });
      symbols.push(...methods);
      i = blockEnd;
      continue;
    }

    // --- Function declaration ---
    const funcMatch = currentTrimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
    if (funcMatch) {
      const name = funcMatch[1];
      const blockEnd = findPythonBlockEnd(lines, i);
      counter++;

      const sig = decorators.length > 0
        ? `${decorators.join("\n")}\n${buildPythonFuncSignature(lines, i)}`
        : buildPythonFuncSignature(lines, i);

      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "function",
        signature: sig,
        content: lines.slice(decoratorStart, blockEnd + 1).join("\n"),
        line_start: decoratorStart + 1,
        line_end: blockEnd + 1,
        exported: !name.startsWith("_"),
        children_ids: [],
        parent_id: null,
      });
      i = blockEnd;
      continue;
    }

    // --- Module-level constant (UPPER_CASE = ...) ---
    const constMatch = currentTrimmed.match(/^([A-Z][A-Z0-9_]+)\s*(?::\s*\S+\s*)?=/);
    if (constMatch) {
      const name = constMatch[1];
      let endLine = i;
      // Multi-line values (dict, list, tuple)
      if (currentTrimmed.includes("{") || currentTrimmed.includes("[") || currentTrimmed.includes("(")) {
        endLine = findPythonExprEnd(lines, i);
      }
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "variable",
        signature: currentTrimmed,
        content: lines.slice(i, endLine + 1).join("\n"),
        line_start: i + 1,
        line_end: endLine + 1,
        exported: true,
        children_ids: [],
        parent_id: null,
      });
      i = endLine;
      continue;
    }
  }

  return symbols;
}

// ── Class method parsing ──────────────────────────────────────────────

function parseClassMethods(
  lines: string[],
  startLine: number,
  endLine: number,
  docId: string,
  parentId: string,
  baseCounter: number,
): CodeSymbol[] {
  const methods: CodeSymbol[] = [];
  let counter = baseCounter;

  // Determine the class body indentation level
  let classIndent = -1;
  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    classIndent = line.length - line.trimStart().length;
    break;
  }
  if (classIndent < 0) return methods;

  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    if (indent !== classIndent) continue;

    // Collect decorators
    let decorators: string[] = [];
    let decoratorStart = i;
    while (trimmed.startsWith("@") || lines[i]?.trim().startsWith("@")) {
      decorators.push(lines[i].trim());
      i++;
      if (i > endLine) break;
    }
    if (i > endLine) break;

    const methodLine = lines[i]?.trim() || "";
    const methodMatch = methodLine.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
    if (methodMatch) {
      const name = methodMatch[1];
      const blockEnd = Math.min(findPythonBlockEnd(lines, i), endLine);
      counter++;

      const sig = decorators.length > 0
        ? `${decorators.join("\n")}\n${buildPythonFuncSignature(lines, i)}`
        : buildPythonFuncSignature(lines, i);

      methods.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "method",
        signature: sig,
        content: lines.slice(decoratorStart, blockEnd + 1).join("\n"),
        line_start: decoratorStart + 1,
        line_end: blockEnd + 1,
        exported: !name.startsWith("_"),
        children_ids: [],
        parent_id: parentId,
      });
      i = blockEnd;
    }
  }

  return methods;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Find the end of a Python indented block.
 * The block ends when indentation returns to the same level or lower.
 */
function findPythonBlockEnd(lines: string[], defLine: number): number {
  const defIndent = lines[defLine].length - lines[defLine].trimStart().length;
  let lastContentLine = defLine;

  for (let i = defLine + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip blank lines and comments — they don't end blocks
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    if (indent <= defIndent) {
      // We've exited the block — return the last content line
      return lastContentLine;
    }
    lastContentLine = i;
  }

  return lastContentLine;
}

/**
 * Find the end of a multi-line expression (dict, list, tuple).
 */
function findPythonExprEnd(lines: string[], startLine: number): number {
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      if (ch === ")" || ch === "]" || ch === "}") depth--;
    }
    if (depth <= 0 && i > startLine) return i;
  }
  return startLine;
}

/**
 * Build a function signature from the def line (may span multiple lines).
 */
function buildPythonFuncSignature(lines: string[], defLine: number): string {
  let sig = lines[defLine].trim();
  // Multi-line parameters
  if (!sig.includes("):") && !sig.includes(") ->")) {
    for (let i = defLine + 1; i < Math.min(defLine + 10, lines.length); i++) {
      sig += " " + lines[i].trim();
      if (lines[i].includes("):") || lines[i].includes(") ->") || lines[i].trim().endsWith(":")) {
        break;
      }
    }
  }
  // Remove body — just the signature
  return sig.replace(/:\s*$/, "").trim();
}
