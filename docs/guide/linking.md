# Linking your Servers and Channels

After setting up Bifröst, the next step is to link your Discord and Fluxer servers and channels together. This allows messages to be synchronized between the two platforms.

::: info
In the command examples, `<other-server-id>` and `<other-channel-id>` refer to the ID of the server or channel you want to link to. You can find these IDs by enabling Developer Mode in Discord and Fluxer and right-clicking on the server or channel to copy its ID.
:::

::: tip
You can use the `!b help` command to get a list of all available commands and their usage.
:::

## Linking Servers

To link your Discord and Fluxer servers, you can use the `!b link <other-server-id>` command in any channel where the bot is present. This will link the servers together and allow you to start linking channels. Use `!b link confirm` to confirm the linking process.

## Linking Channels

To link channels between the linked servers, use the `!b link <other-channel-id>` command in the channel you want to link. This will create a bridge between the two channels, allowing messages to be synchronized in real time. Use `!b link confirm` to confirm the linking process.

## Autolink Channels

If you want to automatically link channels with the same name between the linked servers, you can use the `!b autolink` command. This will link all channels with matching names between the two servers. Use `!b autolink confirm` to confirm the autolinking process.

## Listing Links

You can view all the current links between your channels using the `!b list` command. This will show you a list of all linked channels and their corresponding IDs.
