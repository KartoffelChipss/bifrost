export interface ChannelInfo {
    id: string;
    name: string;
}

export interface MatchProposal {
    discord: ChannelInfo;
    fluxer: ChannelInfo;
    score: number;
}

const DEFAULT_THRESHOLD = 0.5;

function normalizeChannelName(name: string): string {
    return name
        .toLowerCase()
        .replace(/^#/, '')           // strip leading #
        .replace(/[-_.\s]+/g, ' ')   // separators → space
        .trim();
}

// Space-optimized Levenshtein distance (O(n) space)
function levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const row = Array.from({ length: n + 1 }, (_, i) => i);

    for (let i = 1; i <= m; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= n; j++) {
            const temp = row[j];
            row[j] =
                a[i - 1] === b[j - 1]
                    ? prev
                    : 1 + Math.min(prev, row[j - 1], row[j]);
            prev = temp;
        }
    }

    return row[n];
}

function channelSimilarity(a: string, b: string): number {
    const na = normalizeChannelName(a);
    const nb = normalizeChannelName(b);

    if (na === nb) return 1.0;

    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return 1.0;

    // Containment bonus: if one name fully contains the other (after normalization)
    if (na.includes(nb) || nb.includes(na)) {
        const minLen = Math.min(na.length, nb.length);
        return 0.7 + 0.3 * (minLen / maxLen);
    }

    return 1 - levenshteinDistance(na, nb) / maxLen;
}

/**
 * Greedy one-to-one channel matching.
 * Computes all pairwise similarities, then greedily assigns best pairs
 * until no unmatched channels remain above the threshold.
 */
export function matchChannels(
    discordChannels: ChannelInfo[],
    fluxerChannels: ChannelInfo[],
    threshold = DEFAULT_THRESHOLD
): MatchProposal[] {
    type ScoredPair = { di: number; fi: number; score: number };
    const pairs: ScoredPair[] = [];

    for (let di = 0; di < discordChannels.length; di++) {
        for (let fi = 0; fi < fluxerChannels.length; fi++) {
            const score = channelSimilarity(discordChannels[di].name, fluxerChannels[fi].name);
            if (score >= threshold) {
                pairs.push({ di, fi, score });
            }
        }
    }

    pairs.sort((a, b) => b.score - a.score);

    const usedDiscord = new Set<number>();
    const usedFluxer = new Set<number>();
    const proposals: MatchProposal[] = [];

    for (const { di, fi, score } of pairs) {
        if (usedDiscord.has(di) || usedFluxer.has(fi)) continue;
        usedDiscord.add(di);
        usedFluxer.add(fi);
        proposals.push({
            discord: discordChannels[di],
            fluxer: fluxerChannels[fi],
            score,
        });
    }

    // Return sorted by score descending for display
    proposals.sort((a, b) => b.score - a.score);
    return proposals;
}
