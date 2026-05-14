-- =============================================================================
-- ship_byoa_configure { action: 'set' } setter
--
-- Companion to get_ship_byoa_wake_config() from the BYOA infrastructure
-- migration. Encrypts the wake bearer inside SECURITY DEFINER scope so the
-- operator_secret never leaves the server. Callers pass explicit "update"
-- booleans for each field so we can distinguish "leave alone" from
-- "explicit NULL to clear" without overloading magic sentinels.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_ship_byoa_wake_config(
  p_ship_id              uuid,
  p_wake_secret          text,
  p_source_url           text,
  p_update_wake_secret   boolean,
  p_update_source_url    boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF NOT p_update_wake_secret AND NOT p_update_source_url THEN
    RETURN;
  END IF;

  UPDATE public.ship_instances
  SET
    byoa_wake_secret_enc = CASE
      WHEN NOT p_update_wake_secret THEN byoa_wake_secret_enc
      WHEN p_wake_secret IS NULL THEN NULL
      ELSE extensions.pgp_sym_encrypt(
        p_wake_secret,
        public.byoa_operator_secret()
      )
    END,
    byoa_runtime_source_url = CASE
      WHEN NOT p_update_source_url THEN byoa_runtime_source_url
      ELSE p_source_url
    END,
    byoa_runtime_updated_at = NOW()
  WHERE ship_id = p_ship_id;
END;
$$;

COMMENT ON FUNCTION public.set_ship_byoa_wake_config IS
  'Writes per-ship BYOA wake config (encrypted wake_secret + source_url). Called from ship_byoa_configure { action: ''set'' }. SECURITY DEFINER so the operator_secret never escapes server scope; REVOKEd from PUBLIC.';

REVOKE ALL ON FUNCTION public.set_ship_byoa_wake_config(uuid, text, text, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_ship_byoa_wake_config(uuid, text, text, boolean, boolean) TO service_role;
