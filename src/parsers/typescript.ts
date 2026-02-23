/**
 * TypeScript / JavaScript AST-like parser
 *
 * Extracts structural symbols from TS/JS source files using regex patterns.
 * Maps classes, interfaces, functions, types, and enums into a hierarchy
 * compatible with doctree-mcp's TreeNode model.
 *
 * No external dependencies — pure regex extraction for zero-overhead indexing.
 */

import type { CodeSymbol } from "../code-indexer";

/** Supported file extensions for this parser */
export const TYPESCRIPT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
]);

/**
 * Parse a TypeScript/JavaScript source file into code symbols.
 *
 * Extracts:
 *  - Classes (with methods as children)
 *  - Interfaces (with properties/methods as children)
 *  - Standalone functions (function declarations + arrow const)
 *  - Type aliases
 *  - Enums
 *  - Top-level const/let/var exports
 */
export function parseTypeScript(source: string, docId: string): CodeSymbol[] {
  const lines = source.split("\n");
  const symbols: CodeSymbol[] = [];
  let counter = 0;

  // Track brace depth for finding block boundaries
  function findBlockEnd(startLine: number): number {
    let depth = 0;
    let foundOpen = false;
    for (let i = startLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; foundOpen = true; }
        if (ch === "}") { depth--; }
        if (foundOpen && depth === 0) return i;
      }
    }
    return lines.length - 1;
  }

  // Pass 1: Find top-level symbols
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed === "") continue;

    // --- Imports block (grouped) ---
    if (/^(?:import\s|import\{)/.test(trimmed)) {
      const importStart = i;
      // Consume consecutive import lines
      while (i < lines.length - 1 && /^\s*import[\s{]/.test(lines[i + 1].trim())) {
        i++;
      }
      // Handle multi-line imports
      while (i < lines.length - 1 && !lines[i].includes(";") && !lines[i + 1].trim().startsWith("import")) {
        i++;
      }
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name: "imports",
        kind: "import",
        signature: `${lines.slice(importStart, i + 1).length} import statements`,
        content: lines.slice(importStart, i + 1).join("\n"),
        line_start: importStart + 1,
        line_end: i + 1,
        exported: false,
        children_ids: [],
        parent_id: null,
      });
      continue;
    }

    // --- Class declaration ---
    const classMatch = trimmed.match(
      /^(export\s+)?((?:abstract\s+)?class)\s+(\w+)(?:\s+extends\s+[\w.<>,\s]+)?(?:\s+implements\s+[\w.<>,\s]+)?\s*\{?/
    );
    if (classMatch) {
      const exported = !!classMatch[1];
      const name = classMatch[3];
      const blockEnd = findBlockEnd(i);
      counter++;
      const classId = `${docId}:n${counter}`;
      const classBody = lines.slice(i, blockEnd + 1).join("\n");
      const childIds: string[] = [];

      // Parse class members
      const members = parseClassMembers(lines, i + 1, blockEnd, docId, classId, counter);
      counter += members.length;
      for (const m of members) childIds.push(m.id);

      symbols.push({
        id: classId,
        name,
        kind: "class",
        signature: extractSignature(trimmed),
        content: classBody,
        line_start: i + 1,
        line_end: blockEnd + 1,
        exported,
        children_ids: childIds,
        parent_id: null,
      });
      symbols.push(...members);
      i = blockEnd;
      continue;
    }

    // --- Interface declaration ---
    const ifaceMatch = trimmed.match(
      /^(export\s+)?interface\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+[\w.<>,\s]+)?\s*\{?/
    );
    if (ifaceMatch) {
      const exported = !!ifaceMatch[1];
      const name = ifaceMatch[2];
      const blockEnd = findBlockEnd(i);
      counter++;
      const ifaceId = `${docId}:n${counter}`;
      const ifaceBody = lines.slice(i, blockEnd + 1).join("\n");
      const childIds: string[] = [];

      const members = parseInterfaceMembers(lines, i + 1, blockEnd, docId, ifaceId, counter);
      counter += members.length;
      for (const m of members) childIds.push(m.id);

      symbols.push({
        id: ifaceId,
        name,
        kind: "interface",
        signature: extractSignature(trimmed),
        content: ifaceBody,
        line_start: i + 1,
        line_end: blockEnd + 1,
        exported,
        children_ids: childIds,
        parent_id: null,
      });
      symbols.push(...members);
      i = blockEnd;
      continue;
    }

    // --- Type alias ---
    const typeMatch = trimmed.match(/^(export\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=/);
    if (typeMatch) {
      const exported = !!typeMatch[1];
      const name = typeMatch[2];
      // Type can span multiple lines if it uses { ... }
      let endLine = i;
      if (trimmed.includes("{")) {
        endLine = findBlockEnd(i);
      } else {
        while (endLine < lines.length - 1 && !lines[endLine].includes(";")) endLine++;
      }
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "type",
        signature: extractSignature(trimmed),
        content: lines.slice(i, endLine + 1).join("\n"),
        line_start: i + 1,
        line_end: endLine + 1,
        exported,
        children_ids: [],
        parent_id: null,
      });
      i = endLine;
      continue;
    }

    // --- Enum declaration ---
    const enumMatch = trimmed.match(/^(export\s+)?(const\s+)?enum\s+(\w+)\s*\{?/);
    if (enumMatch) {
      const exported = !!enumMatch[1];
      const name = enumMatch[3];
      const blockEnd = findBlockEnd(i);
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "enum",
        signature: extractSignature(trimmed),
        content: lines.slice(i, blockEnd + 1).join("\n"),
        line_start: i + 1,
        line_end: blockEnd + 1,
        exported,
        children_ids: [],
        parent_id: null,
      });
      i = blockEnd;
      continue;
    }

    // --- Function declaration ---
    const funcMatch = trimmed.match(
      /^(export\s+)?((?:async\s+)?function\*?)\s+(\w+)\s*(?:<[^>]+>)?\s*\(/
    );
    if (funcMatch) {
      const exported = !!funcMatch[1];
      const name = funcMatch[3];
      const blockEnd = findBlockEnd(i);
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "function",
        signature: buildFunctionSignature(lines, i, blockEnd),
        content: lines.slice(i, blockEnd + 1).join("\n"),
        line_start: i + 1,
        line_end: blockEnd + 1,
        exported,
        children_ids: [],
        parent_id: null,
      });
      i = blockEnd;
      continue;
    }

    // --- Arrow function const ---
    const arrowMatch = trimmed.match(
      /^(export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*(?::\s*[^=]+)?\s*=>/
    );
    if (arrowMatch) {
      const exported = !!arrowMatch[1];
      const name = arrowMatch[2];
      // Find end: either next top-level declaration or semicolon at depth 0
      const blockEnd = findArrowEnd(lines, i);
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "function",
        signature: extractSignature(trimmed),
        content: lines.slice(i, blockEnd + 1).join("\n"),
        line_start: i + 1,
        line_end: blockEnd + 1,
        exported,
        children_ids: [],
        parent_id: null,
      });
      i = blockEnd;
      continue;
    }

    // --- Exported const (non-arrow) ---
    const constMatch = trimmed.match(
      /^export\s+(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=/
    );
    if (constMatch && !arrowMatch) {
      const name = constMatch[1];
      let endLine = i;
      if (trimmed.includes("{")) {
        endLine = findBlockEnd(i);
      } else if (trimmed.includes("[")) {
        // Array literal — find closing bracket
        let depth = 0;
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if (ch === "[") depth++;
            if (ch === "]") depth--;
          }
          if (depth <= 0) { endLine = j; break; }
        }
      } else {
        while (endLine < lines.length - 1 && !lines[endLine].trimEnd().endsWith(";")) endLine++;
      }
      counter++;
      symbols.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "variable",
        signature: extractSignature(trimmed),
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

