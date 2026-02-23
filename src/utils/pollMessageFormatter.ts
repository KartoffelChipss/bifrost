export const getPollMessage = (question: string, options: string[], endsAt: number): string => {
    const optionsText = options.map((option, index) => `${index + 1}. ${option}`).join('\n');

    const endsAtTimestamp = Math.floor(endsAt / 1000);
    const endsAtText = `-# Poll ends at: <t:${endsAtTimestamp}:R>`;
    const infoText = `-# This poll was created on Discord and can only be voted on there.`;

    return `\`[DISCORD POLL]\`\n**${question}**\n${optionsText}\n${endsAtText}\n${infoText}`;
};
