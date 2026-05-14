import { defineConfig } from 'vitepress'

const siteUrl = 'https://cctabs.com'
const ogTitle = 'cctabs — Self-aware agentic coding across terminal tabs'
const ogDescription = 'Install one plugin and Claude spawns 10, 15 parallel sessions on its own — each in a named terminal tab. No tmux. No TUI.'

export default defineConfig({
  title: 'cctabs',
  description: 'Self-aware agentic coding across terminal tabs. Install one plugin and Claude spawns parallel sessions — each in a named terminal tab. No tmux. No TUI.',
  lang: 'en-US',
  cleanUrls: true,

  sitemap: {
    hostname: siteUrl,
  },

  head: [

    // OpenGraph
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: siteUrl }],
    ['meta', { property: 'og:image', content: `${siteUrl}/og.png` }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { property: 'og:title', content: ogTitle }],
    ['meta', { property: 'og:description', content: ogDescription }],
    ['meta', { property: 'og:site_name', content: 'cctabs' }],

    // Twitter / X card
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: ogTitle }],
    ['meta', { name: 'twitter:description', content: ogDescription }],
    ['meta', { name: 'twitter:image', content: `${siteUrl}/og.png` }],

    // Additional SEO
    ['meta', { name: 'author', content: 'generativereality' }],
    ['meta', { name: 'keywords', content: 'cctabs, claude code, ai coding, terminal sessions, agent orchestration, claude code sessions, multi-agent, wave terminal' }],

    // Google tag (gtag.js) — cookieless config, no banner required
    ['script', { async: '', src: 'https://www.googletagmanager.com/gtag/js?id=G-KW9J78R8C6' }],
    ['script', {}, `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'granted'});gtag('js',new Date());gtag('config','G-KW9J78R8C6',{client_storage:'none',anonymize_ip:true,allow_google_signals:false,allow_ad_personalization_signals:false});`],

  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'cctabs',
    nav: [
      { text: 'Guide', link: '/guide/what-is-cctabs' },
      { text: 'Reference', link: '/reference/commands' },
      { text: 'Changelog', link: '/changelog' },
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
          { text: 'Troubleshooting', link: '/guide/troubleshooting' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Commands', link: '/reference/commands' },
          { text: 'Changelog', link: '/changelog' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/generativereality/cctabs' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@generativereality/cctabs' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Augmented Mind',
    },
  },
})
