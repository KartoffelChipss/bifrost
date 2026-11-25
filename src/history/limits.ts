/** Limits shared by the history importer and its dry-run survey. */

/** Messages read per page, Discord's maximum. */
export const PAGE_SIZE = 100;
/** Fluxer allows 60 webhook messages a minute per webhook. */
export const SEND_INTERVAL_MS = 1_050;
/** Jobs copied at once, each through a different webhook. */
export const MAX_PARALLEL = 4;
/**
 * A pass stops starting new work after this long. The pass holds the
 * history leader lock, a Postgres transaction, so the bound keeps that
 * transaction short: at most this plus one send per parallel job.
 */
export const PASS_BUDGET_MS = 60_000;
/**
 * Fluxer's content limit for webhook sends and edits: the premium length,
 * which applies to webhooks (fluxer_api MessageValidationService
 * validateContentLength, MAX_MESSAGE_LENGTH_PREMIUM in LimitConstants).
 */
export const MAX_CONTENT_LENGTH = 4_000;
