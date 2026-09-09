"""Verifies Supabase access tokens.

Replaces FirebaseClaimLookup.verify_bearer_token. Supabase issues a JWT on
sign-in and the browser sends it as a bearer token, same shape as before, so
routes keep their existing structure -- what changes is who signed the token
and how it is checked.

Two signing schemes are supported because Supabase has both:

  * Asymmetric (RS256 / ES256). Newer projects sign with rotating keys and
    publish them at /auth/v1/.well-known/jwks.json. Nothing secret has to be
    configured, and a rotated key is picked up automatically.
  * Symmetric (HS256) with the project's legacy JWT secret, used by older
    projects. Only consulted when SUPABASE_JWT_SECRET is set.

The JWKS path is tried first so a project carrying both settings verifies
against the rotating keys rather than a stale secret.
"""

from __future__ import annotations

import logging
from typing import Any

from app.core.config import SUPABASE_JWT_SECRET, SUPABASE_URL

logger = logging.getLogger("claimsight.supabase_auth")

# Supabase stamps every user token with this audience.
_EXPECTED_AUDIENCE = "authenticated"


class SupabaseAuth:
    def __init__(self) -> None:
        self._url = SUPABASE_URL
        self._secret = SUPABASE_JWT_SECRET
        self._jwks_client = None
        self._jwks_failed = False

    @property
    def ready(self) -> bool:
        # A URL alone is enough for the JWKS path; the secret is optional.
        return bool(self._url)

    @property
    def issuer(self) -> str:
        return f"{self._url}/auth/v1"

    def _jwks(self):
        """Lazily build the JWKS client, caching keys between requests."""
        if self._jwks_client is not None or self._jwks_failed:
            return self._jwks_client
        try:
            from jwt import PyJWKClient

            self._jwks_client = PyJWKClient(
                f"{self._url}/auth/v1/.well-known/jwks.json",
                cache_keys=True,
            )
        except Exception as exc:
            logger.warning("Supabase JWKS client unavailable: %s", exc)
            self._jwks_failed = True
        return self._jwks_client

    def verify_bearer_token(self, authorization: str) -> dict[str, Any] | None:
        """Return normalised claims, or None when the token is not usable.

        Returning None rather than raising keeps the call sites identical to
        the Firebase version they replace.
        """
        if not self.ready or not authorization:
            return None

        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            return None

        claims = self._decode_asymmetric(token) or self._decode_symmetric(token)
        if claims is None:
            return None
        return self._normalise(claims)

    def _decode_asymmetric(self, token: str) -> dict[str, Any] | None:
        client = self._jwks()
        if client is None:
            return None
        try:
            import jwt

            key = client.get_signing_key_from_jwt(token).key
            return jwt.decode(
                token,
                key,
                algorithms=["RS256", "ES256"],
                audience=_EXPECTED_AUDIENCE,
                issuer=self.issuer,
            )
        except Exception as exc:
            # Expected when the project signs symmetrically; the caller falls
            # through to the secret path, so this is debug, not a warning.
            logger.debug("Asymmetric verification did not apply: %s", exc)
            return None

    def _decode_symmetric(self, token: str) -> dict[str, Any] | None:
        if not self._secret:
            return None
        try:
            import jwt

            return jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],
                audience=_EXPECTED_AUDIENCE,
                issuer=self.issuer,
            )
        except Exception as exc:
            logger.warning("Supabase token verification failed: %s", exc)
            return None

    @staticmethod
    def _normalise(claims: dict[str, Any]) -> dict[str, Any] | None:
        """Flatten the claims routes care about.

        `role` is read from app_metadata, which is the only half of the token a
        user cannot edit -- user_metadata is self-service, so trusting a role
        from there would let anyone promote themselves to adjuster. This
        mirrors public.jwt_role() in the RLS migration, which reads the same
        path, so the API and the database agree on who someone is.
        """
        uid = str(claims.get("sub") or "")
        if not uid:
            return None
        app_metadata = claims.get("app_metadata") or {}
        return {
            "uid": uid,
            "email": str(claims.get("email") or ""),
            "role": str(app_metadata.get("role") or ""),
            "raw": claims,
        }
