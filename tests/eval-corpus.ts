/**
 * Comprehensive Evaluation Harness for doctree-mcp
 *
 * Generates ~10,000 test questions from the actual sbc-docs corpus
 * and evaluates searchDocuments, findSymbol, and findFiles.
 *
 * Question strategies:
 *   1. Title queries        — section title as search query
 *   2. Content extract      — key phrases from section content
 *   3. Description queries  — doc description as search query
 *   4. Path queries         — filename fragments (tests glob fallback)
 *   5. Multi-term (same doc)— combined terms from 2 sections in one doc
 *   6. Cross-doc            — combined terms from 2 different docs
 *   7. Fuzzy (symbol)       — typos in heading titles
 *   8. Negatives            — random strings that should return nothing
 *
 * Metrics:
 *   - Hit@1, Hit@5, Hit@10  — expected doc in top k?
 *   - MRR                   — Mean Reciprocal Rank
 *   - Node accuracy         — exact node_id match rate
 *   - Glob fallback rate    — how often glob results appear
 *   - Symbol hit rate       — findSymbol accuracy
 *
 * Usage:
 *   DOCS_ROOT=/path/to/docs bun run tests/eval-corpus.ts
 *   DOCS_ROOT=/path/to/docs bun run tests/eval-corpus.ts --limit=1000
 *   DOCS_ROOT=/path/to/docs bun run tests/eval-corpus.ts --output=results.json
 */

import { DocumentStore } from "../src/store";
import { indexAllCollections } from "../src/indexer";
import { singleRootConfig } from "../src/types";
import type { IndexedDocument, SearchResult, TreeNode } from "../src/types";

// ── Configuration ────────────────────────────────────────────────────

const DOCS_ROOT =
  process.env.DOCS_ROOT || "/Users/josesebastian/git/sbc-docs/src/content/docs";
const TARGET_QUESTIONS = parseInt(
  process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] || "10000"
);
const OUTPUT_FILE =
  process.argv.find((a) => a.startsWith("--output="))?.split("=")[1] ||
  "eval-results.json";
const VERBOSE = process.argv.includes("--verbose");

// ── Types ────────────────────────────────────────────────────────────

interface Question {
  id: number;
  strategy: string;
  query: string;
  expected_doc_id: string;
  expected_node_id?: string;
  expected_file_path?: string;
  difficulty: "easy" | "medium" | "hard";
}

interface EvalResult {
  question: Question;
  tool: "search" | "symbol" | "files";
  hit_at_1: boolean;
  hit_at_5: boolean;
  hit_at_10: boolean;
  reciprocal_rank: number; // 1/rank or 0 if not found
  node_match: boolean;
  result_count: number;
  glob_fallback_used: boolean;
  top_result_score: number;
  elapsed_ms: number;
}

interface EvalReport {
  corpus: {
    docs_root: string;
    document_count: number;
    total_nodes: number;
    indexed_terms: number;
  };
  questions: {
    total: number;
    by_strategy: Record<string, number>;
    by_difficulty: Record<string, number>;
  };
  metrics: {
    overall: MetricSet;
    by_strategy: Record<string, MetricSet>;
    by_difficulty: Record<string, MetricSet>;
    by_tool: Record<string, MetricSet>;
  };
  timing: {
    index_ms: number;
    eval_ms: number;
    avg_query_ms: number;
    p50_query_ms: number;
    p95_query_ms: number;
    p99_query_ms: number;
  };
  glob_fallback: {
    total_triggered: number;
    pct_of_searches: number;
    hit_rate_when_triggered: number;
  };
}

interface MetricSet {
  count: number;
  hit_at_1: number;
  hit_at_5: number;
  hit_at_10: number;
  mrr: number;
  node_accuracy: number;
}

// ── Question Generation ──────────────────────────────────────────────

