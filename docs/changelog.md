# Changelog

## [0.1.3] - 2025-01-06

### Changed
- Updated all example README files with consistent structure and npm run commands
- Improved examples/README.md with better categorization and detailed instructions
- Enhanced documentation for running examples with two-step installation process
- Updated main README.md with clearer example execution instructions

### Fixed
- Installation instructions now clearly indicate root and examples directory setup
- Example execution commands now consistently use `npm run example:<name>` format
- All example READMEs now include both npm run and direct tsx execution methods

## [0.1.1] - 2025-01-XX

### Added
- VitePress documentation with modern UI
- Comprehensive API reference
- Interactive examples with code snippets
- GitHub Pages deployment workflow
- Logo and branding assets

### Changed
- Migrated from Jekyll to VitePress for documentation
- Reorganized documentation structure
- Improved navigation and search

### Documentation
- New guide structure with clear categorization
- Enhanced API documentation with TypeScript examples
- Added planning and multi-agent guides
- Created example-focused documentation

## [0.1.0] - Initial Release

### Added
- Core agent loop with `createSmartAgent` and `createAgent`
- Planning mode with TODO management
- Token-aware summarization
- Structured output with Zod schemas
- Tool limits (total and parallel)
- Multi-agent composition via `asTool` and `asHandoff`
- LangChain and MCP adapters
- Tracing and debugging support
- Guardrails system
- Pause and resume functionality
- Vision/multimodal support

### Features
- Type-safe tool development
- Provider usage normalization
- Structured JSON tracing
- Event streaming with `onEvent`
- State snapshots for resumability
- Tool approval workflows

---

For detailed changes, see [GitHub Releases](https://github.com/Cognipeer/agent-sdk/releases).
