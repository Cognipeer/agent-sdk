# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [0.1.1] - 2025-10-09

### Changed
- Restructured project to publish from root directory instead of nested agent-sdk folder
- Aligned project structure with industry standards (similar to cgate-sdk)
- Reorganized examples directory with unified package.json
- Improved build configuration with tsup
- Updated TypeScript configuration for better compatibility
- Cleaned up .gitignore for cleaner repository

### Added
- PROJECT_STRUCTURE.md for comprehensive project documentation
- Unified examples/package.json with all example scripts
- examples/README.md with usage guide
- tsup.config.ts for optimized builds

### Fixed
- Build process now outputs to dist/ at root level
- Package exports correctly configured for ESM and CommonJS

## [0.1.0] - Previous

### Added
- Initial release of Agent SDK
- Core Agent class with composable architecture
- Pluggable model adapters (OpenAI, Anthropic)
- Tool/function calling support
- Graph-based workflows
- Safety guardrails
- Context management
- Structured output generation
- Multi-agent orchestration
- Vision capabilities
- MCP (Model Context Protocol) integration
- Comprehensive documentation with VitePress
- Multiple example projects
- Full TypeScript support