// ── Class member parsing ──────────────────────────────────────────────

function parseClassMembers(
  lines: string[],
  startLine: number,
  endLine: number,
  docId: string,
  parentId: string,
  baseCounter: number,
): CodeSymbol[] {
  const members: CodeSymbol[] = [];
  let counter = baseCounter;

  for (let i = startLine; i < endLine; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed === "{" || trimmed === "}") continue;

    // Method (including async, static, get/set, private/protected/public)
    const methodMatch = trimmed.match(
      /^(?:(?:private|protected|public|static|abstract|async|override|readonly)\s+)*(?:get\s+|set\s+)?(\w+)\s*(?:<[^>]+>)?\s*\(/
    );
    if (methodMatch && !trimmed.match(/^(?:if|for|while|switch|catch)\s*\(/)) {
      const name = methodMatch[1];
      // Constructor special case
      const isConstructor = name === "constructor";
      const methodEnd = findMethodEnd(lines, i);
      counter++;
      members.push({
        id: `${docId}:n${counter}`,
        name: isConstructor ? "constructor" : name,
        kind: "method",
        signature: buildFunctionSignature(lines, i, methodEnd),
        content: lines.slice(i, methodEnd + 1).join("\n"),
        line_start: i + 1,
        line_end: methodEnd + 1,
        exported: false,
        children_ids: [],
        parent_id: parentId,
      });
      i = methodEnd;
      continue;
    }

    // Property declaration (field)
    const propMatch = trimmed.match(
      /^(?:(?:private|protected|public|static|readonly|abstract|override)\s+)*(\w+)[\?!]?\s*(?::\s*[^=;]+)?(?:\s*=\s*[^;]+)?;?\s*$/
    );
    if (propMatch && !trimmed.startsWith("//") && !trimmed.startsWith("*")) {
      const name = propMatch[1];
      // Skip if it looks like a keyword
      if (["return", "break", "continue", "throw", "if", "else", "for", "while", "const", "let", "var"].includes(name)) continue;
      counter++;
      members.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "property",
        signature: trimmed.replace(/;?\s*$/, ""),
        content: trimmed,
        line_start: i + 1,
        line_end: i + 1,
        exported: false,
        children_ids: [],
        parent_id: parentId,
      });
    }
  }

  return members;
}

