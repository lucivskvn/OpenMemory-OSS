"""
github connector for openmemory
requires: PyGithub
env vars: GITHUB_TOKEN
"""
from typing import List, Dict, Optional, Any
import os
import logging
from .base import BaseConnector, SourceItem, SourceContent, SourceAuthError

logger = logging.getLogger("openmemory.connectors.github")

class GithubConnector(BaseConnector):
    """connector for github repositories"""

    name = "github"

    def __init__(self, user_id: Optional[str] = None):
        super().__init__(user_id)
        self.github = None
        self.token = None

    async def _connect(self, **creds) -> bool:
        """authenticate with github api"""
        try:
            from github import Github, Auth  # type: ignore[attr-defined]  # type: ignore[attr-defined]
        except ImportError:
            raise ImportError("pip install PyGithub")

        self.token = creds.get("token") or os.environ.get("GITHUB_TOKEN")

        if not self.token:
            raise ValueError("no github token provided")

        token: str = self.token

        # Verify synchronously in thread to avoid block
        def _verify():
            g = Github(auth=Auth.Token(token))
            # Just accessing a property to check connection
            _ = g.get_user().login
            return g

        self.github = await self._run_blocking(_verify)  # type: ignore[attr-defined]
        return True

    async def _list_items(self, **filters) -> List[SourceItem]:  # type: ignore[return]
        """
        List files and optionally issues from a repository.

        Args:
            filters:
                repo: Repository name (owner/repo).
                path: Root path to list (default: "/").
                recursive: Whether to list files recursively (default: False).
                include_issues: Whether to include issues (default: False).
                max_issues: Maximum issues to fetch (default: 50).

        Returns:
            List of SourceItem objects.
        """
        repo_name = filters.get("repo")
        path = filters.get("path", "/")
        recursive = filters.get("recursive", False)
        include_issues = filters.get("include_issues", False)
        max_issues = filters.get("max_issues", 50)

        if not repo_name:
            raise ValueError("repo is required (format: owner/repo)")

        def _fetch_list():
            if not self.github:
                raise SourceAuthError("Not connected", self.name)

            repository = self.github.get_repo(repo_name)
            res = []

            # 1. Files
            clean_path = path.lstrip("/") if path != "/" else ""
            try:
                if recursive:
                    # Recursive listing using git tree API
                    tree = repository.get_git_tree(repository.default_branch, recursive=True)
                    for element in tree.tree:
                        # Filter by path if provided
                        if clean_path and not element.path.startswith(clean_path):
                            continue

                        res.append(
                            SourceItem(  # type: ignore[arg-type]
                                id=f"{repo_name}:{element.path}",
                                name=os.path.basename(element.path),
                                type="dir" if element.type == "tree" else "file",
                                path=element.path,
                                size=element.size or 0,
                                sha=element.sha,
                                metadata={"type": "git_tree", "mode": element.mode},
                            )
                        )
                else:
                    contents = repository.get_contents(clean_path)
                    if not isinstance(contents, list):
                        contents = [contents]

                    for c in contents:
                        res.append(
                            SourceItem(  # type: ignore[arg-type]
                                id=f"{repo_name}:{c.path}",
                                name=c.name,
                                type=(
                                    "dir" if c.type == "dir" else (c.encoding or "file")
                                ),
                                path=c.path,
                                size=c.size,
                                sha=c.sha,
                                metadata={"type": "contents"},
                            )
                        )
            except Exception as e:
                logger.warning(f"failed to list paths for {repo_name}/{clean_path}: {e}")

            # 2. Issues
            if include_issues:
                try:
                    issues = repository.get_issues(state="all", sort="updated", direction="desc")
                    count = 0
                    for issue in issues:
                        if count >= max_issues: break
                        res.append(
                            SourceItem(
                                id=f"{repo_name}:issue:{issue.number}",
                                name=issue.title,
                                type="issue",
                                path=f"issue/{issue.number}",
                                metadata={  # type: ignore[arg-type]  # type: ignore[arg-type]
                                    "number": issue.number,
                                    "state": issue.state,
                                    "labels": [l.name for l in issue.labels],
                                    "last_updated": (
                                        issue.updated_at.isoformat()
                                        if issue.updated_at
                                        else None
                                    ),
                                },
                            )
                        )
                        count += 1
                except Exception as e:
                    logger.warning(f"failed to fetch issues for {repo_name}: {e}")
            return res

        return await self._run_blocking(_fetch_list)  # type: ignore[attr-defined]

    async def _fetch_item(self, item_id: str) -> SourceContent:  # type: ignore[return]
        """fetch file or issue content"""
        parts = item_id.split(":")
        repo_name = parts[0]

        def _fetch_one():
            if not self.github:
                raise SourceAuthError("Not connected", self.name)

            repository = self.github.get_repo(repo_name)

            # Is Issue?
            if len(parts) >= 3 and parts[1] == "issue":
                issue_num = int(parts[2])
                issue = repository.get_issue(number=issue_num)

                text_parts = [
                    f"# {issue.title}",
                    f"State: {issue.state}",
                    f"Labels: {', '.join([l.name for l in issue.labels])}",
                    "",
                    issue.body or ""
                ]

                # Fetch comments with a safety limit
                comments = issue.get_comments()
                for i, comment in enumerate(comments):
                    if i >= 100:
                        text_parts.append("\n---\n*Truncated: too many comments*")
                        break
                    text_parts.append(f"\n---\n**{comment.user.login}:** {comment.body}")

                text = "\n".join(text_parts)
                return SourceContent(
                    id=item_id,
                    name=issue.title,
                    type="issue",
                    text=text,
                    data=text,
                    metadata={  # type: ignore[arg-type]  # type: ignore[arg-type]
                        "source": "github",
                        "repo": repo_name,
                        "issue_number": issue_num,
                        "state": issue.state,
                    },
                )

            # Is File/Dir
            else:
                fpath = ":".join(parts[1:]) if len(parts) > 1 else ""
                content = repository.get_contents(fpath)

                # Directory
                if isinstance(content, list):
                    text = "\n".join([f"- {c.path}" for c in content])
                    return SourceContent(  # type: ignore[arg-type]
                        id=item_id,
                        name=fpath or repo_name,
                        type="directory",
                        text=text,
                        data=text,
                        metadata={"source": "github", "repo": repo_name, "path": fpath},  # type: ignore[arg-type]
                    )

                # File
                try:
                    text = content.decoded_content.decode("utf-8")
                except:
                    text = ""

                return SourceContent(
                    id=item_id,
                    name=content.name,
                    type=content.encoding or "file",
                    text=text,
                    data=content.decoded_content,  # keeps bytes if binary
                    metadata={  # type: ignore[arg-type]  # type: ignore[arg-type]
                        "source": "github",
                        "repo": repo_name,
                        "path": content.path,
                        "sha": content.sha,
                        "size": content.size,
                    },
                )

        return await self._run_blocking(_fetch_one)
