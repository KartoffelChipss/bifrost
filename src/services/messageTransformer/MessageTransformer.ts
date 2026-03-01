export default interface MessageTransformer<SourceMessage, TargetMessage> {
    transformMessage(message: SourceMessage): Promise<TargetMessage>;
}
