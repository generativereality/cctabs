import { defineConfig } from 'vitepress'

const siteUrl = 'https://cctabs.com'
const ogTitle = 'cctabs — tab-awareness for Claude Code'
const ogDescription = 'Run massively parallel Claude Code sessions. Tab-aware CLI that lets you open, fork, inspect, and coordinate sessions across native terminal tabs.'

export default defineConfig({
  title: 'cctabs',
  description: 'Tab-awareness for Claude Code. Run massively parallel sessions across native terminal tabs, no tmux.',
  lang: 'en-US',

  sitemap: {
    hostname: siteUrl,
  },

  head: [
    // OpenGraph
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: siteUrl }],
    ['meta', { property: 'og:title', content: ogTitle }],
    ['meta', { property: 'og:description', content: ogDescription }],
    ['meta', { property: 'og:site_name', content: 'cctabs' }],

    // Twitter / X card
    ['meta', { name: 'twitter:card', content: 'summary' }],
    ['meta', { name: 'twitter:title', content: ogTitle }],
    ['meta', { name: 'twitter:description', content: ogDescription }],

    // Additional SEO
    ['meta', { name: 'author', content: 'generativereality' }],
    ['meta', { name: 'keywords', content: 'claude code, cctabs, terminal tabs, parallel sessions, ai coding, multi-agent, wave terminal, session manager' }],
  ],

  themeConfig: {
    siteTitle: 'cctabs',
    nav: [
      { text: 'Guide', link: '/guide/what-is-cctabs' },
      { text: 'Reference', link: '/reference/commands' },
      { text: 'GitHub', link: 'https://github.com/generativereality/cctabs' },
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'What is cctabs?', link: '/guide/what-is-cctabs' },
          { text: 'Getting Started', link: '/guide/getting-started' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Session Workflows', link: '/guide/workflows' },
          { text: 'Claude Code Skill', link: '/guide/claude-code-skill' },
          { text: 'Configuration', link: '/guide/configuration' },
        ],
      },
      {
        text: 'Reference',
        items: [{ text: 'Commands', link: '/reference/commands' }],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/generativereality/cctabs' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@generativereality/cctabs' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025 generativereality',
    },
  },
})
