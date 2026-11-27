# Design: native history copies and name sync

Status: approved 2026-11-27. Built in `src/history-rewrite` (Part A) and `src/name-sync` (Part B).

Ownership of copies (`native-authors.md`) is on hold until this work is done.

## Goals

1. Each history copy shows the time of its Discord original.
2. History copies have no "*Originally posted …*" line.
3. History copies carry real reactions, the same way live copies do.
4. A history copy of a reply is a real Fluxer reply, the same way live copies are.
5. When a Discord member changes their name, every Fluxer copy of their messages
   shows the new name.

Seamless means: no "(edited)" marks that Discord does not have, no errors in
bifrost on either side, and no drift between bifrost's maps and Fluxer.

## Size (read from the live databases, 2026-11-27)

| Item | Count |
|---|---|
| History copies | 96,900 |
| Copies of replies | 5,684 |
| Copies with reactions | 8,053 (9,962 emoji entries, 3,944 of them custom) |
| Copies whose original was edited | 3,215 |
| Copies of forwarded messages | 32 |
| History authors | 234 |
| Live relay copies | 13 |

Every history copy has its Discord original in the archive.

## Key facts

Source: Fluxer commit `58062ed2`.

- Fluxer and Discord use the same epoch: `FLUXER_EPOCH = 1420070400000`
  (`packages/constants/src/Core.ts:3`).
- A message's time comes only from its ID:
  `timestamp: epoch_millis_to_iso(snowflake_to_epoch_millis(message.message_id))`
  (`fluxer_messages/src/shard_impl.rs:1427`). No stored field holds it.
- So a copy whose Fluxer ID equals its Discord message ID shows the Discord time,
  and sorts in Discord order.
- An edit through the API sets `edited_timestamp` when content changes
  (`MessagePersistenceService.ts:605-621`). A webhook edit cannot remove the
  "Originally posted" line without an "(edited)" mark. A database write can.
- Attachment files are stored at `attachments/{channelId}/{attachmentId}/{filename}`
  (`MessageHelpers.ts:133`). A new message ID does not move them.
- A reaction is a row keyed by channel, bucket, message, emoji and **user**
  (`Tables.ts:752-757`). Each reaction belongs to one Fluxer user.

## Part A: one-time rewrite of history copies (goals 1–4)

### What changes for each copy

| Field | Now | After |
|---|---|---|
| Message ID | Fluxer ID from import time | The Discord message ID |
| Bucket and row key | From the old ID | Computed from the new ID |
| Content | Ends with the reactions line and the "Originally posted" line | Both lines removed |
| Reply | Quote embed made by bifrost | `message_reference` to the copy of the replied-to message, when that copy is in the same Fluxer channel. Otherwise the quote stays. |
| Reactions | Text line only | One reaction per emoji, by the bot. Unicode emojis always; custom emojis only when guild-sync copied them to Fluxer. |
| `edited_timestamp` | None | The Discord `edited_timestamp`, so "(edited)" shows where Discord shows it. **Decision 1.** |
| Author name | Name at import time (some are global names) | Current server nickname, as live copies use |
| Attachments, embeds, pins, flags | — | Kept |

Forwarded messages (32) keep their quote embed.

### Copies inside threads are not moved

Fluxer refuses a thread message whose ID is not greater than the thread's
ID: "Thread message id must be greater than the thread id"
(`MessageSendService.ts:267-271`), and thread starter paging relies on it
(`ThreadMessageResponses.ts:200-225`). A thread created in 2026 cannot hold
messages with 2019 IDs. The job skips every copy in a thread channel
(17,279 on 2026-11-27, including forum post starters). They keep their date
line. Moving them needs each thread re-keyed to its Discord thread ID first,
which is a separate change.

### Search

Fluxer's own listing for search reindexing never scans below
`channel_state.created_bucket` (`MessageDataRepository.ts:152`), and every
new message resets it to the channel's creation bucket
(`MessageDataRepository.ts:547,565`). The job lowers it. Run the search
rebuild before anyone posts in those channels. A later full rebuild needs the
job's bucket step again.

### Limits

- Reaction counts cannot match Discord. A copy shows each emoji once, from the bot.
  Live copies work the same way today.
- Custom emojis that guild-sync did not copy cannot be added as reactions.
- Copies that a linked author edited through bifrost's `edit` command do not end
  with the expected lines. The job leaves their content as it is and lists them.

### What else must follow the new ID

Every row that names the old ID moves in the same transaction:

- Fluxer: `messages`, `message_reactions` (reactions mirrored since import),
  `channel_pins`, `attachment_lookup`, `message_reference` in any message that
  replies to a history copy, `channel_message_buckets` (which buckets hold
  messages, used for paging), and `channel_state.last_message_id` when it points at
  a history copy. Search is rebuilt afterwards.
