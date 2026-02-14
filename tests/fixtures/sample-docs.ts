/**
 * Shared test fixtures for doctree-mcp tests.
 *
 * Provides in-memory markdown content, frontmatter variations,
 * and directory structures for testing without filesystem I/O.
 */

export const SIMPLE_DOC = `---
title: "Auth Middleware Guide"
description: "How to implement token refresh in the auth middleware"
tags: [authentication, jwt, security]
category: guide
---

# Auth Middleware Guide

Overview of the auth middleware system.

## Token Refresh Flow

The middleware automatically refreshes expired tokens using the stored refresh token.

### Automatic Refresh

When a request comes in with an expired access token, the middleware:
1. Checks the refresh token validity
2. Calls the token endpoint
3. Updates the session

### Manual Refresh API

Call \`POST /auth/refresh\` with:
\`\`\`json
{ "refresh_token": "..." }
\`\`\`

## Error Handling

When token refresh fails, the middleware returns a 401 status and clears the session.
`;

export const DOC_NO_FRONTMATTER = `# Simple Document

This document has no frontmatter at all.

## Section One

Content for section one.

## Section Two

Content for section two with some code:

\`\`\`typescript
const x = 42;
console.log(x);
\`\`\`
`;

export const DOC_GENERIC_TITLE = `---
title: "Introduction"
---

# Introduction

This is an introduction to the system.

## Getting Started

Follow these steps to get started.
`;

export const DOC_WITH_TYPE = `---
title: "Database Runbook"
type: runbook
tags: [database, postgres, ops]
---

# Database Runbook

## Restart Procedure

Steps to restart the database safely.

## Backup Verification

How to verify backups are current.
`;

export const DOC_WITH_ABBREVIATIONS = `---
title: "SSE Alert Configuration"
tags: [sse, alerts]
---

# Alert Configuration

Configure server-sent events (SSE) alerting for the ingress landing gateway.

## PagerDuty Integration

Set up PagerDuty for SSE alert routing.

## Metrics Dashboard

Monitor  server-sent events throughput and connection health.
`;

export const DOC_MINIMAL = `# Just a Heading

Single paragraph of content with no frontmatter, no subheadings.
`;

export const DOC_DEEP_NESTING = `---
title: "Deeply Nested Document"
tags: [architecture]
---

# Level 1

Top level content.

## Level 2

Second level content.

### Level 3

Third level content.

#### Level 4

Fourth level content.

##### Level 5

Fifth level content.

###### Level 6

Sixth level content.
`;

export const DOC_EMPTY_FRONTMATTER = `---
---

# Document With Empty Frontmatter

Some content here.
`;

export const DOC_CODE_HEAVY = `---
title: "API Reference"
tags: [api, rest]
category: reference
---

# API Reference

## Authentication Endpoint

\`\`\`bash
curl -X POST https://api.example.com/auth/token \\
  -H "Content-Type: application/json" \\
  -d '{"username": "admin", "password": "secret"}'
\`\`\`

Response:

\`\`\`json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_in": 3600,
  "token_type": "Bearer"
}
\`\`\`

## User Endpoint

\`\`\`bash
curl https://api.example.com/users/me \\
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
\`\`\`
`;

export const SAMPLE_GLOSSARY = {
  SSE: ["server-sent events"],
  Ingress: ["Ingress gateway"],
  JWT: ["json web token"],
  K8s: ["kubernetes"],
  DB: ["database"]
};
