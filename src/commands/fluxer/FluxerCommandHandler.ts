import { Client, Message } from '@fluxerjs/core';
import CommandHandler from '../CommandHandler';

export default abstract class FluxerCommandHandler extends CommandHandler<Client, Message> {}
