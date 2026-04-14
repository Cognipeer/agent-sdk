# Agent SDK - Project Structure

Complete overview of the Cognipeer Agent SDK project.

## 📁 Project Structure

```
agent-sdk/
├── src/                          # Source code
│   ├── index.ts                  # Main entry point & exports
│   ├── agent.ts                  # Core Agent class
│   ├── model.ts                  # Model interface & types
│   ├── tool.ts                   # Tool definitions
│   ├── prompts.ts                # Prompt templates
│   ├── contextTools.ts           # Context management
│   ├── types.ts                  # TypeScript type definitions
│   ├── providers/                # Native LLM provider layer (no LangChain)
│   │   ├── index.ts              # Factory (createProvider) & barrel exports
│   │   ├── types.ts              # Unified request/response/token-usage types
│   │   ├── base.ts               # Abstract BaseProvider class
│   │   ├── adapter.ts            # fromNativeProvider() – wraps provider as BaseChatModel
│   │   ├── openai.ts             # OpenAI Chat Completions API
│   │   ├── anthropic.ts          # Anthropic Messages API
│   │   ├── azure.ts              # Azure OpenAI (extends OpenAI)
│   │   ├── openaiCompatible.ts   # Any OpenAI-compatible endpoint
│   │   ├── bedrock.ts            # AWS Bedrock Converse API + SigV4 signing
│   │   ├── vertex.ts             # Google Vertex AI (Gemini) + service account auth
│   │   └── utils/
│   │       ├── sse.ts            # SSE stream parser
│   │       └── sigv4.ts          # AWS Signature V4 implementation
│   ├── adapters/                 # LangChain model/tool adapters
│   │   └── langchain.ts
│   ├── graph/                    # Graph-based workflows
│   ├── guardrails/               # Safety guardrails
│   ├── nodes/                    # Agent nodes
│   ├── smart/                    # Smart features
│   ├── structuredOutput/         # Structured output strategies
│   ├── utils/                    # Utilities
│   └── internal/                 # Internal utilities
│
├── docs/                         # Documentation (VitePress)
│   ├── .vitepress/
│   │   └── config.ts             # VitePress configuration
│   ├── index.md                  # Documentation homepage
│   ├── getting-started/          # Getting started guides
│   ├── guide/                    # User guides
│   ├── core-concepts/            # Core concepts
│   ├── api/                      # API reference
│   ├── examples/                 # Example documentation
│   ├── tools/                    # Tool documentation
│   ├── nodes/                    # Node documentation
│   ├── guardrails/               # Guardrails documentation
│   ├── debugging/                # Debugging guides
│   └── architecture/             # Architecture docs
│
├── examples/                     # Code examples
│   ├── package.json              # Examples package config
│   ├── README.md                 # Examples guide
│   ├── basic/                    # Basic usage
│   ├── tools/                    # Tool examples
│   ├── guardrails/               # Guardrails examples
│   ├── multi-agent/              # Multi-agent examples
│   ├── structured-output/        # Structured output
│   ├── vision/                   # Vision capabilities
│   ├── mcp-tavily/               # MCP integration
│   └── ...                       # More examples
│
├── dist/                         # Build output (generated)
│   ├── index.cjs                 # CommonJS build
│   ├── index.mjs                 # ESM build
│   └── index.d.ts                # Type definitions
│
├── logs/                         # Runtime logs (gitignored)
│
├── package.json                  # Package configuration
├── tsconfig.json                 # TypeScript configuration
├── tsup.config.ts                # Build configuration
├── .gitignore                    # Git ignore rules
├── README.md                     # Main README
├── CHANGELOG.md                  # Version history
├── CONTRIBUTING.md               # Contribution guide
└── LICENSE                       # MIT License
```

## 🎯 Key Features

### Core SDK Features
- ✅ Composable agent architecture
- ✅ Native LLM providers (OpenAI, Anthropic, Azure, Bedrock, Vertex, OpenAI-compatible) – no LangChain needed
- ✅ Unified request/response schema with full token-usage tracking (input/output/cached/reasoning)
- ✅ LangChain model & tool adapters (optional)
- ✅ Tool/function calling support
- ✅ Graph-based workflows
- ✅ Safety guardrails
- ✅ Context management
- ✅ Structured output generation
- ✅ Multi-agent orchestration
- ✅ Vision capabilities (base64 & URL images)
- ✅ Full TypeScript support
- ✅ MCP (Model Context Protocol) integration

### Documentation Features
- ✅ VitePress-based documentation site
- ✅ GitHub Pages compatible
- ✅ Interactive code examples
- ✅ API reference documentation
- ✅ Comprehensive guides and tutorials
- ✅ Architecture documentation

### Developer Experience
- ✅ ESM and CommonJS support
- ✅ Tree-shakeable builds
- ✅ Comprehensive type definitions
- ✅ Multiple example projects
- ✅ Code linting support

## 🚀 Quick Start

### 1. Installation

```bash
npm install @cognipeer/agent-sdk
```

### 2. Build

```bash
npm run build
```

### 3. Run Examples

```bash
cd examples
npm install
npm run example:basic
```

## 📦 Package Output

The package is built and published from the root directory with the following structure:

```
@cognipeer/agent-sdk/
├── dist/
│   ├── index.cjs      # CommonJS format
│   ├── index.mjs      # ES Module format
│   └── index.d.ts     # TypeScript definitions
├── package.json
└── README.md
```

## 🔧 Development Scripts

- `npm run build` - Build the package
- `npm run dev` - Build in watch mode
- `npm run lint` - Lint the code
- `npm run docs:dev` - Run documentation dev server
- `npm run docs:build` - Build documentation
- `npm run docs:preview` - Preview built documentation

## 📝 Notes

- The package is published as `@cognipeer/agent-sdk` on npm
- Source code is in `src/` directory
- Build output goes to `dist/` directory
- Examples are in separate `examples/` package
- Documentation is in `docs/` directory
- Logs are generated at runtime in `logs/` directory