- Bifrost: `addon_history_messages.fluxerMessageId`, the history mention table, and
  any pair that points at a history copy.

Before building, check every Fluxer table that holds a message ID against this
list. Fluxer's own types list the candidates
(`fluxer_api/src/api/database/types/{Message,Channel,User,Report}Types.ts`).

### How it runs

The job is a bifrost command, for example `pnpm history:rewrite`. It runs as a
one-shot container with connections to both databases. It does not use any Fluxer
CLI.

1. Stop bifrost. Stop Fluxer's API, worker and message services. Postgres stays up.
2. Back up both databases at the same point.
3. Run the job in dry-run. It checks every copy and writes a report: what it would
   change, what it would skip, and why. It writes nothing.
4. Review the report.
5. Run the job in apply mode. It works one channel per transaction. A failure rolls
   back that channel only, and the job stops.
6. Run the verification queries: every copy's new row exists, no old row is left,
   and the counts match the report.
7. Start Fluxer. Everyone's app reconnects and loads fresh messages.
8. Start the search rebuild for each server from the admin panel
   (server page → "Refresh Channel Messages").
9. Start bifrost.

Rollback: stop everything and restore both backups.

**Rehearsal (decision 3):** restore the backups into a scratch copy, run the job
there, and read the result through a Fluxer API pointed at the copy. Only then run
it on the live data.

### Safety

- The job refuses to start if Fluxer or bifrost is running, or if the `fluxer_kv`
  layout differs from the one it was built for (columns, the sort-ID trigger, the
  `__fluxer_schema_migrations` markers).
- It touches only rows whose `webhook_id` is one of bifrost's webhooks and whose
  message ID is in `addon_history_messages`.
- It refuses a new ID that already exists in Fluxer.
- Logs and the report never contain message text.

## Part B: name sync (goal 5)

### Triggers

- Discord `guildMemberUpdate`: server nickname or server avatar changed.
- Discord `userUpdate`: global name or avatar changed.
- Startup: compare current members with the archive's member snapshots, to catch
  changes made while bifrost was down.

### What it does

1. Work out the new name the same way the relay does: server nickname, then global
   name, then username, cut to Fluxer's limit.
2. Find every Fluxer copy by that member: history copies through
   `addon_history_messages.discordAuthorId`, live and thread copies through the
   archive's author column. New live copies record the author when they are sent.
3. Update `webhook_name` on those rows, in batches, with the same ownership guard.
4. Send a flags-only webhook edit for each member's most recent copies in each
   channel. It pushes the new name to open apps at once and adds no "(edited)"
   mark. Older copies show the new name when the channel is next loaded.

### Limits

- **Discord copies of Fluxer messages keep their old name.** Discord stores the
  name on each webhook message and has no way to change it.
- **Avatars are not covered yet.** A webhook copy stores an avatar hash. I have not
  confirmed whether Fluxer stores webhook avatars per webhook. This needs research
  before avatars can follow.

### Access

Part B writes to Fluxer's database while both apps run. It uses a dedicated
Postgres role that can only run a few checked functions, as described in
`native-authors.md` ("Safety"). Part A runs with the owner role while Fluxer is
stopped.

## Reactions as the linked member (asked 2026-11-27, not planned yet)

Today the bot adds one reaction of its own per emoji on the other side.

- **Fluxer, as the member: only through the database.** OAuth2 scopes are
  `identify, email, guilds, connections, bot` (`packages/constants/src/OAuth2Constants.ts:3`);
  none lets an app react for a user. A `message_reactions` row with the member's
  `user_id` would show as their reaction. A database insert sends no gateway event,
  so open apps would not see it until they reload. Fluxer sends events over NATS
  (`rpc.gateway.guild.dispatch`, `NatsGatewayRpcTransport.ts:12,60-68`); bifrost
  would need NATS access and would build the event itself.
- **Discord, as the member: not possible.** A bot cannot react as a user. Only the
  bot's own reaction can show. Removal works: with Manage Messages the bot can
  remove a member's reaction.
- **History:** Discord's message data holds reaction counts, not who reacted, so
  past reactions cannot be assigned to members without one extra Discord request
  per emoji.

This acts for the member, like ownership. It belongs in that discussion.

## Decisions

1. Show "(edited)" on copies whose Discord original was edited (3,215 copies)?
   Recommendation: yes. It matches Discord.
2. Downtime: Fluxer is down while the job runs. The length is unknown until the
   rehearsal measures it.
3. Rehearse on a restored copy first? Recommendation: yes.
4. Avatars in name sync: research first, then decide.

## Order of work

1. Part B, names only. It is small and useful at once, and it fixes the wrong old
   names before the rewrite.
2. Part A, with the dry-run report first, then the rehearsal, then the live run.
3. Avatars, after research.
