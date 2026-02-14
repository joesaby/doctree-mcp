/**
 * Document Store — BM25 + Positional Index + Faceted Filters
 *
 * In-memory index combining three design influences:
 *
 * 1. PageIndex (pageindex.ai) — Tree navigation for reasoning-based retrieval
 * 2. Pagefind (CloudCannon) — Positional inverted index, BM25 scoring,
 *    filter facets, content hashing, multisite weights, density excerpts
 * 3. Bun.markdown (Oven) — Structural parsing via render() callbacks
 *
 * See DESIGN.md for full attribution of every design decision.
 */

import type {
  IndexedDocument,
  TreeNode,
  TreeOutline,
  SearchResult,
  DocumentMeta,
  Posting,
  NodeStats,
  RankingParams,
  FilterIndex,
  FacetCounts,
} from "./types";
import { DEFAULT_RANKING } from "./types";

export class DocumentStore {
  private docs: Map<string, IndexedDocument> = new Map();

  // ── Positional inverted index (Pagefind-inspired) ───────────────
  // term → Posting[] (one entry per node the term appears in)
  private index: Map<string, Posting[]> = new Map();

  // ── Per-node stats for BM25 length normalization ─────────────────
  private nodeStats: Map<string, NodeStats> = new Map();

  // ── Corpus-level stats ───────────────────────────────────────────
  private totalNodes: number = 0;
  private avgNodeLength: number = 0;

  // ── Filter facets (Pagefind data-pagefind-filter inspired) ───────
  // key → value → Set<doc_id>
  private filters: FilterIndex = new Map();

  // ── Content hashes for incremental re-indexing (Pagefind-inspired) ─
  // file_path → content_hash
  private contentHashes: Map<string, string> = new Map();

  // ── Collection weights (Pagefind multisite/indexWeight inspired) ──
  private collectionWeights: Map<string, number> = new Map();

  // ── Ranking parameters (Pagefind-style configurable knobs) ───────
  private ranking: RankingParams = { ...DEFAULT_RANKING };

  // ── Glossary for query expansion (abbreviation → expanded forms) ──
  // Maps abbreviated terms to their expanded equivalents so queries
  // like "CLI" also match "command line interface"
  private glossary: Map<string, string[]> = new Map();

  // ── Load / Refresh ──────────────────────────────────────────────

  load(documents: IndexedDocument[]): void {
    this.docs.clear();
    this.index.clear();
    this.nodeStats.clear();
    this.filters.clear();
    this.contentHashes.clear();

    for (const doc of documents) {
      this.docs.set(doc.meta.doc_id, doc);
      this.contentHashes.set(doc.meta.file_path, doc.meta.content_hash);
    }

    this.buildIndex();
    this.buildFilterIndex();

    console.log(
      `Store loaded: ${this.docs.size} docs, ${this.totalNodes} nodes, ` +
        `${this.index.size} terms, ${this.filters.size} facet keys, ` +
        `avg node length: ${this.avgNodeLength.toFixed(0)} tokens`
    );
  }

  /**
   * Add or update a single document.
   * Handles incremental re-indexing: removes old data, adds new.
   *
   * Inspired by Pagefind's content hashing: "if an HTML page has not
   * changed between two Pagefind indexes, the fragment filename will
   * not change." We use content hashes to skip unchanged files entirely.
   */
  addDocument(doc: IndexedDocument): void {
    const existingDoc = this.docs.get(doc.meta.doc_id);

    // Remove old postings if this is an update
    if (existingDoc) {
      this.removeDocumentPostings(existingDoc);
      this.removeDocumentFilters(existingDoc);
    }

    this.docs.set(doc.meta.doc_id, doc);
    this.contentHashes.set(doc.meta.file_path, doc.meta.content_hash);
    this.indexDocument(doc);
    this.indexDocumentFilters(doc);
    this.recalcCorpusStats();
  }

  /**
   * Check if a file needs re-indexing based on content hash.
   * Pagefind-style incremental: skip unchanged files.
   */
  needsReindex(filePath: string, newHash: string): boolean {
    const existingHash = this.contentHashes.get(filePath);
    return existingHash !== newHash;
  }

