import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'orager',
  description: 'Production-grade AI agent runtime',
  base: '/',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'CLI Reference', link: '/guide/cli-reference' },
      { text: 'Architecture', link: '/adr/' },
      { text: 'GitHub', link: 'https://github.com/JayCodesX/orager' },
    ],
    sidebar: {
      '/guide/': [
        { text: 'Getting Started', link: '/guide/getting-started' },
        { text: 'CLI Reference', link: '/guide/cli-reference' },
        { text: 'Configuration', link: '/guide/configuration' },
        { text: 'Memory System', link: '/guide/memory' },
        { text: 'Skills & Learning', link: '/guide/skills' },
      ],
      '/adr/': [
        { text: 'ADR Index', link: '/adr/' },
        { text: 'ADR-0001: Hierarchical Memory', link: '/adr/0001-hierarchical-memory-system' },
        { text: 'ADR-0002: ANN Vector Index', link: '/adr/0002-ann-vector-index' },
        { text: 'ADR-0003: In-Process Agents', link: '/adr/0003-in-process-agents-remove-daemon' },
        { text: 'ADR-0004: Semantic Memory Retrieval', link: '/adr/0004-semantic-memory-retrieval-distillation' },
        { text: 'ADR-0005: Multi-Context Memory', link: '/adr/0005-multi-context-cross-agent-memory' },
        { text: 'ADR-0006: SkillBank', link: '/adr/0006-skillbank-persistent-skill-memory' },
        { text: 'ADR-0007: OMLS Training', link: '/adr/0007-omls-opportunistic-rl-training' },
        { text: 'ADR-0008: Storage Overhaul', link: '/adr/0008-storage-architecture-overhaul' },
        { text: 'ADR-0009: Local-First Inference', link: '/adr/0009-local-first-inference-client-architecture' },
        { text: 'ADR-0010: Provider Adapters', link: '/adr/0010-provider-adapter-system' },
      ]
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/JayCodesX/orager' }
    ],
    footer: {
      message: 'Released under the MIT License.'
    }
  }
})
