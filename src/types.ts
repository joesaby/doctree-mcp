/**
 * doctree-mcp type definitions
 *
 * Models the hierarchical document tree (PageIndex) with search
 * capabilities adapted from Pagefind (CloudCannon). See DESIGN.md
 * for full attribution of every design decision.
 *
 * Attribution summary:
 *   TreeNode, TreeOutline        → PageIndex (tree navigation model)
 *   Posting, NodeStats, BM25     → Pagefind (positional index, scoring)
 *   FilterIndex, FacetCounts     → Pagefind (data-pagefind-filter)
 *   content_hash                 → Pagefind (fragment hashing)
 *   collection, collection_weight → Pagefind (multisite/indexWeight)
 *   description_weight           → Pagefind (data-pagefind-weight)
 *   RankingParams                → Pagefind (configurable ranking)
 */

// ── Tree model (PageIndex-inspired) ─────────────────────────────────

/** A single node in the document tree */
export interface TreeNode {
  node_id: string;
  title: string;
  level: number; // heading level: 1-6
  parent_id: string | null;
  children: string[]; // child node_ids
  content: string; // text content under this heading (before next heading)
  summary: string; // first ~200 chars
  word_count: number;
  line_start: number;
  line_end: number;
}

/** Compact tree representation for agent consumption (no content) */
export interface TreeOutline {
  doc_id: string;
  title: string;
  nodes: {
    node_id: string;
    title: string;
    level: number;
    children: string[];
    word_count: number;
    summary: string;
  }[];
}

// ── Document metadata ───────────────────────────────────────────────

/**
 * Metadata for an indexed document.
 *
 * content_hash: Inspired by Pagefind's stable fragment hashing —
 *   "if an HTML page has not changed between two Pagefind indexes,
 *    the fragment filename will not change."
 *   We use it for incremental re-indexing.
 *
 * collection: Inspired by Pagefind's multisite search with mergeFilter.
 *   Each DOCS_ROOT is a named collection with its own weight.
 *
 * facets: Inspired by Pagefind's data-pagefind-filter attributes.
 *   Extracted from frontmatter for faceted search.
 */
export interface DocumentMeta {
  doc_id: string;
  file_path: string; // relative path from docs root
  title: string; // first H1 or filename
  description: string; // first paragraph or frontmatter description
  word_count: number;
  heading_count: number;
  max_depth: number; // deepest heading level in the document
  last_modified: string; // ISO date
  tags: string[]; // extracted from frontmatter if present
  content_hash: string; // Pagefind-style content hash for incremental re-index
  collection: string; // Pagefind-style multisite collection name
  facets: Record<string, string[]>; // Pagefind-style filter facets from frontmatter
}

/** Complete indexed document */
export interface IndexedDocument {
  meta: DocumentMeta;
  tree: TreeNode[]; // flat array of all nodes
  root_nodes: string[]; // top-level node_ids (usually H1/H2)
}

// ── Positional index types (Pagefind-inspired) ──────────────────────

/**
 * A posting in the positional inverted index.
 *
 * Design borrowed from Pagefind's weighted_locations model where word
 * positions are stored per-page and cross-referenced with heading anchors.
 * We adapt: instead of anchors-on-a-flat-page, our nodes ARE the sections,
 * so positions are relative to each node's token stream.
 */
export interface Posting {
  doc_id: string;
  node_id: string;
  positions: number[]; // word offsets within the node's token stream
  term_frequency: number; // |positions|
  weight: number; // base weight: title=3.0, body=1.0, code=1.5
}

/**
 * Per-node statistics needed for BM25 length normalization.
 */
export interface NodeStats {
  doc_id: string;
  node_id: string;
  total_tokens: number;
}

// ── Filter facets (Pagefind data-pagefind-filter inspired) ──────────

/**
 * Filter index for faceted search.
 *
 * Pagefind loads filter data as separate index chunks and supports
 * faceted navigation via data-pagefind-filter attributes. We extract
 * facets from frontmatter and store them in an inverted structure:
 *   key → value → Set<doc_id>
 *
 * This lets the agent narrow search results the way a user would
 * click filter checkboxes in Pagefind's default UI.
 */