  getContentHash(filePath: string): string | undefined {
    return this.contentHashes.get(filePath);
  }

  removeDocument(doc_id: string): void {
    const doc = this.docs.get(doc_id);
    if (!doc) return;

    this.removeDocumentPostings(doc);
    this.removeDocumentFilters(doc);
    this.contentHashes.delete(doc.meta.file_path);
    this.docs.delete(doc_id);
    this.recalcCorpusStats();
  }

  setRanking(params: Partial<RankingParams>): void {
    this.ranking = { ...this.ranking, ...params };
  }

  /**
   * Set collection weights (Pagefind multisite indexWeight equivalent).
   */
  setCollectionWeights(weights: Record<string, number>): void {
    for (const [name, weight] of Object.entries(weights)) {
      this.collectionWeights.set(name, weight);
    }
  }

  /**
   * Load a glossary for query expansion.
   *
   * Maps abbreviations and short-forms to their expanded equivalents.
   * During search, query terms are expanded using the glossary so that
   * "CLI" also matches "command line interface", "K8s" matches
   * "kubernetes", etc. Bidirectional: expanded terms also map back.
   *
   * Format: Record<string, string[]>
   *   { "CLI": ["command line interface"], "K8s": ["kubernetes"] }
   */
  loadGlossary(entries: Record<string, string[]>): void {
    this.glossary.clear();
    for (const [key, expansions] of Object.entries(entries)) {
      const normalizedKey = key.toLowerCase();
      const normalizedExpansions = expansions.map((e) => e.toLowerCase());

      // Forward: abbreviation → expanded forms
      this.glossary.set(normalizedKey, normalizedExpansions);

      // Reverse: each expanded term → abbreviation
      for (const expansion of normalizedExpansions) {
        const existing = this.glossary.get(expansion) || [];
        if (!existing.includes(normalizedKey)) {
          this.glossary.set(expansion, [...existing, normalizedKey]);
        }
      }
    }
    if (this.glossary.size > 0) {
      console.log(`Glossary loaded: ${Object.keys(entries).length} entries → ${this.glossary.size} expansion mappings`);
    }
  }

  /**
   * Expand query terms using the glossary.
   * Returns the original terms plus any glossary expansions.
   */
  private expandQueryTerms(terms: string[]): string[] {
    if (this.glossary.size === 0) return terms;

    const expanded = new Set(terms);
    for (const term of terms) {
      const expansions = this.glossary.get(term);
      if (expansions) {
        for (const expansion of expansions) {
          // Tokenize and stem each expansion (may be multi-word)
          const expandedTokens = tokenize(expansion).map(stem).filter((t) => t.length >= 2);
          for (const t of expandedTokens) {
            expanded.add(t);
          }
        }
      }
    }
    return [...expanded];
  }

  // ── Remove old postings for incremental update ──────────────────

  private removeDocumentPostings(doc: IndexedDocument): void {
    const docId = doc.meta.doc_id;

    // Remove from inverted index
    for (const [term, postings] of this.index) {
      const filtered = postings.filter((p) => p.doc_id !== docId);
      if (filtered.length === 0) {
        this.index.delete(term);
      } else {
        this.index.set(term, filtered);
      }
    }

    // Remove node stats
    for (const node of doc.tree) {
      this.nodeStats.delete(`${docId}::${node.node_id}`);
    }
  }

  private removeDocumentFilters(doc: IndexedDocument): void {
    const docId = doc.meta.doc_id;

    for (const [, valueMap] of this.filters) {
      for (const [, docSet] of valueMap) {
        docSet.delete(docId);
      }
    }
  }

  // ── Build the full positional inverted index ────────────────────
  //
  // Mirrors Pagefind's indexing pass where it walks HTML, splits on
  // anchor elements, and records word positions + weights.

  private buildIndex(): void {
    for (const doc of this.docs.values()) {
      this.indexDocument(doc);
    }
    this.recalcCorpusStats();
  }

