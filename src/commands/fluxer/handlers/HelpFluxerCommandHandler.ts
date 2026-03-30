import { Client, EmbedBuilder, Message, PermissionFlags } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getHelpMessage } from '../../../commands/commandList';
import { EmbedColors } from '../../../utils/embeds';

export default class HelpFluxerCommandHandler extends FluxerCommandHandler {
    constructor(client: Client) {
        super(client);
    }

    async handleCommand(message: Message): Promise<void> {
        const hasPerms = await this.requirePermission(
            message,
            PermissionFlags.ManageWebhooks,
            'Manage Webhooks'
        );
        if (!hasPerms) return;
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Bifröst Help')
                    .setDescription(getHelpMessage('fluxer'))
                    .setColor(EmbedColors.Info)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }
}
