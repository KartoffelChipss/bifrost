# Design: native authors on Fluxer

Status: on hold (2026-11-27) until the history rewrite and name sync are done. Nothing here is built.

## Goal

A Fluxer copy of a Discord message by a linked member shows as that member's own
message. Search finds it with `from:`. Replies to it notify the member. The member
sees it in their data export.

The Fluxer API cannot do this. Bifrost must write to Fluxer's database. The owner
approved this approach on 2026-11-27.

## Why the API is not enough

Source: Fluxer commit `58062ed2`. Paths are relative to the Fluxer repository.

- A webhook message stores no author. The send path sets
  `author_id: authorId` with `authorId = params.user?.id ?? params.userId ?? null`
  (`fluxer_api/src/api/channel/services/message/MessagePersistenceService.ts:332,412`).
  The live rows confirm it: a webhook copy has no `author_id` key at all.
- No route changes a message's author. OAuth2 scopes are
  `['identify','email','guilds','connections','bot']`
  (`packages/constants/src/OAuth2Constants.ts:3`). The admin message routes only
  look up, delete and shred (`fluxer_api/src/api/admin/controllers/MessageAdminController.ts:46-340`).
- Search `from:` filters on `authorId`
  (`fluxer_api/src/api/search/message/MessageSearchSerializer.ts:235`).
- Reply notifications go to the author of the replied-to message
  (`MessageMentionService.ts:99-107`). A webhook copy has none, so nobody is notified.
- Data export, "delete all my messages", account deletion and admin delete-all use
  `messages_by_author_id_v2`. Fluxer writes that row only when `author_id != null`
  (`MessageDataRepository.ts:707-715`).

## What one database field changes

When a copy's row carries `author_id` of a real Fluxer user:

- The API returns that user as the author (`fluxer_messages/src/shard_impl.rs:1467-1479`).
- The client shows the user's name, avatar and member nickname, and the role
  colour when the member is loaded (`fluxer_app/.../UserMessage.tsx:180`).
- The Bot tag goes away. It shows only for `author.bot || message.isCrosspostCopy`
  (`UserMessage.tsx:529-535`).
- Renames follow automatically, because the name comes from the user's profile and
  not from `webhook_name`.
- Search `from:` matches it after reindexing.
- Replies to it notify the user.

What stays webhook-like, because the client keys it off `webhook_id`
(`PreloadableUserPopout.tsx:77-82,109`, `MessageUsername.tsx:86`, `ReportFlowModal.tsx:127`):

- A click on the name opens the webhook menu, not the profile popout.
- The copy cannot be reported.
- Search labels it `author_type:webhook`.

Bifrost keeps `webhook_id` on every copy. Three things depend on it:

1. The bridge webhook may edit and delete the copy. The checks use `webhookId`
   (`MessageSendService.ts:1258,1288`, `MessageDeleteService.ts:166-168`).
2. Bifrost's loop guard ignores Fluxer messages that carry a webhook ID
   (bifrost `src/fluxer.ts:216,232,285`).
3. Fluxer deletes a row that has neither `author_id` nor `webhook_id`
   (`MessageDataRepository.ts:859-863`, `shard_impl.rs:846-849`).

## Mechanism

### Claim one copy (live path)

Use this path for a new copy and for a small number of old copies.

1. Run one guarded SQL update in Fluxer's database:

   ```sql
   UPDATE fluxer_kv
   SET row_data = row_data || jsonb_build_object('author_id',
         jsonb_build_object('__fluxer_type','bigint','value',$author::text)),
       updated_at = now()
   WHERE table_name = 'messages'
     AND row_key = $rowKey
     AND row_data->'webhook_id'->>'value' = ANY($ownedWebhookIds)
     AND (NOT row_data ? 'author_id' OR row_data->'author_id' = 'null'::jsonb)
   ```

2. Send a flags-only edit through the owning webhook:
   `PATCH /webhooks/:id/:token/messages/:mid` with `{"flags": <current sendable flags>}`.

The edit does the rest inside Fluxer:

- It reads the row again and keeps `author_id`. Only changed columns are patched,
  and the write merges with `||` (`MessagePersistenceService.ts:601,733`).
- It writes the `messages_by_author_id_v2` row (`MessageDataRepository.ts:709-717`).
- It sends MESSAGE_UPDATE with the real author, so open clients switch at once
  (`MessageGatewayDispatch.ts:115-133`, `MessagingMessage.ts:321`).
- It reindexes the message in search (`MessageSendService.ts:1309-1311`).
- It does not set `edited_timestamp`. That happens only when content changes
  (`MessagePersistenceService.ts:605-628`).

### Claim many copies (sweep path)

Use this path when a member links and has many old copies.

1. In one transaction per batch, set `author_id` on each row with the update
   above, and insert the matching `messages_by_author_id_v2` row.
2. When the sweep ends, start one search reindex per server:
   `POST /admin/search/indexes/channel_messages/refreshes` with `{"guild_id": ...}`.
   It needs an admin API key with the `guild:lookup` ACL
   (`SearchAdminController.ts:19-47`).

The sweep sends no MESSAGE_UPDATE. Clients that already have those channels open
show the old name until they reconnect or reload the channel
(`MessagingMessages.ts:703-756`). This is acceptable for history.

### Release (unlink)

Reverse the claim:

- Remove the key: `row_data - 'author_id'`.
- Delete the `messages_by_author_id_v2` row.
- Send the flags-only edit (live path) or reindex (sweep path).

Never remove `webhook_id`.

### Key format

Source: `PostgresKvQueryExecutor.ts:105,281-287` and live rows.