  private indexDocument(doc: IndexedDocument): void {
    // Tokenize description separately for description_weight boosting
    const descriptionTerms = doc.meta.description
      ? new Set(tokenize(doc.meta.description).map(stem).filter((t) => t.length >= 2))
      : new Set<string>();
    const firstNodeId = doc.tree[0]?.node_id;

    for (const node of doc.tree) {
      const nodeKey = `${doc.meta.doc_id}::${node.node_id}`;
      const isFirstNode = node.node_id === firstNodeId;

      // Tokenize title and body separately for weighting
      // (Pagefind also weights heading text differently from body text)
      const titleTokens = tokenize(node.title);
      const bodyTokens = tokenize(node.content);
      const codeTokens = extractCodeTokens(node.content);

      // Combine into single token stream (title first, then body)
      const allTokens = [...titleTokens, ...bodyTokens];
      const titleEnd = titleTokens.length;

      // Store node stats for BM25 length normalization
      this.nodeStats.set(nodeKey, {
        doc_id: doc.meta.doc_id,
        node_id: node.node_id,
        total_tokens: allTokens.length,
      });

      // Build postings: for each unique term, record positions + weight
      const termPositions: Map<
        string,
        { positions: number[]; maxWeight: number }
      > = new Map();

      for (let pos = 0; pos < allTokens.length; pos++) {
        const term = stem(allTokens[pos]);
        if (term.length < 2) continue;

        if (!termPositions.has(term)) {
          termPositions.set(term, { positions: [], maxWeight: 1.0 });
        }

        const entry = termPositions.get(term)!;
        entry.positions.push(pos);

        // Weight by position: title > description > code > body
        // (Pagefind uses data-pagefind-weight for custom region weighting)
        let weight = 1.0;
        if (pos < titleEnd) {
          weight = this.ranking.title_weight;
        } else if (isFirstNode && descriptionTerms.has(term)) {
          // Boost description terms in the first node
          weight = Math.max(weight, this.ranking.description_weight);
        } else if (codeTokens.has(allTokens[pos])) {
          weight = this.ranking.code_weight;
        }
        entry.maxWeight = Math.max(entry.maxWeight, weight);
      }

      // Insert postings into the inverted index
      for (const [term, { positions, maxWeight }] of termPositions) {
        const posting: Posting = {
          doc_id: doc.meta.doc_id,
          node_id: node.node_id,
          positions,
          term_frequency: positions.length,
          weight: maxWeight,
        };

        if (!this.index.has(term)) {
          this.index.set(term, []);
        }
        this.index.get(term)!.push(posting);
      }
    }
  }

  // ── Build filter facet index (Pagefind data-pagefind-filter) ─────

  private buildFilterIndex(): void {
    for (const doc of this.docs.values()) {
      this.indexDocumentFilters(doc);
    }
  }

  private indexDocumentFilters(doc: IndexedDocument): void {
    const docId = doc.meta.doc_id;

    // Index explicit facets from frontmatter
    for (const [key, values] of Object.entries(doc.meta.facets)) {
      if (!this.filters.has(key)) {
        this.filters.set(key, new Map());
      }
      const valueMap = this.filters.get(key)!;
      for (const val of values) {
        if (!valueMap.has(val)) {
          valueMap.set(val, new Set());
        }
        valueMap.get(val)!.add(docId);
      }
    }

    // Index tags as a facet too
    if (doc.meta.tags.length > 0) {
      if (!this.filters.has("tags")) {
        this.filters.set("tags", new Map());
      }
      const tagMap = this.filters.get("tags")!;
      for (const tag of doc.meta.tags) {
        if (!tagMap.has(tag)) {
          tagMap.set(tag, new Set());
        }
        tagMap.get(tag)!.add(docId);
      }
    }

    // Auto-facet: collection (Pagefind multisite mergeFilter equivalent)
    if (doc.meta.collection) {
      if (!this.filters.has("collection")) {
        this.filters.set("collection", new Map());
      }
      const colMap = this.filters.get("collection")!;
      if (!colMap.has(doc.meta.collection)) {
        colMap.set(doc.meta.collection, new Set());
      }
      colMap.get(doc.meta.collection)!.add(docId);
    }
  }

