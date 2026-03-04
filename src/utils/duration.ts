export function formatDuration(seconds: number, maxUnits = 2): string {
    const units = [
        { label: 'day', short: 'd', value: 86400 },
        { label: 'hour', short: 'h', value: 3600 },
        { label: 'minute', short: 'm', value: 60 },
        { label: 'second', short: 's', value: 1 },
    ];

    const result = [];

    for (const unit of units) {
        if (result.length >= maxUnits) break;

        const amount = Math.floor(seconds / unit.value);
        if (amount > 0) {
            result.push(`${amount}${unit.short}`);
            seconds -= amount * unit.value;
        }
    }

    return result.length ? result.join(' ') : '0s';
}
