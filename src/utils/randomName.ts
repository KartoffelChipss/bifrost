export const randomName = () => {
    const adjectives = ['Happy', 'Sad', 'Angry', 'Excited', 'Bored'];
    const nouns = ['Cat', 'Dog', 'Fish', 'Bird', 'Hamster'];
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adjective}${noun}`;
};