  private recalcCorpusStats(): void {
    let totalTokens = 0;
    this.totalNodes = this.nodeStats.size;

    for (const stats of this.nodeStats.values()) {
      totalTokens += stats.total_tokens;
    }

    this.avgNodeLength =
      this.totalNodes > 0 ? totalTokens / this.totalNodes : 0;
  }

  // ── BM25 scoring (Pagefind v1.1+ alignment) ────────────────────
  //
  //   score(q, d) = Σ IDF(qi) · (tf · (k1+1)) / (tf + k1 · (1 - b + b · |d|/avgdl))
  //
  // Extended with weight multipliers and co-occurrence bonuses.

  private computeBM25(
    term: string,
    posting: Posting,
    nodeLength: number
  ): number {
    const { bm25_k1: k1, bm25_b: b } = this.ranking;
    const N = this.totalNodes;
    const postings = this.index.get(term);
    const n = postings ? postings.length : 0;

    // IDF: how rare is this term across all nodes?
    const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);

    // TF component with length normalization
    const tf = posting.term_frequency;
    const lengthNorm = 1 - b + b * (nodeLength / this.avgNodeLength);
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * lengthNorm);

    // Apply position-based weight
    return idf * tfNorm * posting.weight;
  }

  // ── Resolve facet filters to a doc_id whitelist ─────────────────
  //
  // Pagefind applies filters before scoring. We do the same:
  // intersect all filter conditions to get the candidate doc set.

  private resolveFilters(
    filters: Record<string, string | string[]>
  ): Set<string> | null {
    let candidateDocs: Set<string> | null = null;

    for (const [key, value] of Object.entries(filters)) {
      const values = Array.isArray(value) ? value : [value];
      const filterMap = this.filters.get(key);
      if (!filterMap) {
        // Unknown filter key → empty result
        return new Set();
      }

      // Union within values (OR), then intersect across keys (AND)
      const matchingDocs = new Set<string>();
      for (const val of values) {
        const docSet = filterMap.get(val);
        if (docSet) {
          for (const id of docSet) matchingDocs.add(id);
        }
      }

      if (candidateDocs === null) {
        candidateDocs = matchingDocs;
      } else {
        // Intersect
        for (const id of candidateDocs) {
          if (!matchingDocs.has(id)) candidateDocs.delete(id);
        }
      }
    }

    return candidateDocs;
  }

  // ── Cross-document search with BM25 + facets ───────────────────

  searchDocuments(
    query: string,
    options?: {
      limit?: number;
      doc_id?: string;
      collection?: string;
      filters?: Record<string, string | string[]>;
    }
  ): SearchResult[] {
    const queryTerms = tokenize(query).map(stem).filter((t) => t.length >= 2);
    if (queryTerms.length === 0) return [];

    // Expand query using glossary (abbreviation ↔ expanded forms)
    const expandedTerms = this.expandQueryTerms(queryTerms);
    const uniqueTerms = [...new Set(expandedTerms)];

    // Resolve facet filters to a doc_id whitelist (Pagefind-style pre-filter)
    let filterWhitelist: Set<string> | null = null;
    if (options?.filters && Object.keys(options.filters).length > 0) {
      filterWhitelist = this.resolveFilters(options.filters);
      if (filterWhitelist && filterWhitelist.size === 0) return [];
    }

    // Add collection filter if specified (Pagefind multisite scoping)
    if (options?.collection) {
      const colDocs = this.filters.get("collection")?.get(options.collection);
      if (!colDocs || colDocs.size === 0) return [];
      if (filterWhitelist) {
        for (const id of filterWhitelist) {
          if (!colDocs.has(id)) filterWhitelist.delete(id);
        }
      } else {
        filterWhitelist = new Set(colDocs);
      }
    }

    // Accumulate BM25 scores per node
    const nodeScores: Map<
      string,
      {
        score: number;
        matchedTerms: Set<string>;
        positions: number[];
        doc_id: string;
        node_id: string;
      }
    > = new Map();

    for (const term of uniqueTerms) {
      // Exact term lookup
      const postings = this.index.get(term);
      if (postings) {
        for (const posting of postings) {
          if (options?.doc_id && posting.doc_id !== options.doc_id) continue;
          if (filterWhitelist && !filterWhitelist.has(posting.doc_id)) continue;

          const nodeKey = `${posting.doc_id}::${posting.node_id}`;
          const stats = this.nodeStats.get(nodeKey);
          if (!stats) continue;

          const bm25Score = this.computeBM25(term, posting, stats.total_tokens);

          if (!nodeScores.has(nodeKey)) {
            nodeScores.set(nodeKey, {
              score: 0,
              matchedTerms: new Set(),
              positions: [],
              doc_id: posting.doc_id,
              node_id: posting.node_id,
            });
          }

          const entry = nodeScores.get(nodeKey)!;
          entry.score += bm25Score;
          entry.matchedTerms.add(term);
          entry.positions.push(...posting.positions);
        }
      }

      // Prefix matching for partial terms
      // (Pagefind does this at the chunk level; we iterate the in-memory index)
      if (term.length >= 3) {
        for (const [indexedTerm, pfxPostings] of this.index) {
          if (indexedTerm === term) continue;
          if (!indexedTerm.startsWith(term)) continue;

          for (const posting of pfxPostings) {
            if (options?.doc_id && posting.doc_id !== options.doc_id) continue;
            if (filterWhitelist && !filterWhitelist.has(posting.doc_id))
              continue;

            const nodeKey = `${posting.doc_id}::${posting.node_id}`;
            const stats = this.nodeStats.get(nodeKey);
            if (!stats) continue;

            // Prefix matches score at prefix_penalty of exact matches
            const bm25Score =
              this.computeBM25(indexedTerm, posting, stats.total_tokens) *
              this.ranking.prefix_penalty;

            if (!nodeScores.has(nodeKey)) {
              nodeScores.set(nodeKey, {
                score: 0,
                matchedTerms: new Set(),
                positions: [],
                doc_id: posting.doc_id,
                node_id: posting.node_id,
              });
            }

            const entry = nodeScores.get(nodeKey)!;
            entry.score += bm25Score;
            entry.matchedTerms.add(term);
            entry.positions.push(...posting.positions);
          }
        }
      }
    }

    // Apply co-occurrence bonuses
    for (const [, entry] of nodeScores) {
      const matchCount = entry.matchedTerms.size;

      if (matchCount > 1) {
        entry.score += (matchCount - 1) * this.ranking.term_proximity_bonus;
      }

      if (matchCount === uniqueTerms.length && uniqueTerms.length > 1) {
        entry.score += this.ranking.full_coverage_bonus;
      }

      // Apply collection weight (Pagefind indexWeight equivalent)
      const doc = this.docs.get(entry.doc_id);
      if (doc) {
        const colWeight =
          this.collectionWeights.get(doc.meta.collection) ?? 1.0;
        entry.score *= colWeight;
      }
    }

    // Convert to SearchResult objects
    const results: SearchResult[] = [];

    for (const [, entry] of nodeScores) {
      const doc = this.docs.get(entry.doc_id);
      if (!doc) continue;

      const node = doc.tree.find((n) => n.node_id === entry.node_id);
      if (!node) continue;

      // Density-based snippet (Pagefind excerpt algorithm)
      const snippet = buildDensitySnippet(
        node.content,
        entry.positions,
        node.title,
        180
      );

      results.push({
        doc_id: entry.doc_id,
        doc_title: doc.meta.title,
        file_path: doc.meta.file_path,
        node_id: entry.node_id,
        node_title: node.title,
        level: node.level,
        snippet,
        score: entry.score,
        match_positions: entry.positions.sort((a, b) => a - b),
        matched_terms: [...entry.matchedTerms],
        collection: doc.meta.collection,
        facets: doc.meta.facets,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, options?.limit || 20);
  }

  // ── Catalog with facet counts (Pagefind filter UI equivalent) ───

  listDocuments(options?: {
    tag?: string;
    query?: string;
    collection?: string;
    filters?: Record<string, string | string[]>;
    limit?: number;
    offset?: number;
  }): { total: number; documents: DocumentMeta[]; facet_counts: FacetCounts } {
    let docs = Array.from(this.docs.values()).map((d) => d.meta);

    // Apply filters
    if (options?.tag) {
      const tag = options.tag.toLowerCase();
      docs = docs.filter((d) =>
        d.tags.some((t) => t.toLowerCase().includes(tag))
      );
    }

    if (options?.collection) {
      docs = docs.filter((d) => d.collection === options.collection);
    }

    if (options?.filters) {
      const whitelist = this.resolveFilters(options.filters);
      if (whitelist) {
        docs = docs.filter((d) => whitelist.has(d.doc_id));
      }
    }

    if (options?.query) {
      const q = options.query.toLowerCase();
      docs = docs.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.description.toLowerCase().includes(q) ||
          d.file_path.toLowerCase().includes(q)
      );
    }

    // Build facet counts from the filtered set
    // (Pagefind updates available filters based on current result set)
    const facet_counts: FacetCounts = {};
    for (const doc of docs) {
      for (const [key, values] of Object.entries(doc.facets)) {
        if (!facet_counts[key]) facet_counts[key] = {};
        for (const val of values) {
          facet_counts[key][val] = (facet_counts[key][val] || 0) + 1;
        }
      }
      // Include tags in facet counts
      for (const tag of doc.tags) {
        if (!facet_counts["tags"]) facet_counts["tags"] = {};
        facet_counts["tags"][tag] = (facet_counts["tags"][tag] || 0) + 1;
      }
      // Include collection
      if (!facet_counts["collection"]) facet_counts["collection"] = {};
      facet_counts["collection"][doc.collection] =
        (facet_counts["collection"][doc.collection] || 0) + 1;
    }

    docs.sort((a, b) => a.title.localeCompare(b.title));

    const total = docs.length;
    const offset = options?.offset || 0;
    const limit = options?.limit || 50;

    return {
      total,
      documents: docs.slice(offset, offset + limit),
      facet_counts,
    };
  }

  // ── Tree operations (PageIndex-inspired tools) ──────────────────

  getTree(doc_id: string): TreeOutline | null {
    const doc = this.docs.get(doc_id);
    if (!doc) return null;

    return {
      doc_id: doc.meta.doc_id,
      title: doc.meta.title,
      nodes: doc.tree.map((n) => ({
        node_id: n.node_id,
        title: n.title,
        level: n.level,
        children: n.children,
        word_count: n.word_count,
        summary: n.summary,
      })),
    };
  }

  getNodeContent(
    doc_id: string,
    node_ids: string[]
  ): { doc_id: string; nodes: TreeNode[] } | null {
    const doc = this.docs.get(doc_id);
    if (!doc) return null;

    const nodes = node_ids
      .map((id) => doc.tree.find((n) => n.node_id === id))
      .filter(Boolean) as TreeNode[];

    return { doc_id, nodes };
  }

  getSubtree(
    doc_id: string,
    node_id: string
  ): { doc_id: string; nodes: TreeNode[] } | null {
    const doc = this.docs.get(doc_id);
    if (!doc) return null;

    const rootNode = doc.tree.find((n) => n.node_id === node_id);
    if (!rootNode) return null;

    const result: TreeNode[] = [rootNode];
    const queue = [...rootNode.children];

    while (queue.length > 0) {
      const childId = queue.shift()!;
      const child = doc.tree.find((n) => n.node_id === childId);
      if (child) {
        result.push(child);
        queue.push(...child.children);
      }
    }

    return { doc_id, nodes: result };
  }

  // ── Stats ───────────────────────────────────────────────────────

  getStats(): {
    document_count: number;
    total_nodes: number;
    total_words: number;
    indexed_terms: number;
    avg_node_length: number;
    facet_keys: string[];
    collections: string[];
  } {
    let total_words = 0;
    for (const doc of this.docs.values()) {
      total_words += doc.meta.word_count;
    }

    return {
      document_count: this.docs.size,
      total_nodes: this.totalNodes,
      total_words,
      indexed_terms: this.index.size,
      avg_node_length: Math.round(this.avgNodeLength),
      facet_keys: [...this.filters.keys()],
      collections: [...(this.filters.get("collection")?.keys() ?? [])],
    };
  }

  /**
   * Get available facets with value counts.
   * Equivalent to Pagefind's filter UI showing available filter options.
   */
  getFacets(): FacetCounts {
    const counts: FacetCounts = {};
    for (const [key, valueMap] of this.filters) {
      counts[key] = {};
      for (const [val, docSet] of valueMap) {
        counts[key][val] = docSet.size;
      }
    }
    return counts;
  }

  hasDocument(doc_id: string): boolean {
    return this.docs.has(doc_id);
  }
}