function generateQuestions(docs: IndexedDocument[]): Question[] {
  const questions: Question[] = [];
  let id = 0;

  const allDocs = docs.filter((d) => d.tree.length > 0);
  const allNodes: { doc: IndexedDocument; node: TreeNode }[] = [];
  for (const doc of allDocs) {
    for (const node of doc.tree) {
      if (node.content.trim().length > 20) {
        allNodes.push({ doc, node });
      }
    }
  }

  // Shuffle helper
  const shuffle = <T>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // Extract meaningful words from text
  const extractTerms = (text: string, min = 3): string[] =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s\-_]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= min && !STOPWORDS.has(w));

  // Pick random N from array
  const pickN = <T>(arr: T[], n: number): T[] => shuffle(arr).slice(0, n);

  // Budget per strategy (proportional to TARGET_QUESTIONS)
  const budget = (pct: number) => Math.floor((TARGET_QUESTIONS * pct) / 100);

  // ── Strategy 1: Title queries (30%) ────────────────────────────
  // Use the section heading title as the search query.
  // Ground truth: that section's doc_id + node_id.
  {
    const count = budget(30);
    const selected = pickN(allNodes, count);
    for (const { doc, node } of selected) {
      if (node.title.length < 3) continue;
      questions.push({
        id: id++,
        strategy: "title_query",
        query: node.title,
        expected_doc_id: doc.meta.doc_id,
        expected_node_id: node.node_id,
        difficulty: "easy",
      });
    }
  }

  // ── Strategy 2: Content extract (20%) ──────────────────────────
  // Take 2-4 consecutive meaningful words from section content.
  {
    const count = budget(20);
    const selected = pickN(allNodes, count);
    for (const { doc, node } of selected) {
      const terms = extractTerms(node.content);
      if (terms.length < 3) continue;
      // Pick a random starting point and take 2-4 words
      const start = Math.floor(Math.random() * Math.max(1, terms.length - 4));
      const len = 2 + Math.floor(Math.random() * 3);
      const queryTerms = terms.slice(start, start + len);
      if (queryTerms.length < 2) continue;
      questions.push({
        id: id++,
        strategy: "content_extract",
        query: queryTerms.join(" "),
        expected_doc_id: doc.meta.doc_id,
        expected_node_id: node.node_id,
        difficulty: "medium",
      });
    }
  }

  // ── Strategy 3: Description queries (10%) ──────────────────────
  // Use document description as the query.
  {
    const count = budget(10);
    const docsWithDesc = allDocs.filter(
      (d) => d.meta.description.length > 20
    );
    const selected = pickN(docsWithDesc, count);
    for (const doc of selected) {
      const terms = extractTerms(doc.meta.description);
      if (terms.length < 2) continue;
      const queryTerms = pickN(terms, Math.min(4, terms.length));
      questions.push({
        id: id++,
        strategy: "description_query",
        query: queryTerms.join(" "),
        expected_doc_id: doc.meta.doc_id,
        difficulty: "easy",
      });
    }
  }

  // ── Strategy 4: Path queries (10%) ─────────────────────────────
  // Use filename/path fragments — tests glob fallback behavior.
  {
    const count = budget(10);
    const selected = pickN(allDocs, count);
    for (const doc of selected) {
      // Extract meaningful path segments
      const segments = doc.meta.file_path
        .replace(/\.md$/, "")
        .split("/")
        .filter((s) => s.length >= 3 && !["src", "content", "docs", "index"].includes(s));
      if (segments.length === 0) continue;
      const queryTerms = segments.slice(-2).join(" ");
      questions.push({
        id: id++,
        strategy: "path_query",
        query: queryTerms,
        expected_doc_id: doc.meta.doc_id,
        expected_file_path: doc.meta.file_path,
        difficulty: "medium",
      });
    }
  }

  // ── Strategy 5: Multi-term same doc (10%) ──────────────────────
  // Combine terms from 2 different sections in the same document.
  {
    const count = budget(10);
    const multiNodeDocs = allDocs.filter((d) => d.tree.length >= 3);
    const selected = pickN(multiNodeDocs, count);
    for (const doc of selected) {
      const nodes = pickN(doc.tree.filter((n) => n.title.length >= 3), 2);
      if (nodes.length < 2) continue;
      const t1 = extractTerms(nodes[0].title).slice(0, 2);
      const t2 = extractTerms(nodes[1].title).slice(0, 2);
      if (t1.length === 0 || t2.length === 0) continue;
      questions.push({
        id: id++,
        strategy: "multi_term_same_doc",
        query: [...t1, ...t2].join(" "),
        expected_doc_id: doc.meta.doc_id,
        difficulty: "medium",
      });
    }
  }

  // ── Strategy 6: Cross-doc queries (8%) ─────────────────────────
  // Combine terms from 2 different documents.
  {
    const count = budget(8);
    for (let i = 0; i < count && allDocs.length >= 2; i++) {
      const [doc1, doc2] = pickN(allDocs, 2);
      const t1 = extractTerms(doc1.meta.title).slice(0, 2);
      const t2 = extractTerms(doc2.meta.title).slice(0, 2);
      if (t1.length === 0 || t2.length === 0) continue;
      questions.push({
        id: id++,
        strategy: "cross_doc",
        query: [...t1, ...t2].join(" "),
        expected_doc_id: doc1.meta.doc_id, // either doc is acceptable
        difficulty: "hard",
      });
    }
  }

  // ── Strategy 7: Fuzzy / typo queries (7%) ──────────────────────
  // Introduce typos in section titles — tests findSymbol fuzzy mode.
  {
    const count = budget(7);
    const longTitles = allNodes.filter(({ node }) => node.title.length >= 6);
    const selected = pickN(longTitles, count);
    for (const { doc, node } of selected) {
      const title = node.title;
      // Introduce 1-2 character mutations
      const mutated = introduceTypo(title);
      questions.push({
        id: id++,
        strategy: "fuzzy_typo",
        query: mutated,
        expected_doc_id: doc.meta.doc_id,
        expected_node_id: node.node_id,
        difficulty: "hard",
      });
    }
  }

  // ── Strategy 8: Negative queries (5%) ──────────────────────────
  // Random strings that should return 0 or very few results.
  {
    const count = budget(5);
    for (let i = 0; i < count; i++) {
      const gibberish = Array.from({ length: 3 }, () =>
        Math.random().toString(36).slice(2, 8)
      ).join(" ");
      questions.push({
        id: id++,
        strategy: "negative",
        query: gibberish,
        expected_doc_id: "__NONE__",
        difficulty: "easy",
      });
    }
  }

  return questions.slice(0, TARGET_QUESTIONS);
}