export type FilterIndex = Map<string, Map<string, Set<string>>>;

/**
 * Facet counts returned to the agent for discovery.
 * e.g., { tags: { auth: 47, jwt: 23 }, category: { api: 120, guide: 85 } }
 */
export type FacetCounts = Record<string, Record<string, number>>;

// ── Search result ───────────────────────────────────────────────────

/** Search result with positional match data and facets */
export interface SearchResult {
  doc_id: string;
  doc_title: string;
  file_path: string;
  node_id: string;
  node_title: string;
  level: number;
  snippet: string; // best region chosen by density (Pagefind excerpt algorithm)
  score: number; // BM25 relevance score (× collection weight)
  match_positions: number[]; // word positions of all matches in node
  matched_terms: string[]; // which query terms matched
  collection: string; // Pagefind-style multisite collection
  facets: Record<string, string[]>; // document's facet values
}

// ── Ranking configuration (Pagefind-style configurable knobs) ───────

/**
 * BM25 + ranking tuning parameters.
 *
 * Pagefind v1.1 aligned its ranking to BM25 and exposed tuning knobs after
 * finding that reference documentation sites benefit from different params
 * than blog/marketing sites. We follow the same philosophy.
 */
export interface RankingParams {
  /** TF saturation. Higher = TF matters more.
   *  Standard: 1.2. For docs heavy in repeated terms, try 0.8-1.0. */
  bm25_k1: number;

  /** Document length normalization. 0 = none, 1 = full. Standard: 0.75 */
  bm25_b: number;

  /** Multiplier for terms found in heading titles.
   *  Mirrors Pagefind's implicit heading weight boost. Default 3.0 */
  title_weight: number;

  /** Multiplier for terms found in code blocks.
   *  Like Pagefind's data-pagefind-weight for custom regions. Default 1.5 */
  code_weight: number;

  /** Multiplier for terms found in frontmatter description.
   *  Inspired by Pagefind's data-pagefind-meta weighting. Default 2.0 */
  description_weight: number;

  /** Bonus per additional query term co-occurring in the same node.
   *  Rewards sections that match multiple aspects of the query. Default 2.0 */
  term_proximity_bonus: number;

  /** Flat bonus when ALL query terms present in a single node. Default 5.0 */
  full_coverage_bonus: number;

  /** Discount factor for prefix matches (0-1). Default 0.5.
   *  Pagefind handles this at the chunk-loading level; we apply as a score multiplier. */
  prefix_penalty: number;
}

export const DEFAULT_RANKING: RankingParams = {
  bm25_k1: 1.2,
  bm25_b: 0.75,
  title_weight: 3.0,
  code_weight: 1.5,
  description_weight: 2.0,
  term_proximity_bonus: 2.0,
  full_coverage_bonus: 5.0,
  prefix_penalty: 0.5,
};

// ── Collection configuration (Pagefind multisite inspired) ──────────

/**
 * A named collection of documents from a single docs root.
 *
 * Pagefind's multisite feature lets you search across multiple indexes
 * with per-index indexWeight. We support the same pattern in-process:
 * multiple DOCS_ROOTs, each with a name and weight.
 */
export interface CollectionConfig {
  name: string;
  root: string;
  weight: number; // multiplied into BM25 scores. Pagefind's indexWeight equivalent.
  glob_pattern?: string;
}

/** Main configuration */
export interface IndexConfig {
  collections: CollectionConfig[];
  /** Optional code collections — source files indexed via AST parsing */
  code_collections?: CollectionConfig[];
  summary_length: number;
  max_depth: number;
}

/** Convenience: single-root config (the common case) */
export function singleRootConfig(
  docs_root: string,
  collection_name: string = "docs"
): IndexConfig {
  return {
    collections: [
      {
        name: collection_name,
        root: docs_root,
        weight: 1.0,
        glob_pattern: "**/*.md",
      },
    ],
    summary_length: 200,
    max_depth: 6,
  };
}
