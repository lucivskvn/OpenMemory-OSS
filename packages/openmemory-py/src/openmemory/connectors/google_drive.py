"""
google drive connector for openmemory
requires: google-api-python-client, google-auth
env vars: GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_CREDENTIALS_JSON
"""
from typing import List, Dict, Optional, Any
import os
import json
from .base import BaseConnector, SourceItem, SourceContent, SourceAuthError

class GoogleDriveConnector(BaseConnector):
    """connector for google drive documents"""

    name = "google_drive"

    def __init__(self, user_id: Optional[str] = None):
        super().__init__(user_id)
        self.service = None
        self.creds = None

    async def connect(self, **creds) -> bool:
        """
        authenticate with google drive api

        env vars:
            GOOGLE_SERVICE_ACCOUNT_FILE: path to service account json
            GOOGLE_CREDENTIALS_JSON: raw json string of credentials

        or pass:
            service_account_file: path to json file
            credentials_json: dict of credentials
        """
        try:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build
        except ImportError:
            raise ImportError("pip install google-api-python-client google-auth")

        scopes = ["https://www.googleapis.com/auth/drive.readonly"]

        # try creds passed in
        if "credentials_json" in creds:
            self.creds = service_account.Credentials.from_service_account_info(
                creds["credentials_json"], scopes=scopes
            )
        elif "service_account_file" in creds:
            self.creds = service_account.Credentials.from_service_account_file(
                creds["service_account_file"], scopes=scopes
            )
        # try env vars
        elif os.environ.get("GOOGLE_CREDENTIALS_JSON"):
            info = json.loads(os.environ["GOOGLE_CREDENTIALS_JSON"])
            self.creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
        elif os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE"):
            self.creds = service_account.Credentials.from_service_account_file(
                os.environ["GOOGLE_SERVICE_ACCOUNT_FILE"], scopes=scopes
            )
        else:
            raise ValueError("no google credentials provided")

        self.service = build("drive", "v3", credentials=self.creds)
        self._connected = True
        return True

    async def list_items(
        self,
        folder_id: Optional[str] = None,
        mime_types: Optional[List[str]] = None,
        **filters,
    ) -> List[SourceItem]:  # type: ignore[override]
        """
        list files from drive

        args:
            folder_id: optional folder to list from
            mime_types: filter by mime types (e.g. ["application/pdf"])
        """
        if not self._connected or not self.service:
            await self.connect()

        if not self.service:
            raise SourceAuthError("Service not initialized", self.name)

        q_parts = ["trashed=false"]

        if folder_id:
            q_parts.append(f"'{folder_id}' in parents")

        if mime_types:
            mime_q = " or ".join([f"mimeType='{m}'" for m in mime_types])
            q_parts.append(f"({mime_q})")

        query = " and ".join(q_parts)

        results = []
        page_token = None

        while True:
            resp = self.service.files().list(
                q=query,
                spaces="drive",
                fields="nextPageToken, files(id, name, mimeType, modifiedTime)",
                pageToken=page_token,
                pageSize=100
            ).execute()

            for f in resp.get("files", []):
                results.append(
                    SourceItem(
                        id=f["id"],
                        name=f["name"],
                        type=f.get("mimeType", "file"),
                        path=f"/{f['id']}",
                        updated_at=f.get("modifiedTime"),  # type: ignore[arg-type]
                        metadata={"mimeType": f.get("mimeType")},
                    )
                )

            page_token = resp.get("nextPageToken")
            if not page_token:
                break

        return results

    async def fetch_item(self, item_id: str) -> SourceContent:  # type: ignore[override]
        """fetch and extract text from a drive file"""
        if not self._connected or not self.service:
            await self.connect()

        if not self.service:
            raise SourceAuthError("Service not initialized", self.name)

        # get file metadata
        meta = self.service.files().get(fileId=item_id, fields="id,name,mimeType").execute()
        mime = meta["mimeType"]

        # google docs -> export as text
        if mime == "application/vnd.google-apps.document":
            content = self.service.files().export(
                fileId=item_id, mimeType="text/plain"
            ).execute()
            if isinstance(content, bytes):
                text = content.decode("utf-8")
            elif isinstance(content, (bytearray, memoryview)):
                text = bytes(content).decode("utf-8")
            else:
                text = str(content)

        # google sheets -> export as csv
        elif mime == "application/vnd.google-apps.spreadsheet":
            content = self.service.files().export(
                fileId=item_id, mimeType="text/csv"
            ).execute()
            if isinstance(content, bytes):
                text = content.decode("utf-8")
            elif isinstance(content, (bytearray, memoryview)):
                text = bytes(content).decode("utf-8")
            else:
                text = str(content)

        # google slides -> export as plain text
        elif mime == "application/vnd.google-apps.presentation":
            content = self.service.files().export(
                fileId=item_id, mimeType="text/plain"
            ).execute()
            text = content.decode("utf-8") if isinstance(content, bytes) else content

        # other files -> download raw
        else:
            from googleapiclient.http import MediaIoBaseDownload
            import io

            request = self.service.files().get_media(fileId=item_id)
            fh = io.BytesIO()
            downloader = MediaIoBaseDownload(fh, request)

            done = False
            while not done:
                _, done = downloader.next_chunk()

            text = fh.getvalue()

        payload_data: Any
        if isinstance(text, (bytes, bytearray, memoryview)):
            payload_data = bytes(text)
        elif isinstance(text, str):
            payload_data = text.encode("utf-8")
        else:
            payload_data = str(text)

        return SourceContent(
            id=item_id,
            name=meta.get("name", "unknown"),
            type=mime,
            text=text if isinstance(text, str) else "",
            data=payload_data,
            metadata={"source": "google_drive", "file_id": item_id, "mime_type": mime},  # type: ignore[arg-type]
        )
