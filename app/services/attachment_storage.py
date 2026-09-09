"""Supabase-backed storage for claim attachments.

Firebase Storage needs the Blaze (paid) plan before it will provision a
bucket, so attachments live in Supabase Storage instead while Auth and
Firestore stay on Firebase. Nothing about the identity model changes: the
caller still proves who they are with a Firebase ID token, and the route
layer checks case ownership before calling in here.

The Supabase service key is a full-access credential, so it stays on the
server. The browser never talks to Supabase directly -- it POSTs to
/api/attachments and gets back a signed URL.
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

# Mirrors the three prefixes in firebase/storage.rules, so the access rules
# that used to live there map one-to-one onto folders here.
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
