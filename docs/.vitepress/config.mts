import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Agent SDK',
  description: 'A composable agent runtime for deterministic tool use, adaptive planning, configurable reasoning, context compaction, and multi-agent orchestration.',
  base: '/agent-sdk/',
  ignoreDeadLinks: true,
  appearance: false,
  themeConfig: {
    logo: '/agent-sdk-logo.svg',
    siteTitle: 'agent-sdk',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Architecture', link: '/guide/architecture' },
      { text: 'API Reference', link: '/api/agent' },
      { text: 'Examples', link: '/examples/' },
      {
        text: 'v0.6.1',
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Contributing', link: '/contributing' },
        ],
      },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Native Providers', link: '/guide/native-providers' },
            { text: 'Core Concepts', link: '/guide/core-concepts' },
            { text: 'Architecture', link: '/guide/architecture' },
          ],
        },
        {
          text: 'Features',
          items: [
            { text: 'Runtime Profiles', link: '/guide/runtime-profiles' },
            { text: 'Planning for Autonomous Agents', link: '/guide/planning' },
            { text: 'Summarization & Context', link: '/guide/summarization' },
            { text: 'Tool Development', link: '/guide/tool-development' },
            { text: 'Guardrails', link: '/guide/guardrails' },
            { text: 'State Management', link: '/guide/state-management' },
            { text: 'Structured Output', link: '/guide/structured-output' },
            { text: 'Tool Approvals', link: '/guide/tool-approvals' },
            { text: 'MCP Integration', link: '/guide/mcp' },
          ],
        },
        {
          text: 'Advanced',
          items: [
            { text: 'Limits & Tokens', link: '/guide/limits-tokens' },
            { text: 'Debugging & Tracing', link: '/guide/debugging' },
            { text: 'FAQ', link: '/guide/faq' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Overview', link: '/api/' },
            { text: 'Agent Construction', link: '/api/agent' },
            { text: 'Tools & Context Tools', link: '/api/tools' },
            { text: 'Adapters & Models', link: '/api/adapters' },
            { text: 'Prompting & Planning', link: '/api/prompts' },
            { text: 'State & Public Types', link: '/api/types' },
            { text: 'Runtime Internals', link: '/api/nodes' },
          ],
        },
      ],
      '/examples/': [
        {
          text: 'Start Here',
          items: [
            { text: 'Overview', link: '/examples/' },
          ],
        },
        {
          text: 'Fundamentals',
          items: [
            { text: 'Basic Agent', link: '/examples/basic' },
            { text: 'Tools', link: '/examples/tools' },
          ],
        },
        {
          text: 'Smart Runtime',
          items: [
            { text: 'Planning & TODOs', link: '/examples/planning' },
            { text: 'Summarization', link: '/examples/summarization' },
            { text: 'Archived Tool Retrieval', link: '/examples/summarize-context' },
            { text: 'Rewrite After Summary', link: '/examples/rewrite-summary' },
            { text: 'Tool Limit Finalize', link: '/examples/tool-limit' },
          ],
        },
        {
          text: 'Control & Safety',
          items: [
            { text: 'Tool Approval', link: '/examples/tool-approval' },
            { text: 'Pause & Resume', link: '/examples/pause-resume' },
            { text: 'Structured Output', link: '/examples/structured-output' },
            { text: 'Guardrails', link: '/examples/guardrails' },
          ],
        },
        {
          text: 'Orchestration',
          items: [
            { text: 'Multi-Agent', link: '/examples/multi-agent' },
            { text: 'Handoff', link: '/examples/handoff' },
          ],
        },
        {
          text: 'Integrations',
          items: [
            { text: 'Vision', link: '/examples/vision' },
            { text: 'MCP Tools', link: '/examples/mcp' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Cognipeer/agent-sdk' },
    ],
    footer: {
      message: 'Agent SDK is part of the Cognipeer platform.',
      copyright: 'Copyright © 2026 Cognipeer',
    },
    search: {
      provider: 'local',
    },
  },
  head: [
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    ['link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Lexend+Deca:wght@400;500;600;700;800&display=swap' }],
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/agent-sdk/favicon.svg' }],
      ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/agent-sdk/favicon-32x32.png' }],
      ['link', { rel: 'icon', type: 'image/png', sizes: '16x16', href: '/agent-sdk/favicon-16x16.png' }],
      ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/agent-sdk/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#00b5a5' }],
    ['meta', { name: 'og:type', content: 'website' }],
    ['meta', { name: 'og:locale', content: 'en' }],
    ['meta', { name: 'og:site_name', content: 'Agent SDK Documentation' }],
  ],
});
