import { defineConfig } from 'vitepress';

// https://vitepress.dev/reference/site-config
export default defineConfig({
    lang: 'en-US',
    title: 'Bifröst',
    description: 'A bridge between Discord and Fluxer',
    appearance: 'force-dark',
    themeConfig: {
        // https://vitepress.dev/reference/default-theme-config
        logo: '/logo.svg',
        nav: [
            { text: 'Home', link: '/' },
            { text: 'Guide', link: '/guide/getting-started' },
            { text: 'Legal', link: '/legal' },
        ],

        sidebar: [
            {
                text: 'Guide',
                items: [
                    { text: 'Getting Started', link: '/guide/getting-started' },
                    { text: 'Self Hosting Guide', link: '/guide/self-hosting' },
                ],
            },
        ],

        socialLinks: [
            {
                icon: 'github',
                link: 'https://github.com/KartoffelChipss/bifrost',
            },
        ],
    },
    head: [
        [
            'script',
            {
                defer: '',
                src: 'https://umami.jan.run/script.js',
                'data-website-id': '2393e86d-771a-469c-bcd2-bb3d372b12f0',
            },
        ],
    ],
});
