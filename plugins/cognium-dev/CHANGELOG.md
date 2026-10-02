# Changelog

All notable changes to the Cognium SAST plugin (`cognium-dev`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-02

### Changed

- **The plugin moved to [cogniumhq/cognium-mcp](https://github.com/cogniumhq/cognium-mcp)**, next to the MCP server it drives. Its files, its name (`cognium-dev`) and the marketplace name (`cognium`) are unchanged.
- A marketplace added from the old repository has to be added again from the new one: in Claude Code, `/plugin marketplace add cogniumhq/cognium-mcp`; in Cursor, import `https://github.com/cogniumhq/cognium-mcp`.
- The MCP configuration is unchanged: it still starts `@cognium/mcp-server` through `npx`.

## [0.1.0] - 2026-08-31

### Added

- Cursor plugin bundle: MCP (`@cognium/mcp-server` via `npx`), skills, rules, commands, and a SAST reviewer agent.
- Repo-root `.cursor-plugin/marketplace.json` so this GitHub repository can be imported as a Cursor team marketplace.
- Claude Code manifests: `.claude-plugin/plugin.json`, `.mcp.json`, and repo-root `.claude-plugin/marketplace.json` (`name`: `cognium`).
- OpenAI skills-only packaging notes in `openai/README.md` (no hosted MCP URL).