// ── Tokenization ─────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-\.\/]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function extractCodeTokens(content: string): Set<string> {
  const codeTokens = new Set<string>();
  const codeBlockRegex = /\[code:\w*\]\s*([\s\S]*?)(?=\[code:|\n\n|$)/g;
  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const tokens = tokenize(match[1]);
    for (const t of tokens) codeTokens.add(t);
  }
  return codeTokens;
}

// ── Stemming ─────────────────────────────────────────────────────────
//
// Lightweight Porter-style suffix stripping. Pagefind does stemming at
// index time (in Rust) and then stems the query to match. We do the same.

function stem(word: string): string {
  if (word.length < 4) return word;
  return word
    .replace(/ies$/, "y")
    .replace(/ied$/, "y")
    .replace(/(s|es)$/, "")
    .replace(/ing$/, (_, offset) => (word.length - offset > 4 ? "" : "ing"))
    .replace(/tion$/, "t")
    .replace(/ment$/, "")
    .replace(/ness$/, "")
    .replace(/able$/, "")
    .replace(/ible$/, "")
    .replace(/ally$/, "")
    .replace(/ful$/, "")
    .replace(/ous$/, "")
    .replace(/ive$/, "")
    .replace(/ly$/, "");
}

// ── Density-based snippet extraction ─────────────────────────────────
//
// Inspired by Pagefind's excerpt generation: find the region with the
// highest density of matching terms and extract a snippet centered there.

