---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
    name: 'Bifröst'
    text: 'A bridge between Discord and Fluxer'
    tagline: 'Seemlessly connect your Discord and Fluxer communities'
    image:
        src: '/logo.svg'
        alt: 'Bifröst Logo'
    actions:
        - theme: brand
          text: Add to Discord
          link: https://discord.com/oauth2/authorize?client_id=1475436995697180845&permissions=536947712&integration_type=0&scope=bot
        - theme: brand
          text: Add to Fluxer
          link: https://web.fluxer.app/oauth2/authorize?client_id=1475208219145040215&scope=bot&permissions=536947712
        - theme: alt
          text: Getting Started
          link: /guide/getting-started

features:
    - icon: 🔗
      title: Channel Linking
      details: Link channels between Discord and Fluxer to create seamless cross-platform conversations.

    - icon: 💬
      title: Message Synchronization
      details: Messages sent in linked channels are automatically mirrored between Discord and Fluxer in real time.

    - icon: ✏️
      title: Edit & Delete Sync
      details: Message edits and deletions propagate across both platforms to keep conversations consistent.

    - icon: 🧩
      title: Rich Content Support
      details: Supports messages, replies, attachments, stickers, embeds, join messages, and polls.

    - icon: 🪝
      title: Webhook Bridging
      details: Messages are bridged using webhooks so they appear with the original sender’s name and avatar.

    - icon: ⚙️
      title: Flexible Deployment
      details: Get started instantly using our hosted bot or run the bridge yourself with Docker for full control.
---
