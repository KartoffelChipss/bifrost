import { createLogger, format, transports } from 'winston';
import path from 'path';
import { LoggerColors as Colors, getLevelColor } from './LoggerColors';
import { CONFIG_PATH, isProduction } from '../env';

const splatSymbol = Symbol.for('splat');

const stringifySafe = (value: unknown): string => {
    const seen = new WeakSet<object>();

    return JSON.stringify(
        value,
        (_key, currentValue) => {
            if (typeof currentValue === 'object' && currentValue !== null) {
                if (seen.has(currentValue)) return '[Circular]';
                seen.add(currentValue);
            }

            return currentValue;
        },
        2
    );
};

const serializeLogValue = (value: unknown): string => {
    if (value instanceof Error)
        return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null)
        return stringifySafe(value);

    return String(value);
};

const enrichMessageWithSplat = format((info) => {
    const splatValues = info[splatSymbol] as unknown[] | undefined;
    if (!splatValues || splatValues.length === 0) return info;

    const serializedValues = splatValues
        .map((value) => serializeLogValue(value))
        .filter((value) => value.length > 0);
    if (serializedValues.length === 0) return info;

    info.message = `${info.message}\n${serializedValues.join('\n')}`;
    return info;
});

const fileLogFormat = format.printf(({ level, message, timestamp }) => {
    return `${timestamp || ''} [${level ? level.toUpperCase() : 'INFO'}]: ${message || ''}`;
});

const consoleLogFormat = format.combine(
    format.errors({ stack: true }),
    enrichMessageWithSplat(),
    format.label({ label: '[LOGGER]' }),
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(
        (info) =>
            `${Colors.FgDarkGray}${info.timestamp} ${Colors.Reset}[${getLevelColor(
                info.level
            )}${info.level.toUpperCase()}${Colors.Reset}]: ${
                info.level === 'info' ? Colors.Reset : getLevelColor(info.level)
            }${info.message}${Colors.Reset}`
    ),
    format.colorize({ all: true })
);

const logger = createLogger({
    level: isProduction ? 'info' : 'debug',
    format: format.combine(
        format.errors({ stack: true }),
        enrichMessageWithSplat(),
        format.timestamp(),
        fileLogFormat
    ),

    transports: [
        new transports.Console({
            format: consoleLogFormat,
        }),

        new transports.File({
            filename: path.join(CONFIG_PATH, 'logs/error.log'),
            level: 'error',
        }),
        new transports.File({
            filename: path.join(CONFIG_PATH, 'logs/combined.log'),
        }),
    ],
});

// Override console.log, console.error, console.warn, console.debug
// console.log = (...args: any[]) => logger.info(args.join(' '));
// console.error = (...args: any[]) => logger.error(args.join(' '));
// console.warn = (...args: any[]) => logger.warn(args.join(' '));
// console.debug = (...args: any[]) => logger.debug(args.join(' '));

export default logger;
