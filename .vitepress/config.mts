import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import llmstxt from 'vitepress-plugin-llms'

export default withMermaid(
  defineConfig({
    title: 'Klap Docs',
    description:
      'Klap — non-custodial crypto payments. API reference, Node.js SDK, and types, merged by resource.',
    cleanUrls: true,
    lastUpdated: true,
    srcExclude: ['CLAUDE.md', 'README.md', 'graft/**'],
    appearance: 'force-dark',
    head: [['link', { rel: 'icon', type: 'image/png', href: '/favicon.png' }]],

    vite: {
      plugins: [llmstxt({ domain: 'https://docs.klappay.com', ignoreFiles: ['CLAUDE.md', 'README.md', 'graft/**'] })],
    },

    themeConfig: {
      logo: '/logo.png',

      nav: [
        { text: 'Home', link: '/' },
        { text: 'Getting started', link: '/getting-started' },
        { text: 'Dashboard', link: 'https://app.klappay.com' },
        { text: 'API Playground', link: 'https://api.klappay.com/' },
        { text: 'npm', link: 'https://www.npmjs.com/package/@klappay/node' },
        { text: 'Changelog', link: 'https://api.klappay.com/types/changelog' },
      ],

      sidebar: [
        {
          text: 'Overview',
          items: [
            { text: 'Introduction', link: '/' },
            { text: 'How it works', link: '/how-it-works' },
            { text: 'Getting started', link: '/getting-started' },
            { text: 'Authentication', link: '/authentication' },
          ],
        },
        {
          text: 'Resources',
          items: [
            { text: 'Charges', link: '/charges' },
            { text: 'Webhooks', link: '/webhooks' },
            { text: 'Sandbox', link: '/sandbox' },
            { text: 'Metrics', link: '/metrics' },
            { text: 'Distributions', link: '/distributions' },
            { text: 'Recipients', link: '/recipients' },
            { text: 'Networks & tokens', link: '/networks' },
          ],
        },
        {
          text: 'Guides',
          items: [
            { text: 'Build a checkout flow', link: '/guides/checkout-flow' },
            { text: 'Real-time status (SSE)', link: '/realtime' },
            { text: 'Errors', link: '/errors' },
            { text: 'Tree-shaking (Node SDK)', link: '/sdk/tree-shaking' },
          ],
        },
      ],

      search: {
        provider: 'local',
      },

      socialLinks: [{ icon: 'github', link: 'https://github.com/klappay' }],

      footer: {
        message:
          'Klap API, Node.js SDK and types reference.',
        copyright: 'MIT — Klap',
      },
    },
  }),
)