// ── Typo introduction ────────────────────────────────────────────────

function introduceTypo(text: string): string {
  const chars = text.split("");
  const mutations = 1 + Math.floor(Math.random() * 2); // 1-2 mutations
  for (let m = 0; m < mutations; m++) {
    const pos = Math.floor(Math.random() * chars.length);
    const mutation = Math.floor(Math.random() * 3);
    switch (mutation) {
      case 0: // swap adjacent
        if (pos < chars.length - 1) {
          [chars[pos], chars[pos + 1]] = [chars[pos + 1], chars[pos]];
        }
        break;
      case 1: // delete
        chars.splice(pos, 1);
        break;
      case 2: // replace with nearby key
        chars[pos] = String.fromCharCode(
          chars[pos].charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1)
        );
        break;
    }
  }
  return chars.join("");
}

// ── Evaluation Runner ────────────────────────────────────────────────

function evaluateQuestion(
  store: DocumentStore,
  q: Question,
  docsRoot: string
): EvalResult[] {
  const results: EvalResult[] = [];

  // ── Test searchDocuments ───────────────────────────────────────
  {
    const start = performance.now();
    const searchResults = store.searchDocuments(q.query, {
      limit: 10,
      enable_glob_fallback: true,
    });
    const elapsed = performance.now() - start;

    const globFallback = searchResults.some((r) => r.score < 0);

    if (q.strategy === "negative") {
      // For negatives, success = 0 results
      results.push({
        question: q,
        tool: "search",
        hit_at_1: searchResults.length === 0,
        hit_at_5: searchResults.length === 0,
        hit_at_10: searchResults.length === 0,
        reciprocal_rank: searchResults.length === 0 ? 1 : 0,
        node_match: searchResults.length === 0,
        result_count: searchResults.length,
        glob_fallback_used: globFallback,
        top_result_score: searchResults[0]?.score ?? 0,
        elapsed_ms: elapsed,
      });
    } else {
      const rank = findRank(searchResults, q);
      results.push({
        question: q,
        tool: "search",
        hit_at_1: rank >= 1 && rank <= 1,
        hit_at_5: rank >= 1 && rank <= 5,
        hit_at_10: rank >= 1 && rank <= 10,
        reciprocal_rank: rank > 0 ? 1 / rank : 0,
        node_match: q.expected_node_id
          ? searchResults.some((r) => r.node_id === q.expected_node_id)
          : false,
        result_count: searchResults.length,
        glob_fallback_used: globFallback,
        top_result_score: searchResults[0]?.score ?? 0,
        elapsed_ms: elapsed,
      });
    }
  }

  // ── Test findSymbol (only for title and fuzzy strategies) ──────
  if (["title_query", "fuzzy_typo"].includes(q.strategy)) {
    const matchMode = q.strategy === "fuzzy_typo" ? "fuzzy" : "contains";
    const start = performance.now();
    const symbolResults = store.findSymbol({
      symbol: q.query,
      match_mode: matchMode as any,
      case_sensitive: false,
      limit: 10,
    });
    const elapsed = performance.now() - start;

    const rank = symbolResults.findIndex(
      (r) => r.doc_id === q.expected_doc_id
    );
    const nodeMatch = q.expected_node_id
      ? symbolResults.some((r) => r.node_id === q.expected_node_id)
      : false;

    results.push({
      question: q,
      tool: "symbol",
      hit_at_1: rank === 0,
      hit_at_5: rank >= 0 && rank < 5,
      hit_at_10: rank >= 0 && rank < 10,
      reciprocal_rank: rank >= 0 ? 1 / (rank + 1) : 0,
      node_match: nodeMatch,
      result_count: symbolResults.length,
      glob_fallback_used: false,
      top_result_score: symbolResults[0]?.match_score ?? 0,
      elapsed_ms: elapsed,
    });
  }

  return results;
}

