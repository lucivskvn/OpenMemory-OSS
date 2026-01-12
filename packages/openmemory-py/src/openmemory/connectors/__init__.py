"""
openmemory connectors - data source integrations
"""
from .base import BaseConnector
from ..integrations.langchain import OpenMemoryChatMessageHistory, OpenMemoryRetriever
from ..integrations.agents import CrewAIMemory, memory_node
from .google_drive import GoogleDriveConnector
from .google_sheets import GoogleSheetsConnector
from .google_slides import GoogleSlidesConnector
from .notion import NotionConnector
from .onedrive import OneDriveConnector
from .github import GithubConnector
from .web_crawler import WebCrawlerConnector

__all__ = [
    "BaseConnector",
    "OpenMemoryChatMessageHistory",
    "OpenMemoryRetriever",
    "CrewAIMemory",
    "memory_node",
    "GoogleDriveConnector",
    "GoogleSheetsConnector",
    "GoogleSlidesConnector",
    "NotionConnector",
    "OneDriveConnector",
    "GithubConnector",
    "WebCrawlerConnector",
]
