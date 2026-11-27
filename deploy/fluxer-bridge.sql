-- Name sync access in Fluxer's database (docs/design/history-rewrite.md).
--
-- Run once as the owner of fluxer_kv, with the role's password in a psql
-- variable so it never appears in shell history:
--
--   psql -v bridge_password="$(cat password-file)" -f fluxer-bridge.sql
--
-- The role can log in and run the functions below. It gets no access to
-- any table: each function checks its own arguments and touches only the
-- webhook_name of webhook messages.

\set ON_ERROR_STOP on

SELECT format('CREATE ROLE bifrost_bridge LOGIN PASSWORD %L', :'bridge_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bifrost_bridge')
\gexec
SELECT format('ALTER ROLE bifrost_bridge LOGIN PASSWORD %L', :'bridge_password')
\gexec

CREATE SCHEMA IF NOT EXISTS bifrost;
REVOKE ALL ON SCHEMA bifrost FROM PUBLIC;
GRANT USAGE ON SCHEMA bifrost TO bifrost_bridge;

-- Sets webhook_name on up to 500 messages, given by their fluxer_kv row
-- keys. Only rows that are webhook messages with no user author change.
-- Returns how many rows changed.
CREATE OR REPLACE FUNCTION bifrost.set_webhook_names(p_keys text[], p_name text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    changed integer;
BEGIN
    IF p_keys IS NULL OR cardinality(p_keys) > 500 THEN
        RAISE EXCEPTION 'set_webhook_names takes 0 to 500 keys';
    END IF;
    IF p_name IS NULL OR char_length(btrim(p_name)) = 0
        OR char_length(p_name) > 80 THEN
        RAISE EXCEPTION 'set_webhook_names needs a name of 1 to 80 characters';
    END IF;
    UPDATE public.fluxer_kv
    SET row_data = row_data || jsonb_build_object('webhook_name', p_name),
        updated_at = now()
    WHERE table_name = 'messages'
      AND row_key = ANY (p_keys)
      AND jsonb_typeof(row_data -> 'webhook_id') = 'object'
      AND COALESCE(jsonb_typeof(row_data -> 'author_id'), 'null') = 'null'
      AND row_data ->> 'webhook_name' IS DISTINCT FROM p_name;
    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN changed;
END;
$$;

REVOKE ALL ON FUNCTION bifrost.set_webhook_names(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bifrost.set_webhook_names(text[], text) TO bifrost_bridge;
