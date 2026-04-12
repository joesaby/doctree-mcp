import { describe, test, expect } from "bun:test";
import { formatFindSimilarResult, formatDraftResult } from "../src/tools";

describe("formatFindSimilarResult", () => {
  test("formats matches above threshold with merge suggestion", () => {
    const result = {
      matches: [
        {
          doc_id: "docs:auth:middleware",
          title: "Auth Middleware",
          file_path: "docs/wiki/auth/middleware.md",
          score: 12.4,
          overlap_ratio: 0.42,
          matched_terms: ["jwt", "auth"],
        },
        {
          doc_id: "docs:auth:oauth",
          title: "OAuth Flow",
          file_path: "docs/wiki/auth/oauth.md",
          score: 5.1,
          overlap_ratio: 0.18,
          matched_terms: ["auth"],
        },
      ],
      suggest_merge: true,
      highest_overlap: 0.42,
    };
    const text = formatFindSimilarResult(result, 0.35);
    expect(text).toContain("[overlap: 0.42]");
    expect(text).toContain("Auth Middleware");
    expect(text).toContain("middleware.md");
    expect(text).toContain("Consider updating");
    expect(text).toContain("[overlap: 0.18]");
    expect(text).toContain("navigate_tree");
  });

  test("formats empty matches", () => {
    const result = { matches: [], suggest_merge: false, highest_overlap: 0 };
    const text = formatFindSimilarResult(result, 0.35);
    expect(text).toContain("No similar documents found");
  });

  test("shows all matches but only flags ones above threshold", () => {
    const result = {
      matches: [
        { doc_id: "docs:a", title: "A", file_path: "a.md", score: 1, overlap_ratio: 0.5, matched_terms: [] },
        { doc_id: "docs:b", title: "B", file_path: "b.md", score: 1, overlap_ratio: 0.1, matched_terms: [] },
      ],
      suggest_merge: true,
      highest_overlap: 0.5,
    };
    const text = formatFindSimilarResult(result, 0.35);
    expect(text).toContain("[overlap: 0.50]");
    expect(text).toContain("[overlap: 0.10]");
    // Only the high-overlap match gets the update suggestion
    expect(text.indexOf("Consider updating")).toBeLessThan(text.indexOf("[overlap: 0.10]"));
  });
});

describe("formatDraftResult", () => {
  test("formats draft with all fields", () => {
    const result = {
      suggested_path: "docs/wiki/auth/jwt-validation.md",
      frontmatter: {
        title: "JWT Validation",
        description: "How JWT tokens are validated",
        type: "reference",
        category: "auth",
        tags: ["jwt", "auth", "middleware"],
      },
      glossary_hits: ["JWT → JSON Web Token"],
      similar_docs: [
        {
          doc_id: "docs:auth:middleware",
          title: "Auth Middleware",
          file_path: "auth/middleware.md",
          score: 5,
          overlap_ratio: 0.42,
          matched_terms: [],
        },
      ],
      duplicate_warning: true,
    };
    const text = formatDraftResult(result);
    expect(text).toContain("Wiki Entry Draft");
    expect(text).toContain("jwt-validation.md");
    expect(text).toContain("JWT Validation");
    expect(text).toContain("reference");
    expect(text).toContain("JWT → JSON Web Token");
    expect(text).toContain("Auth Middleware");
    expect(text).toContain("⚠ Warning");
  });

  test("formats draft with no similar docs or glossary hits", () => {
    const result = {
      suggested_path: "docs/wiki/setup.md",
      frontmatter: { title: "Setup", type: "guide", tags: ["setup"] },
      glossary_hits: [],
      similar_docs: [],
      duplicate_warning: false,
    };
    const text = formatDraftResult(result);
    expect(text).toContain("setup.md");
    expect(text).not.toContain("Glossary hits");
    expect(text).not.toContain("⚠ Warning");
  });
});
