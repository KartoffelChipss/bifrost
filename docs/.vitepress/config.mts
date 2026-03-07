import { defineConfig } from 'vitepress';

// https://vitepress.dev/reference/site-config
export default defineConfig({
    lang: 'en-US',
    title: 'Bifröst',
    description: 'A bridge between Discord and Fluxer',
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

        socialLinks: [{ icon: 'github', link: 'https://github.com/KartoffelChipss/bifrost' }],
    },
});
