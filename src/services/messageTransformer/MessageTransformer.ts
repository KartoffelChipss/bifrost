import { emojiToString, GeneralEmoji, replaceEmojis } from '../../utils/emojis';

export default abstract class MessageTransformer<SourceMessage, TargetMessage> {
    abstract transformMessage(
        message: SourceMessage,
        otherEmojis?: GeneralEmoji[]
    ): Promise<TargetMessage>;

    protected replaceEmojis(content: string, emojis: GeneralEmoji[]): string {
        return replaceEmojis(content, (emoji) => {
            const matchingEmoji = emojis.find((e) => e.name === emoji.name);
            if (matchingEmoji) {
                return `<${matchingEmoji.animated ? 'a' : ''}:${matchingEmoji.name}:${matchingEmoji.id}>`;
            }
            return emojiToString(emoji);
        });
    }
}
