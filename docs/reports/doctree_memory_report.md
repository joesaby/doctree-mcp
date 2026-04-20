---
title: "A Team-Shared, Self-Optimising Query Memory for doctree-mcp"
description: "Research report proposing a shared query-memory layer: episodic trajectory log, tripartite weighted graph, Bayesian edge updates, PPR-based cold-topic recall, and a minimum viable experiment design."
type: architecture
category: memory
tags: [query-memory, shared-memory, bm25, personalized-pagerank, beta-binomial, trajectory-log, multi-agent, retrieval]
date: 2026-04-20
---

# A Team-Shared, Self-Optimising Query Memory for doctree-mcp

**Research analyst report · April 2026**

---

## Executive summary

The user's brief asks for a shared, self-optimising query memory layer over an existing MCP-based, embedding-free, tree-structured retrieval server. The relevant literature is now substantial but uneven: agentic context engineering (ACE, Dynamic Cheatsheet, Reflexion, Voyager, Generative Agents, A-MEM, Mem0) gives us mature recipes for *single-agent* trajectory-based memory; cross-agent / team memory (Memory Sharing / INMS, Collaborative Memory, Agent KB) is younger but converging on a recognisable design; credit assignment without gradients (Reflexion, ACE's "helpful/harmful counters", trajectory-level DPO/GRPO ideas re-cast as bookkeeping) is mostly tractable; and the graph-side (HippoRAG, GraphRAG, LightRAG) is dominated by methods that *do* require embeddings, but whose graph topology and personalised-PageRank scoring transfer cleanly to a lexical/symbolic substrate.

Our recommended architecture:

- A **trajectory log** (episodic) that captures `(topic_signature, query, filters, doc_id, node_path, outcome)` tuples, persisted as JSONL.
- A **tripartite weighted graph** `Topics ↔ Queries ↔ Nodes`, stored in SQLite alongside the existing BM25 store, with edge weights updated by a Bayesian beta-binomial rule plus an Ebbinghaus-style time decay.
- Two new MCP tools: `recall_query_memory(topic)` and `record_trajectory_outcome(...)`.
- A **background consolidation worker** that periodically promotes stable episodic patterns into compact, human-readable "playbook bullets" (ACE-style) and runs personalised-PageRank over the graph to surface latent topic↔node affinities.
- A node-id stability layer that pins memory to `(content_hash, heading_path)` rather than to volatile `node_id`s, so that re-indexing does not silently corrupt memory.

The honest caveats: there is **no published evidence yet** that team-shared agent memory clearly outperforms per-agent memory at our scale; the closest thing is Agent KB (arXiv:2507.06229), which shows 6–16 pp gains on GAIA but only with embedding-based retrieval. The MVP we propose is sized to detect a 15-percentage-point improvement in task success at 80% power, which is the smallest effect plausibly justifying the engineering cost.

---

## §1 Literature map

Citations are arXiv-first. Where we cite blog posts, talks, or product pages, we flag them explicitly as `[non-arXiv]`. Each entry follows: representation of memory → update rule → sharing model → failure modes (where applicable).

### Q1 · Foundations: agentic context engineering

**ACE: Agentic Context Engineering** (Zhang et al., Stanford / SambaNova / UC Berkeley, arXiv:2510.04618, Oct 2025). ACE is the most directly relevant single paper to this brief. It treats the LLM's context as an evolving "playbook" of structured bullets, maintained by a three-role pipeline (Generator → Reflector → Curator). The Curator emits *delta updates* — small additions, edits, or deletions — rather than rewriting the playbook each time, which the authors argue prevents the "context collapse" they observe in monolithic-rewrite baselines. Bullets carry helpful/harmful counters that are incremented by execution feedback; pruning is by counter ratio plus a similarity-based dedup. Reported gains are +10.6 pp on AppWorld and +8.6 pp on financial reasoning, with much lower adaptation cost than baselines that rewrite full prompts. Sharing model: single-agent. Failure modes flagged in follow-up commentary: bullets that win the short-term counter race can entrench — Goodhart-style — even when wrong on average; the curator is itself an LLM and so is itself a liability surface.

**Dynamic Cheatsheet** (Suzgun et al., Stanford, arXiv:2504.07952, EACL 2026). The intellectual ancestor of ACE. Maintains a persistent "cheatsheet" of compact strategies and code snippets accumulated across queries; updated at test time by the model itself with no labels and no gradients. Strong reported gains (Claude 3.5 Sonnet's AIME accuracy more than doubles after retaining algebraic insights; GPT-4o's Game-of-24 success goes from ~10% to ~99% after discovering and reusing a Python solver). Sharing: single-agent. Failure mode noted by the authors: erroneous heuristics can be entrenched if they are convenient but wrong on the long tail.

**Reflexion** (Shinn et al., NeurIPS 2023, arXiv:2303.11366). Verbal reinforcement learning: after a failed trial the agent writes a short post-mortem in natural language, which is prepended on the next trial. Memory is a free-text episodic buffer. No gradient updates, no reward model. Reports a jump from ~80% to 91% pass@1 on HumanEval. Sharing: single-agent. Failure mode: hallucinated post-mortems can mislead subsequent trials, and the framework provides no way to detect this.

**Voyager** (Wang et al., NVIDIA / Caltech, arXiv:2305.16291, 2023). Lifelong-learning agent in Minecraft built around an *ever-growing skill library* of executable code. Skills are added when the agent's iterative-prompting loop confirms a new behaviour passes self-verification. Retrieval is by embedding similarity over skill descriptions. Reports 3.3× more unique items obtained, 2.3× longer distances travelled, and tech-tree milestones unlocked up to 15.3× faster than prior baselines. Most relevant lesson for us: *compositional, named, executable artefacts in a library massively outperform freeform episodic memory* when the underlying world is open-ended. Sharing: single-agent, but the library itself is portable to a fresh world. Failure mode: poor curation lets bad skills accumulate; Voyager handles this with a self-verification gate.

**Generative Agents** (Park et al., UIST 2023, arXiv:2304.03442). Smallville: 25 simulated humans with a memory-stream architecture. Memories are scored by a weighted sum of recency (exponential decay), relevance (cosine similarity), and importance (a self-rated integer 1–10). Periodically the agent clusters related memories and synthesises higher-order *reflections*, producing a tree of progressively more abstract memory. Ablations confirmed reflection is load-bearing — without it, multi-day coherence degrades within ~48 simulated hours. Sharing: per-agent, but agents observe each other and information diffuses through dialogue. Failure mode: importance scores are self-reported and noisy.

**MemGPT / Letta** (Packer et al., UC Berkeley, arXiv:2310.08560, 2023). OS-style hierarchical memory with main context (RAM), recall storage (warm), and archival storage (disk). The LLM itself is taught to issue function calls that page data between tiers. Most relevant for our purposes as a baseline architectural pattern for tier separation. Sharing: per-agent. Failure mode: relies on the LLM correctly issuing pagination calls; failures are silent.

**A-MEM** (Xu et al., Rutgers, arXiv:2502.12110, NeurIPS 2025). Zettelkasten-inspired agent memory: every new memory becomes an atomic note with structured attributes (keywords, tags, contextual description). New notes trigger link-generation against historical notes, and existing notes can *evolve* their attributes when new related memories arrive. Indexed via ChromaDB (so embeddings are required). Sharing: per-agent. Failure mode: as more memories accumulate, link generation gets noisier; the paper does not quantify drift on long horizons.

