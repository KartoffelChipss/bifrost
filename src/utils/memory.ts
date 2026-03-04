export function getHeapUsageMB() {
    const used = process.memoryUsage().heapUsed;
    return (used / 1024 / 1024).toFixed(2);
}