// ── Interface member parsing ──────────────────────────────────────────

function parseInterfaceMembers(
  lines: string[],
  startLine: number,
  endLine: number,
  docId: string,
  parentId: string,
  baseCounter: number,
): CodeSymbol[] {
  const members: CodeSymbol[] = [];
  let counter = baseCounter;

  for (let i = startLine; i < endLine; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed === "{" || trimmed === "}" || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // Interface method signature
    const methodMatch = trimmed.match(/^(?:readonly\s+)?(\w+)\s*(?:<[^>]+>)?\s*\(/);
    if (methodMatch) {
      const name = methodMatch[1];
      counter++;
      members.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "method",
        signature: trimmed.replace(/;?\s*$/, ""),
        content: trimmed,
        line_start: i + 1,
        line_end: i + 1,
        exported: false,
        children_ids: [],
        parent_id: parentId,
      });
      continue;
    }

    // Interface property
    const propMatch = trimmed.match(/^(?:readonly\s+)?(\w+)[\?!]?\s*:/);
    if (propMatch) {
      const name = propMatch[1];
      counter++;
      members.push({
        id: `${docId}:n${counter}`,
        name,
        kind: "property",
        signature: trimmed.replace(/;?\s*$/, ""),
        content: trimmed,
        line_start: i + 1,
        line_end: i + 1,
        exported: false,
        children_ids: [],
        parent_id: parentId,
      });
    }
  }

  return members;
}

// ── Helpers ───────────────────────────────────────────────────────────

function findMethodEnd(lines: string[], startLine: number): number {
  let depth = 0;
  let foundOpen = false;

  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; foundOpen = true; }
      if (ch === "}") depth--;
      if (foundOpen && depth === 0) return i;
    }
    // Single-line abstract method or interface method
    if (!foundOpen && lines[i].trim().endsWith(";")) return i;
  }
  return startLine;
}

function findArrowEnd(lines: string[], startLine: number): number {
  const trimmed = lines[startLine].trim();

  // Single-line arrow: const x = () => expr;
  if (trimmed.endsWith(";")) return startLine;

  // Arrow with block body
  if (trimmed.includes("{") || (startLine + 1 < lines.length && lines[startLine + 1].trim().startsWith("{"))) {
    let depth = 0;
    let foundOpen = false;
    for (let i = startLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; foundOpen = true; }
        if (ch === "}") depth--;
        if (foundOpen && depth === 0) return i;
      }
    }
  }

  // Multi-line expression arrow
  let parenDepth = 0;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "(") parenDepth++;
      if (ch === ")") parenDepth--;
    }
    if (lines[i].trim().endsWith(";") && parenDepth <= 0) return i;
  }

  return startLine;
}

function extractSignature(line: string): string {
  // Clean up the first line as a signature
  return line.replace(/\{?\s*$/, "").trim();
}

function buildFunctionSignature(lines: string[], start: number, end: number): string {
  // Capture from function/method start through closing paren + return type
  let sig = "";
  for (let i = start; i <= Math.min(start + 5, end); i++) {
    sig += lines[i] + "\n";
    if (lines[i].includes("{")) {
      // Found the opening brace — signature ends before it
      sig = sig.replace(/\{[^}]*$/, "").trim();
      break;
    }
  }
  return sig.trim() || lines[start].trim();
}
