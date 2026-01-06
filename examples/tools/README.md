# Tools Example

Demonstrates multiple tools including a web search tool. Requires environment variables.

Uses `fromLangchainModel` to adapt a LangChain `ChatOpenAI` model. Messages are plain objects (`{ role, content }`).

## Run

From the `examples/` directory:

```bash
# Set your API keys
export TAVILY_API_KEY=tvly-...
export OPENAI_API_KEY=sk-...

# Run the example
npm run example:tools
```

Or directly:
```bash
TAVILY_API_KEY=... OPENAI_API_KEY=... npx tsx tools/tools.ts
```