- Bigint: `{"__fluxer_type":"bigint","value":"<decimal>"}`, in that key order, no spaces.
- Separator: `\u001f`.
- `messages` row key: `<bigint channel>␟<bucket>␟<bigint message>`, with
  `bucket = (message_id >> 22) / 864000000` as an integer
  (`packages/snowflake/src/SnowflakeBuckets.ts:6,15-17`).
- `messages_by_author_id_v2`: `partition_key = row_key = <bigint author>␟<bigint message>`.
  `row_data` is `{"author_id":..,"channel_id":..,"message_id":..}`. `sort_id` stays null.

## Which copies

Only copies bifrost made, of messages by linked members:

| Copy | Bifrost table | Fluxer channel | Owning webhook |
|---|---|---|---|
| Live relay | `message_links` | `channel_links.fluxerChannelId` | `channel_links.fluxerWebhookId/Token` |
| Thread relay | `addon_thread_messages` | `fluxerThreadId` | the parent channel's webhook |
| History | `addon_history_messages` | `fluxerTargetId` | `importWebhookToken`, or the bridge webhook after bridging |

The Discord author comes from `addon_history_messages.discordAuthorId`, or from
`addon_archive_messages.authorId` for live and thread copies. `message_links` has
no author column. New live copies record the author at send time.

## When it runs

| Event | Action |
|---|---|
| Bifrost sends a copy of a linked member's message | Claim it (live path), right after the link row is saved. |
| A member links | Sweep their old copies. Also rewrite mentions of them in old live copies; today only history copies get that rewrite. |
| A member unlinks | Release every copy recorded as theirs. |
| A member deletes their Fluxer account | Fluxer re-points their messages to a placeholder user (`MessageAuthorRepository.ts:56-86`). Bifrost marks the claims released and does not write. |
| Startup | Claim any copy of a linked member that has no claim yet. |

## Behaviour changes to decide

1. **The member can edit their copy on Fluxer** (`MessageEditService.ts:147`).
   Bifrost cannot edit their Discord original. Options:
   - a. Allow it. The copy differs from Discord. History copies already allow
     author edits through a DM command.
   - b. Revert the edit through the webhook, and DM the member to edit on Discord.
   - Recommendation: (b) for live copies, (a) for history copies.
2. **The member can delete their copy on Fluxer.** For a live copy, bifrost then
   deletes the Discord original (`src/fluxer.ts:173-213`). Moderators can already
   do this today. Recommendation: keep it. It is their message.
3. **A Fluxer ban with "delete messages" now deletes the member's copies**
   (`GuildModerationService.ts:149-156`), and bifrost then deletes the Discord
   originals. Bans that bifrost syncs from Discord do not delete messages.
   Recommendation: skip the Discord delete when many copies of one author are
   deleted in a burst, and log it for an admin.

## Safety

- **Switch.** A new add-on flag, `BF_ADDON_NATIVE`, off by default. It follows the
  add-on modes: read-only does nothing, dry-run counts, apply writes. Apply also
  needs `BF_ADDONS_ALLOW_APPLY` and `sync mode apply`.
- **Least privilege.** A dedicated Postgres role in Fluxer's database. It may only
  run a few `SECURITY DEFINER` functions in a `bifrost` schema: claim, release and
  check. Each function enforces the guards itself. The role gets no direct table
  access. A checked-in SQL file sets this up once, from the homelab repository.
- **Ownership guard.** Every write requires the row's `webhook_id` to be one of
  bifrost's webhooks, and the message ID to be in a bifrost link table. A claim
  never overwrites an existing author. A release only touches claims bifrost made.
- **Schema guard.** At startup bifrost checks the `fluxer_kv` columns, the
  `fluxer_kv_sort_id_fill` trigger, and the `__fluxer_schema_migrations` markers.
  If anything differs, the add-on stays off and the relay keeps running.
- **Audit and rollback.** A bifrost table records each claim: channel, message,
  Discord user, Fluxer user, time, and state. A `native release-all` command
  reverses every recorded claim. Take a Fluxer database backup before the first
  apply sweep.
- **Bounds.** Batches of at most 500 rows per transaction. Statement timeout on
  every query. Flags-only edits stay under Fluxer's webhook rate limit. One sweep
  at a time.
- **Privacy.** Logs and metrics never contain message text or tokens. The admin
  API key and the database password are read from files.
- **Network.** Bifrost joins the Fluxer compose network to reach Postgres and the
  API. Postgres stays unpublished.

## Not possible

- **Discord.** Copies of Fluxer messages on Discord stay app webhooks with the APP
  tag. Discord has no equivalent, and bifrost has no database access there.
- **Profile popout and report** on a copy, while `webhook_id` stays. Clearing it
  would break edit sync and bifrost's loop guard. A patched Fluxer client could
  change this. It would also allow a "Discord" tag.

## Later phases (same database access)

1. **Names for unlinked authors.** Rewrite `webhook_name`, then send a flags-only
   edit. This fixes the wrong old names and follows renames. Avatars are harder:
   `webhook_avatar_hash` points to an uploaded image.
2. **Native replies in history copies.** Set `message_reference` to the replied-to
   copy, and drop the quote embed.
3. **Re-dating.** Give each copy a message ID from its Discord time. Many tables
   reference the message ID: pins, reactions, attachments, read states, threads
   and search.
4. **The 27 copies without images.** Restore the files from the archive.

## Tests

- Key encoding and bucket maths, checked against rows read from the live database.
- Guard tests: a claim refuses a foreign webhook, an existing author and a row
  without `webhook_id`.
- Integration tests on Postgres, with a `fluxer_kv` table and trigger copied from
  the live schema.
- Dry-run counts match apply.
