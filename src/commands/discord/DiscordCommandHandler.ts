import { Client, Message, OmitPartialGroupDMChannel } from 'discord.js';
import CommandHandler from '../CommandHandler';

export type DiscordCommandHandlerMessage = OmitPartialGroupDMChannel<Message<boolean>>;

export default abstract class DiscordCommandHandler extends CommandHandler<
    Client,
    DiscordCommandHandlerMessage
> {}
