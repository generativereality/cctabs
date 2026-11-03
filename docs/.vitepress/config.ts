import { defineConfig } from 'vitepress'

const siteUrl = 'https://cctabs.com'
const ogTitle = 'cctabs — Make Claude Code aware of the other tabs in your terminal'
const ogDescription = 'cctabs makes Claude Code aware of the other tabs in your terminal, so it can message them and hand out work. Nothing more, nothing less: your terminal and your tabs stay as they are. Tabby is supported today. For people who keep many Claude Code or Codex CLI sessions open; every tab can run its own account or backend, and the whole fleet comes back after a restart.'

export default defineConfig({
  title: 'cctabs',
  description: ogDescription,
  lang: 'en-US',
  cleanUrls: true,

  sitemap: {
    hostname: siteUrl,
  },

  // VitePress emits no canonical link of its own.
  transformPageData(pageData) {
    const path = pageData.relativePath.replace(/(index)?\.md$/, '')
    pageData.frontmatter.head ??= []
    pageData.frontmatter.head.push([
      'link',
      { rel: 'canonical', href: `${siteUrl}/${path}` },
    ])
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
    ['meta', { name: 'author', content: 'Augmented Mind' }],
    ['meta', { name: 'keywords', content: 'cctabs, claude code, claude code sessions, parallel claude code sessions, claude code session manager, terminal tabs, agent orchestration, multi-agent, tabby terminal, tmux alternative' }],

    // Google tag (gtag.js) — cookieless config, no banner required
    ['script', { async: '', src: 'https://www.googletagmanager.com/gtag/js?id=G-KW9J78R8C6' }],
    ['script', {}, `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'granted'});gtag('js',new Date());gtag('config','G-KW9J78R8C6',{client_storage:'none',anonymize_ip:true,allow_google_signals:false,allow_ad_personalization_signals:false});`],

    // Cloudflare Web Analytics — explicit injection; CF auto-inject is unreliable on this Pages project
    ['script', { defer: '', src: 'https://static.cloudflareinsights.com/beacon.min.js', 'data-cf-beacon': '{"token": "c7fb105b8a8042e6a8133dc310dbabc9"}' }],

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
      message: 'Released under the MIT License. · <a href="/privacy">Privacy</a>',
      copyright: 'Copyright © 2026 Augmented Mind',
    },
  },
})
