# Using a Self-Hosted Fluxer Instance

By default, Bifröst connects to the officially hosted Fluxer instance at `fluxer.app`. If you run your own self-hosted Fluxer instance, you can point Bifröst at it instead.

There are two ways to do this, depending on whether your Fluxer instance supports **autodiscovery**.

## Option 1: Autodiscovery (recommended)

If your self-hosted Fluxer instance exposes the discovery endpoint (`GET /.well-known/fluxer`), Bifröst can automatically resolve all the endpoints it needs (API, media, static CDN, and invite) from a single domain.

Set this in your `.env` file:

```env
BF_FLUXER_AUTODISCOVERY_DOMAIN="chat.example.com"
```

On startup, Bifröst queries `https://chat.example.com/.well-known/fluxer` and uses the returned endpoints to connect. If the instance doesn't support discovery, Bifröst will fail to start. Fall back to manual configuration instead.

## Option 2: Manual configuration

If your instance doesn't support autodiscovery, set `BF_FLUXER_BASE_URL`:

```env
BF_FLUXER_BASE_URL="https://chat.example.com"
```

Bifröst derives the following endpoints from it automatically:

- API: `https://chat.example.com/api`
- Media: `https://chat.example.com/media`
- Static CDN: `https://chat.example.com/static`
- Invite: `https://chat.example.com/invite`

If your instance uses a different layout, for example the API is served from a separate subdomain, override each endpoint individually instead:

```env
BF_FLUXER_API_URL="https://api.example.com"
BF_FLUXER_MEDIA_URL="https://media.example.com"
BF_FLUXER_STATIC_CDN_URL="https://cdn.example.com"
BF_FLUXER_INVITE_URL="https://chat.example.com/invite"
```

Any of these set individually take priority over the values derived from `BF_FLUXER_BASE_URL`.

::: warning
Only use one of the two options. If `BF_FLUXER_AUTODISCOVERY_DOMAIN` is set, it takes over the Fluxer connection entirely and the manually configured URLs above are ignored for that purpose.
:::

## Bot invite links

Regardless of which option you use, set `BF_FLUXER_BASE_URL` as well. Bifröst uses it specifically to build the Fluxer bot invite link shown in the startup logs and in `!b stats`. If it isn't set, invite links fall back to `https://fluxer.app`, which is wrong for a self-hosted instance. Autodiscovery does not fill in this value on its own.

## Full reference

See the [Environment Variables reference](/guide/environment-variables) for every variable Bifröst supports, including all Fluxer connection variables.
