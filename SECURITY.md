# Security Policy

The server runs on developer machines and reads the projects it is pointed
at, so we take vulnerabilities in this codebase seriously.

## Supported versions

Security fixes ship on the latest minor version of `@cognium/mcp-server` and
the one before it. Older releases receive patches only for critical issues at
maintainer discretion.

Current published version: see
[@cognium/mcp-server on npm](https://www.npmjs.com/package/@cognium/mcp-server).

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Please use GitHub's private vulnerability reporting channel:

- [Report a vulnerability](https://github.com/cogniumhq/cognium-mcp/security/advisories/new)

Include:

- The affected version(s).
- A minimal reproducer — an MCP request, a project layout, or a client
  configuration that demonstrates the issue.
- Impact assessment (what an attacker can achieve).
- Any suggested remediation, if you have one.

A vulnerability in the analysis engine itself (`circle-ir`) belongs in
[cogniumhq/cognium-dev](https://github.com/cogniumhq/cognium-dev/security/advisories/new).

## What to expect

- **Acknowledgement:** within 48 hours (business days).
- **Triage and severity assessment:** within 5 business days of acknowledgement.
- **Fix and disclosure:** coordinated with the reporter.
