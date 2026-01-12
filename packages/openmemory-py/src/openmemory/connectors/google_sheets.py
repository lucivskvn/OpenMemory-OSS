"""
google sheets connector for openmemory
requires: google-api-python-client, google-auth
env vars: GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_CREDENTIALS_JSON
"""
from typing import List, Dict, Optional
import os
import json
from .base import BaseConnector, SourceItem, SourceContent, SourceAuthError

class GoogleSheetsConnector(BaseConnector):
    """connector for google sheets"""

    name = "google_sheets"

    def __init__(self, user_id: Optional[str] = None):
        super().__init__(user_id)
        self.service = None
        self.creds = None

    async def connect(self, **creds) -> bool:
        """
        authenticate with google sheets api
        
        env vars:
            GOOGLE_SERVICE_ACCOUNT_FILE: path to service account json
            GOOGLE_CREDENTIALS_JSON: raw json string of credentials
        """
        try:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build
        except ImportError:
            raise ImportError("pip install google-api-python-client google-auth")

        scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

        if "credentials_json" in creds:
            self.creds = service_account.Credentials.from_service_account_info(
                creds["credentials_json"], scopes=scopes
            )
        elif "service_account_file" in creds:
            self.creds = service_account.Credentials.from_service_account_file(
                creds["service_account_file"], scopes=scopes
            )
        elif os.environ.get("GOOGLE_CREDENTIALS_JSON"):
            info = json.loads(os.environ["GOOGLE_CREDENTIALS_JSON"])
            self.creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
        elif os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE"):
            self.creds = service_account.Credentials.from_service_account_file(
                os.environ["GOOGLE_SERVICE_ACCOUNT_FILE"], scopes=scopes
            )
        else:
            raise ValueError("no google credentials provided")

        self.service = build("sheets", "v4", credentials=self.creds)
        self._connected = True
        return True

    async def list_items(
        self, spreadsheet_id: Optional[str] = None, **filters
    ) -> List[SourceItem]:  # type: ignore[override]
        """
        list sheets in a spreadsheet
        
        args:
            spreadsheet_id: the spreadsheet id to list sheets from
        """
        if not self._connected or not self.service:
            await self.connect()

        if not spreadsheet_id:
            raise ValueError("spreadsheet_id is required")

        if not self.service:
            raise SourceAuthError("Service not initialized", self.name)

        meta = self.service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()

        sheets: List[SourceItem] = []
        for sheet in meta.get("sheets", []):
            props = sheet.get("properties", {})
            sheets.append(
                SourceItem(
                    id=f"{spreadsheet_id}!{props.get('title', 'Sheet1')}",
                    name=props.get("title", "Sheet1"),
                    type="sheet",
                    path=f"/{spreadsheet_id}",
                    metadata={  # type: ignore[arg-type]  # type: ignore[arg-type]
                        "index": props.get("index", 0),
                        "spreadsheet_id": spreadsheet_id,
                    },
                )
            )

        return sheets

    async def fetch_item(self, item_id: str) -> SourceContent:  # type: ignore[override]
        """
        fetch sheet data as text
        
        item_id format: "spreadsheet_id!sheet_name" or just "spreadsheet_id"
        """
        if not self._connected:
            await self.connect()

        # parse item_id
        if "!" in item_id:
            spreadsheet_id, sheet_range = item_id.split("!", 1)
        else:
            spreadsheet_id = item_id
            sheet_range = "A:ZZ"  # all columns

        if not self.service:
            raise SourceAuthError("Service not initialized", self.name)

        result = self.service.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id,
            range=sheet_range
        ).execute()

        values = result.get("values", [])

        # convert to text table
        lines = []
        for row in values:
            lines.append(" | ".join([str(cell) for cell in row]))

        text = "\n".join(lines)

        return SourceContent(
            id=item_id,
            name=sheet_range,
            type="spreadsheet",
            text=text,
            data=text,
            metadata={  # type: ignore[arg-type]  # type: ignore[arg-type]
                "source": "google_sheets",
                "spreadsheet_id": spreadsheet_id,
                "range": sheet_range,
                "row_count": len(values),
            },
        )