**MemoryBank / SiliconFriend** (Zhong et al., arXiv:2305.10250, AAAI 2024). Long-term memory for chat assistants with a forgetting curve directly modelled on Ebbinghaus. Each memory has an "intensity" updated by exponential decay, with reinforcement on recall. Sharing: per-user. Failure mode: assumes recency-of-recall correlates with importance, which is false for rare-but-critical facts.

**Mem0 / Mem0g** (Chhikara et al., arXiv:2504.19413, Apr 2025). Production-oriented memory system for chat agents with two variants: a flat key-value store and a graph-augmented variant. The graph variant uses entity-relation extraction (LLM-driven) plus multi-signal retrieval (semantic + BM25 + entity matching). Reports 91% lower p95 latency vs. full-context and ~26% improvement on LLM-as-judge over OpenAI's memory; 91.6 on LoCoMo and 93.4 on LongMemEval per their open eval. Sharing: per-user, with multi-user isolation. Most useful design lesson for us: *agent-generated facts are first-class*, not second-tier compared to human-authored ones.

**Zep / Graphiti** (Rasmussen et al., arXiv:2501.13956, Jan 2025). Temporally-aware knowledge-graph memory engine. Maintains a dual-timestamp model (event time + ingestion time) so memory can be queried "as of" a moment. Beats MemGPT 94.8 vs 93.4 on the Deep Memory Retrieval benchmark. Most useful lesson: *time-stamped, append-only edges with explicit invalidation* are how you survive a knowledge base that drifts.

**LongMemEval** (Wu et al., arXiv:2410.10813, ICLR 2025). The paper that gives us a reasonable benchmark surface (information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention). Critical empirical finding: round-level granularity beats session-level for storage. Discussed again in §Q7.

### Q2 · Credit assignment for retrieval trajectories

**Process Reward Models — survey and key papers.** The PRM line (originally Lightman et al. 2023, "Let's verify step by step"; followed by "Let's reward step by step" arXiv:2310.10080; "Lessons of developing PRMs in mathematical reasoning" arXiv:2501.07301; ThinkPRM arXiv:2504.16828; R-PRM arXiv:2503.21295) trains a separate verifier to score each step in a chain-of-thought trajectory. PRMs deliver finer-grained credit assignment than outcome reward models but require costly step-level annotations and are vulnerable to reward hacking. Most relevant honest finding (arXiv:2501.07301 and later ThinkPRM): training PRMs reliably needs hundreds of thousands of step labels — far beyond what a single team's interaction log will produce.

**Direct Preference Optimization** (Rafailov et al., arXiv:2305.18290, NeurIPS 2023). The base technique. Recasts RLHF as a classification problem over preference pairs, with no separate reward model. Critical for us only because of its multi-turn descendants.

**DMPO — Direct Multi-turn Preference Optimization** (Shi et al., arXiv:2406.14868, 2024). Adapts DPO to multi-turn agent trajectories by replacing the policy constraint with a state-action occupancy measure constraint and adding length normalisation. Useful as a theoretical reference; does require gradient training, which we explicitly want to avoid for v1.

**GRPO** (Shao et al., DeepSeekMath, arXiv:2402.03300, 2024). The RL algorithm that powered DeepSeek-R1's reasoning. Drops the critic and estimates baseline from group scores. The follow-up arXiv:2509.21154 ("GRPO is Secretly a Process Reward Model") proves that with shared trajectory prefixes, outcome-level GRPO is mathematically equivalent to a Monte-Carlo PRM-aware objective. Implication for our setting: *we can do step-level credit assignment without training a step-level model* by exploiting prefix-sharing across logged trajectories — an insight we will use directly.

**Tree of Thoughts** (Yao et al., NeurIPS 2023, arXiv:2305.10601). Generalises chain-of-thought to a tree of partial reasoning paths, with self-evaluation and backtracking. Game of 24 success rate jumped from ~4% (CoT) to ~74% (ToT). Relevant because doctree-mcp's `get_tree` / `navigate_tree` is structurally a tree search, and ToT-style backward credit (a node is good if downstream nodes were good) maps onto our trajectory structure cleanly.

**RLAIF / Constitutional AI** (Lee et al. arXiv:2309.00267, Bai et al. arXiv:2212.08073). AI feedback as a substitute for human labels. Useful only as a path to *automated relabelling* of past trajectories — e.g., asking a verifier model "did this trajectory plausibly answer the user's task?" — but introduces a known bias-noise tradeoff (synthetic preference data is low-noise, high-bias).

### Q3 · Bandit / RL formulations for query selection

**LinUCB** (Li, Chu, Langford, Schapire, arXiv:1003.0146, WWW 2010). The foundational contextual bandit paper. Models personalised news recommendation as a contextual bandit; introduces the disjoint and hybrid linear UCB algorithms. Reported a 12.5% click lift on Yahoo Front Page over a context-free baseline. Critically for us, they also introduced the *replay-based offline policy evaluation* technique, which makes it possible to evaluate a new bandit policy from logged trajectories without online experiments. This is exactly what we need for offline evaluation of a new memory-recall policy.

**BanditRank** (Gampa & Fujita, arXiv:1910.10410, PAKDD 2021). Treats the entire ranking as a single contextual-bandit action and trains by policy gradient against a task-specific metric. Useful framing only — requires gradient training.

**CascadeHybrid** (Li et al., online learning to rank with cascading user behaviour). Bandit model with both relevance and diversity, accommodating the cascading-click assumption common in IR. Closest in formulation to what an agent's `search_documents → get_tree → navigate_tree` trajectory looks like, where the agent stops drilling once it finds a satisfying node.