function findRank(results: SearchResult[], q: Question): number {
  for (let i = 0; i < results.length; i++) {
    if (results[i].doc_id === q.expected_doc_id) return i + 1;
  }
  return 0; // not found
}

// ── Metric Aggregation ───────────────────────────────────────────────

function aggregate(results: EvalResult[]): MetricSet {
  if (results.length === 0) {
    return { count: 0, hit_at_1: 0, hit_at_5: 0, hit_at_10: 0, mrr: 0, node_accuracy: 0 };
  }
  const n = results.length;
  return {
    count: n,
    hit_at_1: results.filter((r) => r.hit_at_1).length / n,
    hit_at_5: results.filter((r) => r.hit_at_5).length / n,
    hit_at_10: results.filter((r) => r.hit_at_10).length / n,
    mrr: results.reduce((s, r) => s + r.reciprocal_rank, 0) / n,
    node_accuracy: results.filter((r) => r.node_match).length / n,
  };
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (groups[k] ??= []).push(item);
  }
  return groups;
}

// ── Stopwords ────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "have", "has",
  "was", "are", "been", "not", "but", "can", "will", "all", "any",
  "each", "than", "when", "how", "what", "where", "which", "who",
  "its", "into", "also", "use", "used", "using", "may", "should",
  "would", "could", "does", "did", "done", "being", "between",
  "through", "after", "before", "about", "above", "below", "over",
  "under", "more", "most", "some", "such", "only", "same", "other",
  "then", "them", "they", "their", "there", "these", "those",
]);

