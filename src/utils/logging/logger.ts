import { createLogger, format, transports } from 'winston';
import path from 'path';
import { LoggerColors as Colors, getLevelColor } from './LoggerColors';
import { CONFIG_PATH, isProduction } from '../env';

const fileLogFormat = format.printf(({ level, message, timestamp }) => {
    return `${timestamp || ''} [${level ? level.toUpperCase() : 'INFO'}]: ${message || ''}`;
});

const consoleLogFormat = format.combine(
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
    format: format.combine(format.timestamp(), fileLogFormat),

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