function buildDensitySnippet(
  content: string,
  matchPositions: number[],
  nodeTitle: string,
  maxLen: number
): string {
  if (!content || matchPositions.length === 0) {
    const text = content || nodeTitle;
    return text.slice(0, maxLen) + (text.length > maxLen ? "…" : "");
  }

  const words = content.split(/\s+/);
  if (words.length === 0) return content.slice(0, maxLen);

  const validPositions = matchPositions
    .filter((p) => p >= 0 && p < words.length)
    .sort((a, b) => a - b);

  if (validPositions.length === 0) {
    return content.slice(0, maxLen) + (content.length > maxLen ? "…" : "");
  }

  // Sliding window for highest match density
  const windowWords = Math.max(10, Math.floor(maxLen / 6));
  let bestStart = 0;
  let bestCount = 0;

  for (
    let start = 0;
    start <= Math.max(0, words.length - windowWords);
    start++
  ) {
    const end = start + windowWords;
    const count = validPositions.filter((p) => p >= start && p < end).length;
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }

  const snippetWords = words.slice(bestStart, bestStart + windowWords);
  let snippet = snippetWords.join(" ");

  if (snippet.length > maxLen) {
    snippet = snippet.slice(0, maxLen);
    const lastSpace = snippet.lastIndexOf(" ");
    if (lastSpace > maxLen * 0.7) snippet = snippet.slice(0, lastSpace);
  }

  if (bestStart > 0) snippet = "…" + snippet;
  if (bestStart + windowWords < words.length) snippet = snippet + "…";

  return snippet;
}