**Honest assessment for our scale.** At ~10⁴ trajectories/month, a contextual bandit over the *full* (query × facets × doc × subtree) action space is undertrained. The action space combinatorially blows up (rough back-of-envelope: 50 distinct facets, 1000 docs, ~20 subtrees per doc → ~10⁶ atomic actions). Linear bandits with shared features across arms (LinUCB's hybrid model) help, but the practical recommendation is to factor the policy: a bandit *only* over `(facet_set, doc_id)` conditional on a topic, with subtree selection delegated to deterministic BM25 ranking. We come back to this in §3.

### Q4 · Relationship graph construction

**HippoRAG** (Gutiérrez et al., NeurIPS 2024, arXiv:2405.14831). The most architecturally interesting graph-RAG paper for our purposes. Builds an entity knowledge graph from the corpus, then runs personalised PageRank from query-anchored entities to score passages. Reported 20% improvement over SOTA on multi-hop QA, with single-step retrieval that is 10–30× cheaper and 6–13× faster than iterative LLM retrieval like IRCoT. Embedding-required as published, but the PPR mechanism transfers cleanly to a lexical setting if the graph's nodes are heading-paths and edges are co-query weights — which is exactly what we will propose.

**Microsoft GraphRAG** (Edge et al., arXiv:2404.16130, Apr 2024). LLM-built entity graph + community detection + pre-generated community summaries. Best for "global" sense-making questions ("what are the main themes"). Embedding-heavy, LLM-heavy at index time. Useful as a contrast: it solves a different problem than ours (global QA over a corpus, not learning recurring retrieval paths).

**LightRAG** (Guo et al., arXiv:2410.05779, EMNLP 2024). Dual-level retrieval (low-level entity neighbourhoods + high-level concept summaries) over an LLM-extracted graph. Adds an *incremental update* algorithm so the graph absorbs new documents without full re-indexing — the property we most need. Embedding-required.

**PathRAG** (arXiv:2502.14902, 2025). Variant that focuses on key relational *paths* between query-anchored entities rather than full neighbourhoods, with explicit path-pruning. Most useful conceptual contribution: relational paths between two query-relevant entities are themselves first-class retrieval units. For us, this argues for storing learned `(query → node_path)` edges as the primary unit, not nodes alone.

**Mixture-of-PageRanks** (arXiv:2412.06078, 2024). Replaces long-context with a sparse PPR retriever; shows that a query-dependent personalisation vector blended with structural importance outperforms standard nearest-neighbour RAG on long-context tasks, while running entirely on CPU with sparse matrices. *This is exactly the deployment profile we want for doctree-mcp.*

**Graph of Skills** (arXiv:2604.05333, 2026). Builds a directed multi-relational graph over an agent's skill library, then uses reverse-weighted PPR to expand a small seed set into a dependency-complete bundle. Same algorithmic kernel we are proposing for query-memory expansion.

**Graph RAG surveys** (arXiv:2408.08921 Peng et al.; arXiv:2501.00309 Han et al.). Both reasonable maps of the territory. Useful disclaimer drawn from the survey: most graph-RAG systems make the LLM expensive at index time, which is incompatible with doctree-mcp's deterministic-and-cheap design ethos.

### Q5 · Multi-agent / team sharing

**MetaGPT** (Hong et al., arXiv:2308.00352, ICLR 2024). Multi-agent collaboration with role-specialised agents communicating via a shared *message pool* with a publish-subscribe protocol. Each agent observes only what it subscribes to — a useful pattern for scoping. Failure mode: cascading hallucinations if agents naively chain.

**AgentVerse** (Chen et al., arXiv:2308.10848, 2023). Multi-agent collaboration with dynamic group composition. Documents emergent social behaviours (helpful: information sharing; harmful: groupthink). Most useful note for us: when multiple agents work on related tasks, the *quality* of their joint output is sensitive to whether the coordination protocol surfaces dissenting views.

**INMS / Memory Sharing** (Gao & Zhang, Rutgers, arXiv:2404.09982, v3 Mar 2026). Direct precursor to what the user is asking for. Builds a shared, real-time, asynchronous memory pool that all agents read and write, with a real-time filter on what gets stored. Reports significant gains on open-ended (poetry-creation) tasks. The most important honest finding: with a shared pool, *memory diversity* matters as much as memory quality — overfitting to one agent's style is a real failure mode.

**Collaborative Memory** (arXiv:2505.18279, May 2025). Multi-user, multi-agent memory with asymmetric, time-evolving access controls modelled as a bipartite graph (users × agents × resources). Maintains a two-tier memory: private fragments visible only to the originator, plus a shared tier that propagates only after access-control checks pass. Most directly addresses the trust/provenance question for our brief: a useful concrete schema is that every shared edge carries an `(originator_agent, originator_team, propagation_policy)` tuple.

**Memory as a Service (MaaS)** (arXiv:2506.22815, Jun 2025). Position paper. Argues current memory practices form "memory silos" because memory is treated as agent-local state. Proposes service-oriented modular memory with explicit composition. Useful framing for our MCP-tool design.

**Agent KB** (Tang et al., OPPO PersonalAI, arXiv:2507.06229, Jul 2025; v5 Oct 2025). The *most directly relevant prior art* for what the user is building. A universal memory infrastructure that aggregates trajectories across heterogeneous agent frameworks (smolagents, OpenHands, OWL) into a structured knowledge base served via lightweight APIs. Inference uses two-stage hybrid retrieval: a "planning" stage seeds an agent with cross-domain workflows, and a "feedback" stage applies targeted diagnostic fixes. Reported gains: up to +16.28 pp success on GAIA; Claude-3 went from 38.46% → 57.69% on the hardest tier; GPT-4 from 53.49% → 73.26% on intermediate. Validated also on SWE-bench (Claude-3: 41.33% → 53.33%). The two structural lessons we should steal: (a) *separate the "what to do" memory from the "what fixes errors" memory* — they have different failure modes and need different update rules; (b) *the trajectory store should be queryable across agent frameworks*, which for our case means making the schema MCP-introspectable.

**Multi-Agent Memory from a Computer Architecture Perspective** (arXiv:2603.10062, 2026). Position paper that frames the multi-agent memory problem as cache coherence: shared vs. distributed paradigms, three-layer hierarchy. Useful conceptual scaffolding but no specific recipe.

### Q6 · Forgetting, consolidation, drift

**MemoryBank's Ebbinghaus decay** (already covered in Q1). The simplest workable forgetting rule: memory strength `S(t) = S₀ · exp(-t/λ)`, where λ is set per-memory based on importance and recall frequency. Each successful recall resets the clock. Cheap; works.

**A-MEM's evolution** (already covered in Q1). When new memories arrive, *existing* memories have their attributes updated rather than being left static. This is a different consolidation pattern from MemoryBank — promotion of episodic to semantic happens implicitly through link-density growth.

**Generative Agents' reflection** (already covered in Q1). Periodic LLM-driven clustering of related observations into higher-order conclusions, stored as new tree-of-reflections nodes. Most expensive of the three patterns; also the one that produces the most useful structure.

**Forgetful but Faithful** (arXiv:2512.12856, Dec 2025). Recent paper that frames forgetting as a privacy + efficiency + coherence design variable simultaneously. Important honest finding: *principled forgetting-by-design* (not just "delete the oldest") is needed for production agents — naive recency-only deletion will drop low-frequency, high-importance memories.

**Drift handling — most relevant gap.** None of the agent-memory papers we found cleanly address the case the user has: a knowledge base that re-indexes on content-hash change, breaking node IDs that the memory references. The closest analogue is Zep's dual-timestamp model (event time + ingestion time, arXiv:2501.13956), which lets the system invalidate edges when source data changes. We will adapt this directly.

### Q7 · Evaluation

**AgentBench** (Liu et al., ICLR 2024, arXiv:2308.03688). 8 distinct interactive environments. Useful as a coarse comparator but not specific to retrieval-memory.

**τ-bench** (Yao et al., arXiv:2406.12045, 2024) and **τ²-bench** (Barres et al., arXiv:2506.07982, 2025). Tool-agent-user interaction with policy adherence. The `pass^k` metric — probability of all-success across k trials — is the right reliability metric for a memory layer (one-shot success doesn't tell you if the memory is consistently helping or just occasionally hitting).

**WebArena** (Zhou et al., 2023, referenced in SWE-bench's bibliography arXiv:2310.06770). Realistic web-environment benchmark. Less relevant for us (our agent is not browsing).

**SWE-bench** (Jimenez et al., ICLR 2024, arXiv:2310.06770) and **SWE-Bench Pro** (arXiv:2509.16941, 2025). Real GitHub issues. Most relevant agent-memory finding from the Agent KB paper: SWE-bench is where shared-memory gains showed up most clearly (Claude-3: +12 pp). Plausibly because code-fix tasks have high prefix-sharing across trajectories — exactly what credit-assignment over a shared memory needs.

**LongMemEval** (Wu et al., ICLR 2025, arXiv:2410.10813). The most *directly applicable* benchmark for our purposes. Five core long-term memory abilities (extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention). Critical finding from the paper's ablations: round-level (turn-level) granularity outperforms session-level for storage; further compression to user-fact level improves multi-session reasoning but hurts overall. *We will adopt round-level as our default trajectory granularity.*

**Honest gap.** There is **no public benchmark** that exactly matches our task: "does shared memory speed up subsequent agents at retrieval over an internal corpus." LongMemEval is the closest, but its tasks are conversational, not retrieval-trajectory. Our MVP eval (§5) will need a custom workload.

### Sources we relied on that are not arXiv

- **PageIndex** (Vectify AI). Tree-based reasoning retrieval. Documented in product blog posts and a GitHub repo, no arXiv paper. Cited as `[non-arXiv]`. The recent survey arXiv:2511.18177 ("Rethinking Retrieval") references PageIndex as "VectifyAI 2024/2025" — the survey citations are themselves blog URLs.
- **Pagefind** (CloudCannon). Static-site BM25 + facet search. Product, no arXiv paper.
- The paper at arXiv:2511.18177 (Rethinking Retrieval) is itself useful as the only academic-style treatment of vectorless / hierarchical-node-based retrieval that we found.


---

## §2 Design recommendation for doctree-mcp

### 2.1 Architectural overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                       doctree-mcp (existing)                           │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐   │
│  │ heading-tree │   │ BM25 + facet │   │ glossary expansion       │   │
│  │ index        │   │ index        │   │                          │   │
│  └──────────────┘   └──────────────┘   └──────────────────────────┘   │
└─────────────────┬───────────────────────────────────────────────────────┘
                  │
                  │  agent-visible tools: search_documents, get_tree, …
                  │
┌─────────────────▼───────────────────────────────────────────────────────┐
│                  Query-Memory Layer (proposed, new)                      │
│                                                                          │
│  ┌──────────────────────┐    ┌────────────────────────────────────┐     │
│  │ episodic trajectory  │───▶│ tripartite weighted graph          │     │
│  │ log (JSONL, append-  │    │ Topics ↔ Queries ↔ NodeRefs        │     │
│  │ only, content-hash-  │    │ stored in SQLite (queries.db)      │     │
│  │ scoped)              │    │ edges carry: α (success), β (fail) │     │
│  └──────────────────────┘    │ τ (timestamp), provenance          │     │
│                               └────────────┬───────────────────────┘     │
│                                            │                             │
│                               ┌────────────▼───────────────────────┐     │
│                               │ consolidation worker (background)  │     │
│                               │  · runs every N trajectories       │     │
│                               │  · promotes stable patterns to     │     │
│                               │    "playbook bullets" (ACE-style)  │     │
│                               │  · runs PPR for cold-topic recall  │     │
│                               │  · invalidates stale node refs     │     │
│                               └────────────┬───────────────────────┘     │
│                                            │                             │
│  New MCP tools:                            │                             │
│   · recall_query_memory(topic) ──────────▶ tripartite graph + bullets   │
│   · record_trajectory_outcome(...) ──────▶ episodic log + graph update  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Data schema

Two stores, both flat-file persistent so an operator can `cat | jq` them. Both live alongside the BM25 index, scoped to the same content-hash namespace as doctree-mcp's existing index.

#### Episodic trajectory log (`trajectories.jsonl`, append-only)

One JSON object per agent trajectory:

```json
{
  "trajectory_id": "tr_2026-04-20_a1b2c3",
  "timestamp": "2026-04-20T14:33:12Z",
  "agent_id": "claude-session-9f2a",
  "team_id": "platform-team",
  "topic_signature": ["jwt", "refresh", "rotation"],
  "tool_calls": [
    {
      "tool": "search_documents",
      "args": {"query": "jwt refresh rotation",
               "filters": {"type": "runbook"}},
      "results_returned": ["doc_42#auth-refresh", "doc_17#sessions"]
    },
    {
      "tool": "get_tree",
      "args": {"doc_id": "doc_42"},
      "results_summary": "12 nodes returned"
    },
    {
      "tool": "navigate_tree",
      "args": {"doc_id": "doc_42", "node_id": "auth-refresh"},
      "node_refs": [{"content_hash": "sha256:7f3a…",
                     "heading_path": ["Auth", "Refresh", "Rotation"]}]
    }
  ],
  "outcome": {
    "agent_continued_without_requery": true,
    "task_resolved": true,
    "user_accepted_output": true,
    "outcome_score": 1.0,
    "outcome_source": "agent_self_report"
  },
  "doctree_index_hash": "sha256:91ab…"
}
```

Notes on the schema:

- **`topic_signature`** is *not* an embedding. It is a deterministic, lower-cased, stop-word-stripped, glossary-canonicalised tuple of the salient nouns in the query — produced by the same lexical pipeline doctree-mcp already uses for BM25 expansion. This keeps the system embedding-free and auditable. (We discuss when to optionally add MinHash/SimHash for fuzzy matching in §2.6.)
- **`node_refs`** are pinned by `(content_hash, heading_path)`, not by `node_id`. This is the single most important schema decision for surviving re-indexing: when doctree re-parses a document, `node_id`s may change, but `(content_hash_of_the_subtree, heading_path)` is stable as long as the heading-path is stable, and we can re-resolve to the new `node_id` lazily.
- **`outcome_source`** distinguishes self-reported success (cheap, noisy), no-requery heuristic (cheap, also noisy), and human-confirmed (rare, gold). All three contribute to the same edge weights but with different *evidence strengths* α (see §3.2).

#### Tripartite weighted graph (`queries.db`, SQLite)

Three node tables and three edge tables. Every edge carries a Beta-distribution sufficient statistic `(α, β)` (successes, failures), a last-update timestamp `τ`, and a provenance set.

```sql
-- Nodes
CREATE TABLE topics      (topic_id TEXT PRIMARY KEY, signature TEXT, created_at TEXT);
CREATE TABLE queries     (query_id TEXT PRIMARY KEY, normalized_query TEXT, filter_set TEXT);
CREATE TABLE node_refs   (node_ref_id TEXT PRIMARY KEY,
                          content_hash TEXT, heading_path TEXT,
                          last_resolved_node_id TEXT, last_resolved_at TEXT,
                          stale BOOLEAN);

-- Edges
CREATE TABLE topic_query (topic_id TEXT, query_id TEXT, alpha REAL, beta REAL,
                          tau TEXT, provenance TEXT,
                          PRIMARY KEY (topic_id, query_id));
CREATE TABLE query_node  (query_id TEXT, node_ref_id TEXT, alpha REAL, beta REAL,
                          tau TEXT, provenance TEXT,
                          PRIMARY KEY (query_id, node_ref_id));
CREATE TABLE topic_node  (topic_id TEXT, node_ref_id TEXT, alpha REAL, beta REAL,
                          tau TEXT, provenance TEXT,
                          PRIMARY KEY (topic_id, node_ref_id));  -- materialised by PPR
```

The `topic_node` table is *derived* — it is what the consolidation worker populates by running personalised PageRank from each topic over the bipartite `topic_query ⨝ query_node` subgraph. This is the lexical, embedding-free analogue of what HippoRAG (arXiv:2405.14831) does over a knowledge graph, and what Mixture-of-PageRanks (arXiv:2412.06078) does over a chunk-similarity graph: a query-anchored personalisation vector composed with structural importance, run cheaply on sparse matrices.

#### Promoted playbook bullets (`playbook.jsonl`)

Adapted from ACE (arXiv:2510.04618). Bullets are emergent, human-readable rules that survive consolidation:

```json
{"bullet_id": "b_0042",
 "topic": ["jwt", "refresh", "rotation"],
 "rule": "Search runbooks first, not architecture docs; auth-refresh node in doc_42 is canonical.",
 "helpful_count": 17, "harmful_count": 0,
 "promoted_from": ["tr_2026-03-12_…", "tr_2026-03-18_…", …],
 "last_used": "2026-04-19T11:02:00Z"}
```

Bullets are inspectable and editable by team members — this is the "first-class artefact, not opaque embeddings" property the user asked for.

### 2.3 The two new MCP tools

#### `recall_query_memory(topic, limit=5) → suggestions`

Given a topic phrase from the calling agent, return suggested `(query, filter_set, doc_id, node_path)` tuples ranked by expected utility, plus any matching playbook bullets.

Algorithm (deterministic, sub-millisecond at our scale):

1. Compute `topic_signature` from the topic phrase using the same lexical pipeline as ingestion.
2. Look up exact-match `topic_id`. If absent, fall back to nearest neighbours over signatures using Jaccard over n-gram shingles (cheap; no embeddings).
3. For each candidate topic, retrieve the top-k `(query, node_ref)` pairs by *posterior expected success* (Thompson sampling over Beta posterior — see §3.1).
4. For each `node_ref`, lazily re-resolve `(content_hash, heading_path) → node_id`. If the content hash no longer exists in the current index, mark the edge stale and skip it.
5. Append any `playbook.jsonl` bullets matching the topic.
6. Return.

Importantly, `recall_query_memory` is *advisory*: the agent is free to ignore suggestions and run its own `search_documents`. The system learns from both behaviours.

#### `record_trajectory_outcome(trajectory_id, outcome) → ack`

Called at the end of an agent session — either by the agent itself (cheap, noisy) or by an external orchestrator that observed task resolution (better). Triggers the online edge-weight update from §3.

This split — passive logging of every trajectory by middleware vs. explicit outcome reporting — means we get partial credit even when nobody calls `record_trajectory_outcome`, by treating "agent did not re-query and did not error" as a weak positive signal.

### 2.4 The consolidation loop (background worker)

Runs asynchronously, e.g. every 1000 new trajectories or every 24 hours. Three jobs:

**Job A · Promote bullets (ACE-style).** For every `(topic, query)` pair where `α > α_threshold` (e.g. ≥ 5 successes) and `α/(α+β) > 0.85`, ask a *small* LLM to synthesise a single human-readable rule from the underlying trajectories. Store as a playbook bullet. *This is the only LLM in the loop*, and it is bounded: it runs offline, on bounded batches, and its output is auditable.

**Job B · Run PPR (HippoRAG-style, embedding-free).** For each topic `t` with at least 3 incoming queries, build the personalisation vector `e_t` as a one-hot over queries weighted by topic→query edge means, then iterate PPR for 20–30 steps over the bipartite `topic_query ⨝ query_node` subgraph. Materialise the top-K results into the `topic_node` table. This produces structural recommendations: nodes that are not directly queried but are a single hop away from successful queries on this topic.

**Job C · Stale-edge invalidation.** For every edge whose `node_ref` content hash no longer exists in the current doctree index, mark stale; if the heading_path resolves elsewhere in the corpus, attempt a one-shot re-pin.

### 2.5 Persistence and operations

The whole layer fits in one SQLite file plus two JSONL files. No additional service to run; the consolidation worker is a cron job. Total expected size at 10⁴ trajectories/month, retained for 12 months: ~1 GB compressed. Trivial.

### 2.6 Where embeddings might earn their keep — and where they don't

The user explicitly asked us to flag where embeddings are necessary. Honest answer:

- **Topic matching across paraphrases.** The lexical Jaccard fallback in `recall_query_memory` step 2 will miss "JWT rotation" vs "refresh-token rotation". This is the strongest case for embeddings. **A cheaper alternative we recommend first:** MinHash signatures over n-gram shingles, which give approximate Jaccard for free, are deterministic, and run on CPU. If MinHash proves insufficient empirically (measure recall@k on held-out paraphrases), *then* consider a small sentence embedding (e.g. 384-dim) for topic signatures only — never for queries or nodes.
- **Cross-corpus transfer.** If two teams want to share memory across different doctree corpora, embedding-based topic alignment becomes hard to avoid. Out of scope for v1.

Everywhere else, the lexical / graph / counter-based machinery suffices.

### 2.7 What is novel synthesis vs. directly adapted

Honest attribution table:

| Component | Source |
|---|---|
| Three-role consolidation (Generator / Reflector / Curator) | Direct adaptation of ACE (arXiv:2510.04618), simplified to one role (Curator) plus a separate background worker |
| Helpful/harmful counters on bullets | Direct from ACE |
| Personalised PageRank for cold-topic recall | Direct adaptation of HippoRAG (arXiv:2405.14831), Mixture-of-PageRanks (arXiv:2412.06078) — but on a *lexical* tripartite graph, not an LLM-extracted entity graph |
| Beta-binomial posteriors on edges + Thompson sampling | Standard contextual-bandit literature (Li et al. arXiv:1003.0146 and descendants), no new claim |
| Ebbinghaus-style decay on edge weights | Direct from MemoryBank (arXiv:2305.10250) |
| Dual-timestamp invalidation for stale node refs | Direct from Zep / Graphiti (arXiv:2501.13956) |
| Round-level granularity for trajectory storage | Empirical finding from LongMemEval (arXiv:2410.10813) |
| Trajectory-level success → step-level credit by prefix-sharing | Conceptual borrow from GRPO-as-PRM (arXiv:2509.21154); we apply it as a *bookkeeping* rule, not a training rule |
| Two-tier shared memory with provenance | Direct from Collaborative Memory (arXiv:2505.18279) |
| Two-stage retrieval (planning + feedback) | Direct from Agent KB (arXiv:2507.06229) |
| Pinning node refs to `(content_hash, heading_path)` | **Novel synthesis** — not seen in any single paper, but follows from combining Zep's invalidation with doctree-mcp's content-hash addressing |
| MCP-tool surface (`recall_query_memory`, `record_trajectory_outcome`) | **Novel synthesis** — the MCP-shaped API is the user's contribution; we are just naming it |
| Tripartite graph (Topics × Queries × NodeRefs) as the central data structure | **Novel synthesis** — most prior work uses Topics × Documents (TF-IDF), Queries × Documents (click models), or Entities × Entities (KG). The tripartite shape with separately decaying edges on each side is, as far as we found, new |


---

## §3 Learning rule

The whole memory layer reduces to one update equation, applied online at every `record_trajectory_outcome` call. We give it formula-level, then explain the choices.

### 3.1 The core update: Beta-binomial with evidence weighting and time decay

For each edge `e ∈ {topic→query, query→node_ref}` traversed by a trajectory `τ` with outcome score `r ∈ [0, 1]` and evidence weight `w ∈ (0, 1]`:

```
α_e ← γ(Δt) · α_e  +  w · r · c_e
β_e ← γ(Δt) · β_e  +  w · (1 − r) · c_e
τ_e ← now()
```

where:

- **`γ(Δt) = exp(−Δt / λ)`** is the Ebbinghaus-style decay factor (MemoryBank, arXiv:2305.10250) applied since the edge was last touched at `τ_e`. Recommended `λ = 90 days` for an internal-docs corpus that turns over slowly. Rare-but-correct edges therefore decay slowly enough to survive months of disuse, while spurious early hits decay out of relevance.
- **`r ∈ [0, 1]`** is the outcome score. We compose it from up to three sub-signals:
  - `r_self = 1` if `agent_continued_without_requery == True`, else `0`. **Weak**, cheap.
  - `r_task = 1` if downstream task verification succeeded (e.g. test suite passed, user clicked accept), else `0`. **Medium-strong**, requires orchestrator instrumentation.
  - `r_human = 1` if a human team member confirmed the path was correct via the playbook-bullet UI, else `0`. **Gold**, rare.
  - Combined: `r = max(r_human, r_task, 0.5 · r_self)` — human evidence dominates; self-report is half-weighted to reflect its noise.
- **`w`** is the evidence weight, set per-source: `w_self = 0.2`, `w_task = 0.6`, `w_human = 1.0`. This is the bookkeeping equivalent of trust calibration — sources we trust less push less.
- **`c_e ∈ [0, 1]`** is the *credit* assigned to this specific edge for the trajectory's outcome. This is the credit-assignment problem.

### 3.2 Credit assignment without gradients

We borrow the GRPO-as-PRM insight (arXiv:2509.21154): *with prefix-sharing across logged trajectories, outcome-level signal is mathematically equivalent to a Monte-Carlo PRM*. Translated into bookkeeping:

For a trajectory `τ` of length `n` with outcome `r`, we want to assign credit `c_e^(τ)` to each edge `e` traversed at step `i`. Three options, in order of complexity:

1. **Uniform credit (default).** `c_e = 1` for every edge in the trajectory. Simplest; a known overestimator for early steps that happen to precede success regardless of contribution. Recommended for v1.

2. **Last-step-weighted credit.** `c_e^(i) = i / n`. Gives more credit to the final navigation steps that actually surfaced the answer. Recommended once we have ~3 months of data and can A/B test against uniform.

3. **Counterfactual credit (deferred).** For each edge, look at the empirical posterior `r̂(τ)` of trajectories that *agreed* with this edge vs. those that didn't — the difference is the edge's marginal contribution. This is what GRPO-as-PRM is doing implicitly with prefix-sharing. Tractable only after we have ≥10⁵ trajectories per common topic. **Do not build this in v1.**

### 3.3 Cold start

For a topic never seen before, `recall_query_memory` returns nothing from the graph. Two fallbacks:

- **Lexical neighbour topic.** Use n-gram-shingled Jaccard (or MinHash if installed) to find the topic with the most overlapping signature, and return *its* recommendations with all weights multiplied by 0.5 (we are less confident about transferred knowledge).
- **Empty return is OK.** The agent falls back to the existing `search_documents` BM25 path, which is what they used to do anyway. Importantly, that BM25 trajectory is *still logged*, so on the next call for the same topic the cold start is over.

### 3.4 Conflict resolution: when two agents learn opposing paths

This is the hardest case in the literature, and the honest answer is: there is no consensus best practice. INMS (arXiv:2404.09982), Collaborative Memory (arXiv:2505.18279), and Agent KB (arXiv:2507.06229) all handle this differently.

We propose the following rule, which is straightforward but has a sharp edge:

**Per-edge merging.** Agents writing to the same edge contribute to a single shared `(α, β)` pair. Their updates add. If team A's agents learned `query="auth refresh" → node_42:auth-refresh` works (high α, low β) and team B's agents learned the same query path *fails* (low α, high β), the posterior expected success collapses toward 0.5 and Thompson sampling will explore alternatives. This is the right behaviour: *we do not silently pick a winner*; we surface uncertainty. The playbook bullet for that topic will not get promoted (since `α/(α+β) < 0.85`), and a human reviewer can step in.

**Per-team partitioning (optional, recommended after the first conflict surfaces).** Maintain two `(α, β)` pairs per edge — one shared, one team-scoped. `recall_query_memory` returns the team-scoped posterior if it has enough evidence (`α + β ≥ 5`), else falls back to shared. This is exactly the Collaborative Memory two-tier pattern (arXiv:2505.18279), translated to our schema.

### 3.5 What we explicitly do *not* do

- We do not train a reward model. The Beta posterior *is* the reward model, in conjugate-prior form, and it updates analytically.
- We do not train a policy. The "policy" is Thompson sampling from the posterior, which is parameter-free.
- We do not run DPO, GRPO, RLHF, RLAIF, or any gradient method. The user's brief explicitly asked us not to, and we don't need to: the lexical/symbolic substrate makes a Bayesian bookkeeping rule sufficient for the scale described.


---

## §4 Risks and open questions

This section is intentionally pessimistic. We list the failure modes we expect, ranked roughly by how likely we think they are to bite a real deployment, and we point at where the literature is genuinely silent.

### 4.1 Reward hacking — agents learning to game the memory

The signal `agent_continued_without_requery == True` is an obvious target for Goodharting. An agent that learns "always accept the first suggestion to look productive" will hammer up `α` on any path it touches, even bad ones. ACE (arXiv:2510.04618) and Voyager (arXiv:2305.16291) both note this in passing but do not solve it.

**Mitigations:**
- Heavily downweight `r_self` (we already set `w_self = 0.2`).
- Require `r_task` or `r_human` for a bullet to *promote*, not just for the edge to update.
- Periodically run a held-out replay: for a sample of trajectories, ask whether the answer the agent produced actually solves the user's stated task — if not, retroactively zero out the credit on that trajectory's edges. This is the offline replay trick from LinUCB (arXiv:1003.0146).

### 4.2 Poisoning by a single bad trajectory

A single agent with a buggy outcome heuristic can spam-promote a wrong path. This is worse in a *shared* memory than in a per-agent memory, because the bad data is now everyone's bad data.

**Mitigations:**
- Bayesian smoothing with the `(α, β)` prior makes a single observation barely move the posterior.
- The team-scoped tier (§3.4) means cross-contamination requires a critical mass.
- Provenance tags on every edge let a human invalidate "all edges contributed by `agent_id=X` between dates A and B" with a single SQL update — much harder to do in an embedding-based system.

### 4.3 Stale node IDs after re-index

This is the most operationally annoying failure mode and the one the user already flagged in the brief. Our `(content_hash, heading_path)` pinning handles the common case (heading reorganisation within a document), but breaks under:
- Heading-path renames ("Auth → Refresh → Rotation" becomes "Authentication → Token Rotation"): we'd lose the edge.
- Document splits or merges: content hash of the parent subtree changes everywhere.

**Mitigations:**
- Store the *full text* of the heading path's first paragraph as a tertiary identifier; on re-index, do a one-shot BM25 search for that paragraph and re-pin if the top hit is unambiguous.
- Mark unresolvable edges as `stale=True` rather than deleting them, and surface a "memory health" report for human review.
- Honest admission: in the worst case (large doctree restructuring), some memory loss is unavoidable. This is true for *any* memory system, including embedding-based ones — embeddings drift across re-encodings of the same content too. Tracking the `doctree_index_hash` per trajectory at least makes the loss diagnosable.

### 4.4 Privacy leakage from shared trajectories

A query like `"acquisition_target_xyz Q4 financials"` can leak information through the memory. The team-scoped tier helps, but is not sufficient on its own. Collaborative Memory (arXiv:2505.18279) addresses this via explicit access-control bipartite graphs; "Forgetful but Faithful" (arXiv:2512.12856) frames forgetting as a privacy tool.

**Mitigations:**
- Make the team-scoped tier the default; promotion to shared requires explicit opt-in via a curation tool.
- Apply a query-time redaction filter — any topic_signature containing tokens matching an opt-out regex is never written to the shared tier.
- Periodic audit log: every shared write is logged with originator + content_hash, queryable.

### 4.5 Per-agent overfitting vs. team-wide generalisation

The honest open question. INMS (arXiv:2404.09982) reports gains but also notes that diversity matters; AgentVerse (arXiv:2308.10848) documents that multi-agent groupthink is a real failure mode; Agent KB (arXiv:2507.06229) shows aggregate gains but does not break down per-agent variance.

**Where the literature is silent.** None of the cited papers measures whether shared memory *helps* a struggling agent at the cost of *hurting* a strong one. This is exactly the kind of effect that would show up in production and is the one our MVP eval (§5) is designed to detect.

### 4.6 Bullet entrenchment

ACE's helpful/harmful counter system (arXiv:2510.04618) has the property that early bullets accumulate evidence faster than later, equivalent ones — first-mover entrenchment. After 6 months of use, the playbook may be biased toward the patterns that happened to be common in month 1.

**Mitigation:**
- Periodically (monthly) re-run bullet promotion from scratch over the full trajectory log, with current bullets removed. Compare the new promoted set against the existing set. Bullets that no longer pass the promotion threshold become candidates for retirement; new bullets that emerge should be flagged for review.

### 4.7 The scale at which a contextual bandit actually beats simple counters

Honest: it's not obvious that LinUCB-style hybrid linear bandits give a meaningful win over the Beta-binomial-plus-Thompson-sampling rule we proposed, *at our scale*. Linear bandits shine when there are many arms with shared features and few observations per arm. Our setting is closer to "moderate arms, moderate observations" — where independent Beta posteriors are competitive and far simpler.

**Open question.** At what trajectory volume does a contextual bandit with shared features become worth the engineering cost? We don't know. We propose the simple rule first and instrument enough to revisit the decision in 6 months.

### 4.8 Genuine "memory for agents" hype check

The brief asked for skepticism. Honest read of the literature:

- **What is well-supported:** structured episodic-to-semantic consolidation helps single agents on long-horizon tasks. ACE, Dynamic Cheatsheet, Reflexion, Voyager, and A-MEM all report large wins on benchmarks designed to highlight memory.
- **What is moderately supported:** shared memory across agents helps on cross-task transfer. Agent KB shows ~6–16 pp gains on GAIA and SWE-bench, which is real but specific to those tasks.
- **What is not yet supported by published evidence:** that team-shared memory generalises to *novel* tasks the team has not encountered before; that the gains compound over years rather than plateauing in months; that the overhead of curating shared memory is recovered by the time saved. These are open empirical questions.
- **What seems oversold:** "memory enables agent self-improvement" claims that ignore the curator-LLM in the loop. ACE achieves its gains partly because a frontier LLM is iteratively reflecting on trajectories. If the curator LLM is capable enough to write good rules, much of the credit is the curator's, not the memory's. This matters for our design: we keep the curator LLM bounded and offline, and we measure performance with the curator turned off as an ablation.


---

## §5 Minimum viable experiment

The design above is non-trivial. Before building it all, we need an experiment that tells us whether the *core hypothesis* — that a shared, decaying, weighted query-memory layer measurably improves subsequent agent runs — is even true on doctree-mcp's real workload. This section sizes the smallest such experiment.

### 5.1 Hypothesis and effect size we care about

**H1.** Agents with `recall_query_memory` enabled will resolve previously-encountered topics with strictly fewer tool calls than agents without.

**H2.** Agents with `recall_query_memory` enabled will achieve a higher per-task success rate than agents without, *on topics the team has touched before*.

**Effect size we care about:** ≥15 percentage points improvement in task success on repeat topics, or ≥30% reduction in median tool-calls-to-resolution. Anything smaller does not justify the engineering cost.

### 5.2 The A/B design

**Population.** Real agent sessions over the team's actual doctree corpus. We estimate ~10⁴ sessions/month from the brief. We cannot use synthetic tasks here because the value of memory depends on real query distributions.

**Arms.**
- *Control.* Existing doctree-mcp tools only (no memory layer).
- *Treatment.* Doctree-mcp + the proposed memory layer with `recall_query_memory` exposed and auto-logging via middleware.

Random assignment is per-session, not per-team, to control for team-effect confounding. The memory layer in the treatment arm starts empty and *only learns from treatment-arm trajectories*. (This isolates the memory effect from any cross-arm leakage.)

**Two-phase rollout.**
- Phase 1 (warm-up, 4 weeks): Treatment arm runs but `recall_query_memory` returns nothing — we are only logging. This populates the memory store with a baseline.
- Phase 2 (measurement, 4 weeks): Treatment arm starts using `recall_query_memory`. Control arm continues unchanged.

Without this two-phase split, we'd be measuring the cold-start penalty rather than the steady-state benefit.

### 5.3 Metrics

Primary:

- **Task success on repeat topics** (binary per session). A repeat topic is one where ≥3 prior sessions in the same team touched a Jaccard-overlap-≥0.5 topic_signature. This is the metric where memory should help most.
- **Median tool-calls-to-resolution** (continuous). Lower is better. Counts `search_documents`, `get_tree`, `get_node_content`, `navigate_tree`, `lookup_row` per session.

Secondary:

- Time-to-first-relevant-node (proxy for "did the agent jump straight to the right place").
- Re-query rate (proportion of sessions where the agent issued a second `search_documents` after a first one returned results).
- Token cost per session (proxy for the operational ROI of memory).

Diagnostic:

- Per-team breakdown — to detect the §4.5 risk (shared memory helps some, hurts others).
- Stale-edge rate over time — to detect drift problems (§4.3).
- Bullet retirement rate — to detect entrenchment (§4.6).

### 5.4 Sample-size reasoning

We use a two-proportion z-test for H2.

- Assumed control success rate on repeat topics: `p_C = 0.50`. (Best guess — agents currently work, but not always.)
- Effect size we need to detect: `p_T − p_C = 0.15`, so `p_T = 0.65`.
- Significance level: α = 0.05, two-tailed.
- Power: 1 − β = 0.80.

Standard formula: `n_per_arm ≈ ((z_{α/2} + z_{β})² · (p_C(1−p_C) + p_T(1−p_T))) / (p_T − p_C)²`
≈ `((1.96 + 0.84)² · (0.25 + 0.2275)) / 0.0225`
≈ `(7.84 · 0.4775) / 0.0225`
≈ **166 sessions per arm on repeat topics.**

At ~10⁴ sessions/month, the proportion that hit "repeat topics" is the binding constraint. If 30% of sessions are on repeat topics (our conservative guess), we get ~3000 repeat-topic sessions/month, easily 1500 per arm. That gets us to **~166 needed sessions per arm** in roughly **3–5 days of measurement traffic** during phase 2.

**Practical schedule:**
- Phase 1 (warm-up): 4 weeks
- Phase 2 (measurement): 4 weeks (we run longer than statistically necessary to allow per-team breakdown analysis, which will be underpowered at 166 sessions/arm if we have >3 teams)

For H1 (median tool-calls reduction), we use a Mann–Whitney U test. For a 30% reduction in a distribution with substantial spread, the same sample size is comfortably sufficient.

### 5.5 Pre-registered failure conditions

The experiment is *negative* if any of:

- Treatment arm shows no statistically significant improvement on repeat topics.
- Treatment arm shows improvement on repeat topics but *regression* on novel topics (suggests memory is biasing the agent away from exploring).
- Per-team breakdown shows that one or more teams' success rates *dropped* by >5 pp (this is the §4.5 failure surfacing).
- Stale-edge rate climbs above 30% by week 8 of measurement (suggests doctree drift is faster than our consolidation can cope).

Any of these triggers a redesign before further engineering investment.

### 5.6 What this MVP does *not* tell us

Important to flag explicitly so expectations are calibrated:

- It does not measure the long-run value of the playbook bullets — those need months to accumulate.
- It does not test the privacy / poisoning robustness — those need adversarial probing, not natural traffic.
- It does not test cross-team generalisation — for that we'd need explicit "agent on team A solves a task previously solved on team B" trials.
- It does not benchmark against an embedding-based alternative. If the question becomes "is the lexical / graph / counter approach really better than just bolting on a vector DB?", that is a separate, larger experiment.

---

## Appendix · Full citation list

### Q1 — Foundations / agentic context engineering
- arXiv:2510.04618 — ACE (Zhang et al., Stanford / SambaNova / Berkeley, 2025)
- arXiv:2504.07952 — Dynamic Cheatsheet (Suzgun et al., Stanford, 2025; EACL 2026)
- arXiv:2303.11366 — Reflexion (Shinn et al., NeurIPS 2023)
- arXiv:2305.16291 — Voyager (Wang et al., NVIDIA / Caltech, 2023)
- arXiv:2304.03442 — Generative Agents (Park et al., Stanford / Google, UIST 2023)
- arXiv:2310.08560 — MemGPT / Letta (Packer et al., UC Berkeley, 2023)
- arXiv:2502.12110 — A-MEM (Xu et al., Rutgers, NeurIPS 2025)
- arXiv:2305.10250 — MemoryBank (Zhong et al., AAAI 2024)
- arXiv:2504.19413 — Mem0 / Mem0g (Chhikara et al., 2025)
- arXiv:2501.13956 — Zep / Graphiti (Rasmussen et al., 2025)

### Q2 — Credit assignment for retrieval trajectories
- arXiv:2305.18290 — DPO (Rafailov et al., NeurIPS 2023)
- arXiv:2406.14868 — DMPO (Shi et al., 2024)
- arXiv:2402.03300 — DeepSeekMath / GRPO (Shao et al., 2024)
- arXiv:2509.21154 — GRPO is Secretly a Process Reward Model (2025)
- arXiv:2310.10080 — Let's reward step by step (Ma et al., 2023)
- arXiv:2501.07301 — Lessons of Developing PRMs (Zhang et al., 2025)
- arXiv:2504.16828 — ThinkPRM (Khalifa et al., 2025)
- arXiv:2503.21295 — R-PRM (She et al., 2025)
- arXiv:2305.10601 — Tree of Thoughts (Yao et al., NeurIPS 2023)
- arXiv:2309.00267 — RLAIF (Lee et al., 2023)
- arXiv:2212.08073 — Constitutional AI (Bai et al., 2022)

### Q3 — Bandit / RL formulations for query selection
- arXiv:1003.0146 — LinUCB (Li, Chu, Langford, Schapire, WWW 2010) — foundational
- arXiv:1910.10410 — BanditRank (Gampa & Fujita, PAKDD 2021)
- arXiv:2307.12926 — Contextual Bandits with Preference-Based Active Queries (Sekhari et al., 2023)
- (CascadeHybrid online LTR — Li et al., UAI 2019; surfaced via search but no clean arXiv ID returned)

### Q4 — Relationship graph construction
- arXiv:2405.14831 — HippoRAG (Gutiérrez et al., NeurIPS 2024)
- arXiv:2404.16130 — Microsoft GraphRAG (Edge et al., 2024)
- arXiv:2410.05779 — LightRAG (Guo et al., EMNLP 2024)
- arXiv:2502.14902 — PathRAG (2025)
- arXiv:2412.06078 — Mixture-of-PageRanks / MixPR (2024)
- arXiv:2604.05333 — Graph of Skills (2026)
- arXiv:2408.08921 — Graph RAG Survey (Peng et al., 2024)
- arXiv:2501.00309 — Retrieval-Augmented Generation with Graphs survey (Han et al., 2024)
- arXiv:2403.05198 — Personalized PageRank Computation Survey (Yang et al., 2024)

### Q5 — Multi-agent / team sharing
- arXiv:2308.00352 — MetaGPT (Hong et al., ICLR 2024)
- arXiv:2308.10848 — AgentVerse (Chen et al., 2023)
- arXiv:2404.09982 — Memory Sharing / INMS (Gao & Zhang, Rutgers, 2024; v3 2026)
- arXiv:2505.18279 — Collaborative Memory (2025)
- arXiv:2506.22815 — Memory as a Service (MaaS) (2025)
- arXiv:2507.06229 — Agent KB (Tang et al., OPPO PersonalAI, 2025)
- arXiv:2603.10062 — Multi-Agent Memory from a Computer Architecture Perspective (2026)

### Q6 — Forgetting / consolidation / drift
- arXiv:2305.10250 — MemoryBank (re-cited; Ebbinghaus decay)
- arXiv:2502.12110 — A-MEM (re-cited; memory evolution)
- arXiv:2304.03442 — Generative Agents (re-cited; reflection)
- arXiv:2512.12856 — Forgetful but Faithful (2025)
- arXiv:2501.13956 — Zep / Graphiti (re-cited; dual-timestamp invalidation)

### Q7 — Evaluation
- arXiv:2308.03688 — AgentBench (Liu et al., ICLR 2024)
- arXiv:2406.12045 — τ-bench (Yao et al., 2024)
- arXiv:2506.07982 — τ²-bench (Barres et al., 2025)
- arXiv:2310.06770 — SWE-bench (Jimenez et al., ICLR 2024)
- arXiv:2509.16941 — SWE-Bench Pro (2025)
- arXiv:2410.10813 — LongMemEval (Wu et al., ICLR 2025)
- arXiv:2507.21504 — Evaluation and Benchmarking of LLM Agents survey (2025)

### Non-arXiv sources, flagged
- **PageIndex** (Vectify AI, 2024–2025). Tree-based vectorless retrieval. Product blog + GitHub repo at github.com/VectifyAI/PageIndex. No published arXiv paper as of writing.
- **Pagefind** (CloudCannon). Static-site BM25 + facet search. Product, no arXiv paper.
- arXiv:2511.18177 — Rethinking Retrieval (2025). Academic-style survey that cites PageIndex via blog URLs.
- VentureBeat, InfoQ, MarkTechPost coverage of ACE — used only to confirm arXiv-paper context, not as primary evidence.

---

*End of report.*
