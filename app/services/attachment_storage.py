"""Supabase-backed storage for claim attachments.

This was the first piece to move off Firebase -- Firebase Storage will not
provision a bucket without the paid Blaze plan -- and the rest of the app
followed. Auth, claim data and access control are all Supabase now.

The caller proves who they are with a Supabase access token, and the route
layer confirms the case is visible to them before calling in here. That
check runs on the caller's own token, so the RLS policies decide it.

The service key used here is a full-access credential and never leaves the
server: the browser POSTs to /api/attachments and gets back a signed URL for
a private bucket.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any
from uuid import uuid4

from app.core.config import (
    ATTACHMENT_URL_TTL_SECONDS,
    SUPABASE_ATTACHMENT_BUCKET,
    SUPABASE_SERVICE_KEY,
    SUPABASE_URL,
)

logger = logging.getLogger("claimsight.attachments")

# The three prefixes the app uses. These mirror what storage.rules used to
# police before it was deleted; the equivalent checks now live in the
# /api/attachments route.
ATTACHMENT_FOLDERS = {
    "supporting-documents": "claim-supporting-documents",
    "messages": "claim-messages",
    "reviewer-evidence": "claim-reviewer-evidence",
}

# Deliberately narrower than a browser file picker: images plus the document
# types the claim pages advertise. Anything else is rejected before upload.
ALLOWED_ATTACHMENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
}

_UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class AttachmentStorageError(RuntimeError):
    """Raised when Supabase rejects an upload or is not configured."""


def safe_object_name(filename: str) -> str:
    """Collapse a user-supplied filename into something safe for a URL path."""
    name = (filename or "attachment").strip().replace(" ", "-")
    name = _UNSAFE_NAME.sub("_", name)
    # Strip leading dots so the name can't become hidden or traverse upward.
    name = name.lstrip(".") or "attachment"
    return name[:120]


class SupabaseAttachmentStorage:
    def __init__(self) -> None:
        self._url = SUPABASE_URL
        self._key = SUPABASE_SERVICE_KEY
        self._bucket = SUPABASE_ATTACHMENT_BUCKET

    @property
    def ready(self) -> bool:
        return bool(self._url and self._key and self._bucket)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._key}",
            "apikey": self._key,
        }

    def object_path(self, folder_key: str, case_id: str, filename: str) -> str:
        folder = ATTACHMENT_FOLDERS[folder_key]
        stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
        # uuid4 prefix keeps two uploads of the same name in the same second
        # from colliding, which the old Date.now() key could not guarantee.
        return f"{folder}/{case_id}/{stamp}-{uuid4().hex[:8]}-{safe_object_name(filename)}"

    def upload(
        self,
        *,
        folder_key: str,
        case_id: str,
        filename: str,
        content: bytes,
        content_type: str,
    ) -> dict[str, Any]:
        if not self.ready:
            raise AttachmentStorageError(
                "Attachment storage is not configured. Set SUPABASE_URL and "
                "SUPABASE_SERVICE_KEY."
            )
        if folder_key not in ATTACHMENT_FOLDERS:
            raise AttachmentStorageError(f"Unknown attachment folder: {folder_key}")

        import requests

        path = self.object_path(folder_key, case_id, filename)
        endpoint = f"{self._url}/storage/v1/object/{self._bucket}/{path}"
        try:
            response = requests.post(
                endpoint,
                headers={
                    **self._headers(),
                    "Content-Type": content_type,
                    "x-upsert": "false",
                },
                data=content,
                timeout=30,
            )
        except Exception as exc:  # network failures shouldn't leak a stack trace
            logger.warning("Supabase upload failed for %s: %s", path, exc)
            raise AttachmentStorageError("Attachment upload failed.") from exc

        if response.status_code >= 400:
            logger.warning(
                "Supabase upload rejected %s: %s %s", path, response.status_code, response.text[:200]
            )
            raise AttachmentStorageError("Attachment upload was rejected by storage.")

        return {"path": path, "download_url": self.signed_url(path)}

    def ping(self) -> tuple[bool, str]:
        """Make the cheapest possible round-trip to Supabase.

        Used by /api/keepalive. Supabase pauses free projects after about a
        week of inactivity and restoring one is a manual click, so something
        has to reach the project on a schedule. Listing buckets is the
        lightest call that proves the project is awake and the key still
        works.
        """
        if not self.ready:
            return False, "not_configured"

        import requests

        try:
            response = requests.get(
                f"{self._url}/storage/v1/bucket",
                headers=self._headers(),
                timeout=15,
            )
        except Exception as exc:
            logger.warning("Supabase keepalive ping failed: %s", exc)
            return False, "unreachable"

        if response.status_code >= 400:
            logger.warning("Supabase keepalive ping got %s", response.status_code)
            return False, f"http_{response.status_code}"
        return True, "reachable"

    def signed_url(self, path: str) -> str:
        """Mint a time-limited download URL for a private-bucket object."""
        if not self.ready:
            raise AttachmentStorageError("Attachment storage is not configured.")

        import requests

        endpoint = f"{self._url}/storage/v1/object/sign/{self._bucket}/{path}"
        try:
            response = requests.post(
                endpoint,
                headers={**self._headers(), "Content-Type": "application/json"},
                json={"expiresIn": ATTACHMENT_URL_TTL_SECONDS},
                timeout=15,
            )
        except Exception as exc:
            logger.warning("Supabase signing failed for %s: %s", path, exc)
            raise AttachmentStorageError("Could not sign attachment URL.") from exc

        if response.status_code >= 400:
            logger.warning(
                "Supabase signing rejected %s: %s", path, response.status_code
            )
            raise AttachmentStorageError("Could not sign attachment URL.")

        signed = (response.json() or {}).get("signedURL") or ""
        if not signed:
            raise AttachmentStorageError("Storage returned no signed URL.")
        # Supabase returns a root-relative path; make it absolute for the browser.
        if signed.startswith("/"):
            return f"{self._url}/storage/v1{signed}"
        return signed