// ── Percentile helper ────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Pretty print ─────────────────────────────────────────────────────

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function printMetrics(label: string, m: MetricSet) {
  console.log(
    `  ${label.padEnd(28)} | Hit@1: ${pct(m.hit_at_1).padStart(6)} | Hit@5: ${pct(m.hit_at_5).padStart(6)} | Hit@10: ${pct(m.hit_at_10).padStart(6)} | MRR: ${m.mrr.toFixed(3).padStart(5)} | NodeAcc: ${pct(m.node_accuracy).padStart(6)} | n=${m.count}`
  );
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  doctree-mcp Evaluation Harness");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Docs root:     ${DOCS_ROOT}`);
  console.log(`  Target Qs:     ${TARGET_QUESTIONS}`);
  console.log(`  Output:        ${OUTPUT_FILE}`);
  console.log("");

  // ── Phase 1: Index ─────────────────────────────────────────────
  console.log("Phase 1: Indexing corpus...");
  const indexStart = performance.now();
  const config = singleRootConfig(DOCS_ROOT);
  const documents = await indexAllCollections(config);
  const store = new DocumentStore();
  store.load(documents);
  const indexMs = performance.now() - indexStart;

  const stats = store.getStats();
  console.log(
    `  Indexed ${stats.document_count} docs, ${stats.total_nodes} nodes, ${stats.indexed_terms} terms in ${(indexMs / 1000).toFixed(1)}s`
  );
  console.log("");

  // ── Phase 2: Generate questions ────────────────────────────────
  console.log("Phase 2: Generating questions...");
  const questions = generateQuestions(documents);

  const byStrategy = groupBy(questions, (q) => q.strategy);
  const byDifficulty = groupBy(questions, (q) => q.difficulty);

  console.log(`  Generated ${questions.length} questions:`);
  for (const [strategy, qs] of Object.entries(byStrategy)) {
    console.log(`    ${strategy.padEnd(25)} ${qs.length}`);
  }
  console.log(`  By difficulty:`);
  for (const [diff, qs] of Object.entries(byDifficulty)) {
    console.log(`    ${diff.padEnd(10)} ${qs.length}`);
  }
  console.log("");

  // ── Phase 3: Evaluate ──────────────────────────────────────────
  console.log("Phase 3: Running evaluation...");
  const evalStart = performance.now();
  const allResults: EvalResult[] = [];
  let done = 0;
  const progressInterval = Math.max(1, Math.floor(questions.length / 20));

  for (const q of questions) {
    const qResults = evaluateQuestion(store, q, DOCS_ROOT);
    allResults.push(...qResults);
    done++;
    if (done % progressInterval === 0) {
      const pctDone = ((done / questions.length) * 100).toFixed(0);
      process.stderr.write(`  Progress: ${pctDone}% (${done}/${questions.length})\r`);
    }
  }
  const evalMs = performance.now() - evalStart;
  console.log(`  Completed ${allResults.length} evaluations in ${(evalMs / 1000).toFixed(1)}s`);
  console.log("");

  // ── Phase 4: Aggregate metrics ─────────────────────────────────
  const searchResults = allResults.filter((r) => r.tool === "search");
  const symbolResults = allResults.filter((r) => r.tool === "symbol");
  const timings = allResults.map((r) => r.elapsed_ms);

  const globTriggered = searchResults.filter((r) => r.glob_fallback_used);
  const globHits = globTriggered.filter((r) => r.hit_at_10);

  // Build report
  const report: EvalReport = {
    corpus: {
      docs_root: DOCS_ROOT,
      document_count: stats.document_count,
      total_nodes: stats.total_nodes,
      indexed_terms: stats.indexed_terms,
    },
    questions: {
      total: questions.length,
      by_strategy: Object.fromEntries(
        Object.entries(byStrategy).map(([k, v]) => [k, v.length])
      ),
      by_difficulty: Object.fromEntries(
        Object.entries(byDifficulty).map(([k, v]) => [k, v.length])
      ),
    },
    metrics: {
      overall: aggregate(allResults),
      by_strategy: Object.fromEntries(
        Object.entries(
          groupBy(allResults, (r) => r.question.strategy)
        ).map(([k, v]) => [k, aggregate(v)])
      ),
      by_difficulty: Object.fromEntries(
        Object.entries(
          groupBy(allResults, (r) => r.question.difficulty)
        ).map(([k, v]) => [k, aggregate(v)])
      ),
      by_tool: {
        search: aggregate(searchResults),
        symbol: aggregate(symbolResults),
      },
    },
    timing: {
      index_ms: Math.round(indexMs),
      eval_ms: Math.round(evalMs),
      avg_query_ms: timings.length
        ? timings.reduce((a, b) => a + b, 0) / timings.length
        : 0,
      p50_query_ms: percentile(timings, 50),
      p95_query_ms: percentile(timings, 95),
      p99_query_ms: percentile(timings, 99),
    },
    glob_fallback: {
      total_triggered: globTriggered.length,
      pct_of_searches: searchResults.length
        ? globTriggered.length / searchResults.length
        : 0,
      hit_rate_when_triggered: globTriggered.length
        ? globHits.length / globTriggered.length
        : 0,
    },
  };

  // ── Phase 5: Print results ─────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");

  console.log("Overall:");
  printMetrics("ALL", report.metrics.overall);
  console.log("");

  console.log("By Tool:");
  for (const [tool, m] of Object.entries(report.metrics.by_tool)) {
    printMetrics(tool, m);
  }
  console.log("");

  console.log("By Strategy:");
  for (const [strategy, m] of Object.entries(report.metrics.by_strategy)) {
    printMetrics(strategy, m);
  }
  console.log("");

  console.log("By Difficulty:");
  for (const [diff, m] of Object.entries(report.metrics.by_difficulty)) {
    printMetrics(diff, m);
  }
  console.log("");

  console.log("Glob Fallback:");
  console.log(
    `  Triggered: ${report.glob_fallback.total_triggered} (${pct(report.glob_fallback.pct_of_searches)} of searches)`
  );
  console.log(
    `  Hit rate when triggered: ${pct(report.glob_fallback.hit_rate_when_triggered)}`
  );
  console.log("");

  console.log("Timing:");
  console.log(`  Index:   ${(report.timing.index_ms / 1000).toFixed(2)}s`);
  console.log(`  Eval:    ${(report.timing.eval_ms / 1000).toFixed(2)}s`);
  console.log(`  Avg/q:   ${report.timing.avg_query_ms.toFixed(2)}ms`);
  console.log(`  p50:     ${report.timing.p50_query_ms.toFixed(2)}ms`);
  console.log(`  p95:     ${report.timing.p95_query_ms.toFixed(2)}ms`);
  console.log(`  p99:     ${report.timing.p99_query_ms.toFixed(2)}ms`);
  console.log("");

  // ── Phase 6: Write JSON report ─────────────────────────────────
  const outputPath = OUTPUT_FILE.startsWith("/")
    ? OUTPUT_FILE
    : `${process.cwd()}/${OUTPUT_FILE}`;
  await Bun.write(outputPath, JSON.stringify(report, null, 2));
  console.log(`Full report written to: ${outputPath}`);

  // ── Phase 7: Sample failures (for debugging) ──────────────────
  if (VERBOSE) {
    const failures = allResults
      .filter(
        (r) =>
          !r.hit_at_10 &&
          r.question.strategy !== "negative" &&
          r.question.strategy !== "cross_doc"
      )
      .slice(0, 20);

    if (failures.length > 0) {
      console.log("");
      console.log("─── Sample Failures (first 20) ───");
      for (const f of failures) {
        console.log(
          `  [${f.tool}/${f.question.strategy}] "${f.question.query}" → expected: ${f.question.expected_doc_id}, got ${f.result_count} results`
        );
      }
    }
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Evaluation complete.");
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
