/**
 * Tells guild-sync's status board that a link's state changed outside a
 * cycle: a history pass ran or an admin command changed a setting. One
 * signal is made at startup and shared; the board listens while guild-sync
 * runs. With nobody listening, a notify does nothing.
 */
export class StatusSignal {
    private listener: ((guildLinkId: string) => void) | null = null;

    /** Sets the one listener. Returns a function that removes it. */
    listen(listener: (guildLinkId: string) => void): () => void {
        this.listener = listener;
        return () => {
            if (this.listener === listener) this.listener = null;
        };
    }

    /**
     * Reports a change. The listener only schedules work (it never posts
     * here), so the caller is not held up.
     */
    notify(guildLinkId: string): void {
        if (!guildLinkId) return;
        this.listener?.(guildLinkId);
    }
}
