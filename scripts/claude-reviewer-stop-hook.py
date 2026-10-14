#!/usr/bin/env python3
"""Trusted Claude reviewer Stop hook: persist, validate, then send one reply."""

from __future__ import annotations

import errno
from datetime import datetime, timezone
import fcntl
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time

MAX_MESSAGE_BYTES = 65_536
TRUNCATED_MESSAGE_BYTES = 60_000
MAX_STDIN_BYTES = 1_048_576
PROFILE = "gpt56-claude-v1"
PRODUCTION_PROJECTS_ROOT = Path("/home/dev/projects")
PRODUCTION_TEMPLATES = Path("/home/dev/projects/ai-dev-tool/templates/scripts")
# 2026-08-16 ユーザー指示「reviewer-dead-letter の Discord 通知はいらない」: Discord へは送らず記録だけ残す no-op に向ける。
# 親への agmsg 通知(notify_parent_dead_letter)は従来どおり。戻すときは notify-discord.sh に戻す。
PRODUCTION_NOTIFY_SCRIPT = Path("/home/dev/projects/.agent-scripts/notify-noop.sh")
PRODUCTION_AGMSG_SEND_SCRIPT = Path("/home/dev/.agents/skills/agmsg/scripts/send.sh")
NOTIFY_TIMEOUT_SEC = 20
CORE_REQUIRED_HELPERS = (
    "ai-review-reply.mjs",
    "ai-workflow-lib.mjs",
)
# DeepSeek一次確認→Opus独立確認(deepseek-opus-v1)が依存する helper 一式。
# ai-review-rounds-lib.mjs の DEEPSEEK_CHAIN_BASELINE_HELPERS と同じ顔ぶれに保つ
# (片方だけ古い組は受理しない)。存在しない場合は任意扱いのまま。
EXTENDED_REQUIRED_HELPERS = (
    "ai-review-send.mjs",
    "review-evidence.mjs",
    "deepseek-primary-review.mjs",
    "ai-review-lens-lib.mjs",
    "ai-complete.mjs",
    "ai-review-queue-lib.mjs",
    "ai-review-rounds-lib.mjs",
    "ai-review-wait.mjs",
)
REQUIRED_HELPERS = CORE_REQUIRED_HELPERS + EXTENDED_REQUIRED_HELPERS
# 任意 helper の「世代」。baseline を記録した時期で顔ぶれが違う。
#   - M-2 で照合対象へ足した 3 本だけを記録した世代(queue-lib / rounds-lib / wait)
#   - それ以前の配布一覧を記録した世代(実測: 24 レーンが 8 本のうち send.mjs 1 本だけを持つ)
# 旧世代 = 旧 3 本ちょうど、旧 3 本 + send.mjs(master の配布一覧が記録する 12 本形)、
# または足した側の 5 本に収まる(1 本も無い場合を含む)。
# この形は DeepSeek 連鎖の helper を 1 本も混ぜていないので、次回の正規起動基準から検査する。
# 混在(旧 3 本 + 足した側の一部)と旧 3 本の欠けだけを、配布が途中で止まった組として拒否する。
EXTENDED_LEGACY_ADDED_HELPERS = (
    "ai-review-queue-lib.mjs",
    "ai-review-rounds-lib.mjs",
    "ai-review-wait.mjs",
)
EXTENDED_NEW_HELPERS = (
    "ai-review-send.mjs",
    "review-evidence.mjs",
    "deepseek-primary-review.mjs",
    "ai-review-lens-lib.mjs",
    "ai-complete.mjs",
)
# v5 前夜世代: 旧 3 本 + send.mjs。master(4b282ae)の配布一覧(12 本)が記録する顔ぶれで、
# git 履歴でも 4d47f41(2026-09-17) が同じ組。追加側 5 本へ広げる前の正規の世代として受理する。
EXTENDED_LEGACY_SEND_HELPERS = ("ai-review-send.mjs",)
# R3(2026-09-19) F3-1: この変更の配布一覧が記録する顔ぶれ(実測: ai-dev-tool HEAD 5a08ce に
# 新しい 2 本が無いため、F2-4 の「欠けた任意 helper は記録しない」で 6 本が載る)。
# 旧 3 本 + send + lens-lib + ai-complete の 6 本で、この変更で足した review-evidence.mjs と
# deepseek-primary-review.mjs を除いた形。配布途中の混在ではなく正規の途中世代なので受理し、
# 記録に載っている分の hash は検査する。載っていない 2 本は次回の正規起動基準から検査する。
EXTENDED_LEGACY_STAGED_HELPERS = (
    "ai-review-send.mjs",
    "ai-review-lens-lib.mjs",
    "ai-complete.mjs",
)


def optional_baseline_generation(
    present_names,
    optional_names: tuple[str, ...] = EXTENDED_REQUIRED_HELPERS,
) -> str:
    """任意 helper の収載の形を legacy / full / partial に分類する。"""
    known = set(optional_names)
    present = {name for name in present_names if name in known}
    if present == known:
        return "full"
    legacy_added = set(EXTENDED_LEGACY_ADDED_HELPERS) & known
    if not present or present == legacy_added:
        return "legacy"
    if present == legacy_added | (set(EXTENDED_LEGACY_SEND_HELPERS) & known):
        # R2(2026-09-19): master の配布一覧が記録する 12 本形(旧 3 本 + send.mjs)。
        return "legacy"
    if present <= set(EXTENDED_NEW_HELPERS):
        # 旧世代の配布一覧(実測: send.mjs だけが重なる)と、追加前の 5 本ちょうど。
        return "legacy"
    staged = (
        legacy_added
        | (set(EXTENDED_LEGACY_SEND_HELPERS) & known)
        | (set(EXTENDED_LEGACY_STAGED_HELPERS) & known)
    )
    if present and present == staged:
        # R3(2026-09-19) F3-1: 新しい 2 本が ai-dev-tool へ届く前の配布一覧(14 本形)が
        # 記録する 6 本。保留世代として受理し、載っている分だけを次段で hash 検査する。
        return "staged"
    return "partial"


IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
HEADER_KEYS = ("Project", "Repo", "Branch", "Task", "Team", "Request-ID")
TRUNCATED_MARKER = "\n\n[TRUNCATED: reviewer response exceeded 65536 bytes]\n"
ARCHIVE_PREFIX = "reviewer-final-"
UNSENT_PREFIX = "reviewer-unsent-"
STARTUP_RECOVERY_PREFIX = "reviewer-startup-ack-recovery-"
STARTUP_ACK_LEADING_LINES = 5
STARTUP_ACK_HEADER_SCAN_LINES = 20
ARCHIVE_LOCK_ATTEMPTS = 20
ARCHIVE_LOCK_RETRY_SEC = 0.05
STARTUP_ACK_PATTERN = re.compile(
    r"^\s*(?:(?:#{1,6}|[-*+>])\s+)?STARTUP_CONTRACT_ACK(?:\s*:.*)?\s*$"
)
REVIEW_VERDICT_LINE_PATTERN = re.compile(
    r"^\s*(?:(?:#{1,6}|[-*+])\s+)?(?:\*\*)?verdict(?:\*\*)?\s*:\s*"
    r"(ok|findings)(?:\s+(?=\S).+|\s*[-—:：。,.、（(【\[].*)?\s*$",
    re.IGNORECASE,
)
REVIEW_SIGNAL_VERDICT_LINE_PATTERN = re.compile(
    r"^\s*(?:(?:#{1,6}|[-*+>])\s+)?verdict\s*:\s*\S.*$",
    re.IGNORECASE,
)
REVIEW_REQUEST_ID_LINE_PATTERN = re.compile(
    r"^\s*(?:(?:#{1,6}|[-*+>])\s+)?Request-ID:\s*(\S+)\s*$"
)
HEADER_LINE_PATTERN = re.compile(
    rf"^({'|'.join(re.escape(key) for key in HEADER_KEYS)}):\s+\S.*$"
)


def report(message: str) -> None:
    print(f"CLAUDE_REVIEWER_STOP: {message}", file=sys.stderr)


def regular_non_symlink(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and not path.is_symlink()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(131_072), b""):
            digest.update(chunk)
    return digest.hexdigest()


def identifier(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= 128
        and ".." not in value
        and bool(IDENTIFIER_PATTERN.fullmatch(value))
    )


def validate_task_profile(task: object) -> tuple[str, str]:
    if not isinstance(task, dict) or task.get("workflowProfile") != PROFILE:
        raise ValueError(f"workflowProfile is not {PROFILE}")
    for key in ("project", "repo", "branch", "task", "team"):
        if not isinstance(task.get(key), str) or not task[key]:
            raise ValueError(f"task.{key} is missing")
    if not identifier(task["repo"]):
        raise ValueError("task.repo identifier is invalid")
    if not identifier(task["team"]):
        raise ValueError("task.team identifier is invalid")
    implementer = task.get("implementer")
    reviewer = task.get("reviewer")
    implementer_id = implementer.get("id") if isinstance(implementer, dict) else None
    reviewer_id = reviewer.get("id") if isinstance(reviewer, dict) else None
    if not identifier(implementer_id) or not identifier(reviewer_id):
        raise ValueError("task implementer/reviewer identifier is invalid")
    return implementer_id, reviewer_id


def logical_repo_name(repo: Path) -> tuple[str, str | None]:
    """Resolve the routing identity from current-task.json, with an explicit fallback."""
    fallback = repo.name.lower()
    task_file = repo / ".ai" / "current-task.json"
    try:
        if not regular_non_symlink(task_file):
            raise ValueError("current-task.json is not a regular non-symlink file")
        task = json.loads(task_file.read_text(encoding="utf-8"))
        validate_task_profile(task)
        name = task.get("repo")
        return name.lower(), None
    except Exception as error:
        return (
            fallback,
            f"logical repo fallback to directory name {fallback}: {error}",
        )


def reason_with_repo_fallback(reason: str, fallback_reason: str | None) -> str:
    return f"{reason}; {fallback_reason}" if fallback_reason else reason


def truncate_utf8(message: str) -> str:
    marker = TRUNCATED_MARKER.encode("utf-8")
    limit = TRUNCATED_MESSAGE_BYTES - len(marker)
    prefix = message.encode("utf-8")[:limit]
    while True:
        try:
            return prefix.decode("utf-8") + TRUNCATED_MARKER
        except UnicodeDecodeError as error:
            prefix = prefix[: error.start]


def roots() -> tuple[Path, Path, str, str, str]:
    if os.environ.get("CLAUDE_REVIEWER_HOOK_TEST") == "1":
        projects = Path(os.environ.get("PROJECTS_ROOT", str(PRODUCTION_PROJECTS_ROOT)))
        templates = Path(os.environ.get("AI_DEV_TOOL_TEMPLATE_SCRIPTS", str(PRODUCTION_TEMPLATES)))
        node = os.environ.get("NODE_BIN", "/usr/bin/node")
        # No production fallback here: unlike the other test-mode overrides above, an
        # unset notify override must never resolve to the real notify-discord.sh, or a
        # dead-letter path exercised under test would post a real message to Discord.
        notify = os.environ.get("REVIEWER_DEAD_LETTER_NOTIFY_BIN", "")
        agmsg = os.environ.get("REVIEWER_DEAD_LETTER_AGMSG_BIN", "")
        return projects, templates, node, notify, agmsg
    return (
        PRODUCTION_PROJECTS_ROOT,
        PRODUCTION_TEMPLATES,
        "/usr/bin/node",
        str(PRODUCTION_NOTIFY_SCRIPT),
        str(PRODUCTION_AGMSG_SEND_SCRIPT),
    )


def bounded_id(value: str) -> str:
    if len(value) <= 48:
        return value
    return f"{value[:39]}-{hashlib.sha256(value.encode()).hexdigest()[:8]}"


def archive_file_name(team: str, task: str, request_id: str) -> str:
    task_digest = hashlib.sha256(task.encode("utf-8")).hexdigest()[:16]
    return (
        f"{ARCHIVE_PREFIX}t-{bounded_id(team)}-task-{task_digest}"
        f"-request-{bounded_id(request_id)}.md"
    )


def review_signal_lines(lines: list[str]) -> list[str]:
    """Return non-quoted lines outside Markdown fences for review-signal checks."""
    result: list[str] = []
    fence_char = ""
    fence_length = 0
    for line in lines:
        stripped = line.lstrip()
        fence_match = re.match(r"^(`{3,}|~{3,})", stripped)
        if fence_match:
            marker = fence_match.group(1)
            if not fence_char:
                fence_char = marker[0]
                fence_length = len(marker)
            elif (
                marker[0] == fence_char
                and len(marker) >= fence_length
                and not stripped[fence_match.end() :].strip()
            ):
                fence_char = ""
                fence_length = 0
            continue
        if not fence_char and not stripped.startswith(">"):
            result.append(line)
    return result


def has_review_signal(
    lines: list[str], acceptable_request_ids: tuple[str, ...] = ()
) -> bool:
    """Check review signals after applying fence and quote semantics exactly once."""
    signal_lines = review_signal_lines(lines)
    if acceptable_request_ids:
        has_request_id = any(
            match is not None and match.group(1) in acceptable_request_ids
            for line in signal_lines
            if (match := REVIEW_REQUEST_ID_LINE_PATTERN.fullmatch(line))
        )
    else:
        has_request_id = any(
            REVIEW_REQUEST_ID_LINE_PATTERN.fullmatch(line) for line in signal_lines
        )
    return has_request_id or any(
        REVIEW_SIGNAL_VERDICT_LINE_PATTERN.fullmatch(line) for line in signal_lines
    )


def has_review_verdict(lines: list[str], *, prefiltered: bool = False) -> bool:
    """Recognize an ok/findings verdict outside block quotes and fenced examples."""
    signal_lines = lines if prefiltered else review_signal_lines(lines)
    return any(REVIEW_VERDICT_LINE_PATTERN.fullmatch(line) for line in signal_lines)


def mentions_acceptable_request_id(
    message: str, acceptable_request_ids: tuple[str, ...]
) -> bool:
    """Preserve the legacy final-message gate's exact Request-ID mention check."""
    return any(value and value in message for value in acceptable_request_ids)


def startup_contract_marker_index(lines: list[str]) -> int | None:
    """Locate a startup marker in the supported leading/header-prefixed shapes."""
    for index, line in enumerate(lines[:STARTUP_ACK_LEADING_LINES]):
        if STARTUP_ACK_PATTERN.fullmatch(line):
            return index
    for start in range(min(STARTUP_ACK_HEADER_SCAN_LINES, len(lines))):
        seen_headers: set[str] = set()
        index = start
        while index < len(lines):
            match = HEADER_LINE_PATTERN.fullmatch(lines[index])
            if not match or match.group(1) in seen_headers:
                break
            seen_headers.add(match.group(1))
            index += 1
        if (
            seen_headers == set(HEADER_KEYS)
            and index < len(lines)
            and STARTUP_ACK_PATTERN.fullmatch(lines[index])
        ):
            return index
    return None


def is_startup_contract_review(
    message: str, acceptable_request_ids: tuple[str, ...]
) -> bool:
    """Match a supported startup marker followed by a real review signal."""
    lines = [line for line in message.splitlines() if line.strip()]
    marker_index = startup_contract_marker_index(lines)
    if marker_index is None:
        return False
    # Only inspect lines after the marker: the legacy pure-ACK shape can place the six
    # request headers before STARTUP_CONTRACT_ACK and must remain skippable. The startup
    # contract puts its marker outside fenced examples. If a fence was opened before the
    # marker, this slice cannot reconstruct that earlier state; classify conservatively
    # as lifecycle-only and preserve the full skip record.
    return has_review_signal(lines[marker_index + 1 :], acceptable_request_ids)


def is_startup_contract_ack(message: str) -> bool:
    """Match a startup marker only when no later final-review signal is present."""
    lines = [line for line in message.splitlines() if line.strip()]
    marker_index = startup_contract_marker_index(lines)
    if marker_index is None:
        return False
    return not has_review_signal(lines[marker_index + 1 :])


def acquire_archive_lock(logs_fd: int) -> None:
    """Bound replacement serialization so a stale peer cannot stall Stop indefinitely."""
    for attempt in range(ARCHIVE_LOCK_ATTEMPTS):
        try:
            fcntl.flock(logs_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if attempt + 1 == ARCHIVE_LOCK_ATTEMPTS:
                raise OSError("final archive replacement lock remained busy")
            time.sleep(ARCHIVE_LOCK_RETRY_SEC)


def open_directory(path: Path | str, *, dir_fd: int | None = None) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, dir_fd=dir_fd)
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        os.close(fd)
        raise OSError(f"not a directory: {path}")
    return fd


def open_logs_directory(ai_fd: int) -> int:
    """Open .ai/logs without following links, creating it safely when absent."""
    try:
        return open_directory("logs", dir_fd=ai_fd)
    except FileNotFoundError:
        try:
            os.mkdir("logs", 0o700, dir_fd=ai_fd)
        except FileExistsError:
            # A concurrent creator still has to pass the non-symlink directory check.
            pass
        return open_directory("logs", dir_fd=ai_fd)


def startup_recovery_path(repo: Path, request_id: str) -> Path:
    if not identifier(request_id):
        raise ValueError("startup recovery Request-ID is invalid")
    return repo / ".ai" / "context" / f"{STARTUP_RECOVERY_PREFIX}{request_id}.json"


def create_context_file(repo: Path, name: str, data: bytes) -> bool:
    """Atomically create one 0600 context file without following directory links."""
    temp_name = f".{name}.tmp-{os.getpid()}-{secrets.token_hex(6)}"
    ai_fd = open_directory(repo / ".ai")
    context_fd = -1
    temp_created = False
    try:
        context_fd = open_directory("context", dir_fd=ai_fd)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(temp_name, flags, 0o600, dir_fd=context_fd)
        temp_created = True
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("short write while saving recovery state")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(
                temp_name, name, src_dir_fd=context_fd, dst_dir_fd=context_fd,
                follow_symlinks=False,
            )
        except FileExistsError:
            return False
        os.unlink(temp_name, dir_fd=context_fd)
        temp_created = False
        os.fsync(context_fd)
        return True
    finally:
        if context_fd >= 0:
            if temp_created:
                try:
                    os.unlink(temp_name, dir_fd=context_fd)
                except OSError as error:
                    if error.errno != errno.ENOENT:
                        report(f"temporary recovery cleanup failed: {error}")
            os.close(context_fd)
        os.close(ai_fd)


def persist_startup_recovery(repo: Path, request_id: str, archive_name: str) -> Path:
    """Record replacement intent before the archive changes, closing the crash gap."""
    path = startup_recovery_path(repo, request_id)
    data = json.dumps(
        {"requestId": request_id, "archiveName": archive_name, "status": "pending"},
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8") + b"\n"
    if not create_context_file(repo, path.name, data):
        info = path.lstat() if path.exists() else None
        if (
            info is None or not regular_non_symlink(path)
            or stat.S_IMODE(info.st_mode) != 0o600 or path.read_bytes() != data
        ):
            raise OSError("startup recovery marker is unsafe or does not match")
    return path


def startup_recovery_pending(repo: Path, request_id: str, archive_name: str) -> bool:
    path = startup_recovery_path(repo, request_id)
    if not path.exists():
        return False
    if not regular_non_symlink(path) or stat.S_IMODE(path.lstat().st_mode) != 0o600:
        raise OSError("startup recovery marker is not a regular non-symlink file")
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise OSError(f"startup recovery marker is invalid: {error}") from error
    expected = {"requestId": request_id, "archiveName": archive_name, "status": "pending"}
    if state != expected:
        raise OSError("startup recovery marker does not match the current reply")
    return True


def prepare_startup_retry_state(repo: Path, request_id: str, message: str) -> str:
    """Return retry/delivered, creating a local retry state for shared-only legacy state."""
    path = repo / ".ai" / "context" / f"reviewer-reply-{request_id}.json"
    expected_sent = truncate_utf8(message) if len(message.encode("utf-8")) > MAX_MESSAGE_BYTES else message
    if path.exists():
        if not regular_non_symlink(path):
            raise OSError("existing reply state is not a regular non-symlink file")
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except Exception as error:
            raise OSError(f"existing reply state is invalid: {error}") from error
        if state.get("requestId") != request_id:
            raise OSError("existing reply state Request-ID does not match")
        body = state.get("body")
        if isinstance(body, str) and body.endswith(expected_sent):
            if state.get("status") == "sent":
                return "delivered"
            if state.get("status") == "send-attempted":
                raise OSError("genuine reply send outcome is ambiguous; automatic retry refused")
        return "retry"
    synthetic = {
        "requestId": request_id,
        "status": "sent",
        "body": "STARTUP_CONTRACT_ACK:\nlegacy accepted reply recovery",
    }
    data = (json.dumps(synthetic, ensure_ascii=False) + "\n").encode("utf-8")
    if not create_context_file(repo, path.name, data):
        return prepare_startup_retry_state(repo, request_id, message)
    return "retry"


def clear_startup_recovery(repo: Path, request_id: str) -> None:
    path = startup_recovery_path(repo, request_id)
    ai_fd = open_directory(repo / ".ai")
    context_fd = -1
    try:
        context_fd = open_directory("context", dir_fd=ai_fd)
        try:
            info = os.stat(path.name, dir_fd=context_fd, follow_symlinks=False)
        except FileNotFoundError:
            return
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise OSError("startup recovery marker is not a safe 0600 regular file")
        os.unlink(path.name, dir_fd=context_fd)
        os.fsync(context_fd)
    finally:
        if context_fd >= 0:
            os.close(context_fd)
        os.close(ai_fd)


def read_archive(logs_fd: int, name: str) -> tuple[bytes, int]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(name, flags, dir_fd=logs_fd)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OSError("archive is not a regular file")
        chunks = []
        while True:
            chunk = os.read(fd, 131_072)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks), stat.S_IMODE(info.st_mode)
    finally:
        os.close(fd)


def persist_message(
    repo: Path,
    archive_name: str,
    message: str,
    *,
    replace_startup_ack: bool = False,
    recovery_request_id: str | None = None,
) -> tuple[Path, bool]:
    """Publish atomically, replacing only a legacy startup-ack archive when allowed."""
    data = message.encode("utf-8")
    temp_name = f".{archive_name}.tmp-{os.getpid()}-{secrets.token_hex(6)}"
    ai_fd = open_directory(repo / ".ai")
    logs_fd = -1
    temp_created = False
    replacing_startup_ack = False
    try:
        logs_fd = open_logs_directory(ai_fd)
        try:
            existing, mode = read_archive(logs_fd, archive_name)
        except FileNotFoundError:
            existing = None
            mode = 0
        if existing is not None:
            if mode != 0o600:
                raise OSError(f"existing archive mode is {mode:04o}, expected 0600")
            if existing != data:
                try:
                    existing_message = existing.decode("utf-8")
                except UnicodeDecodeError:
                    existing_message = ""
                if replace_startup_ack and is_startup_contract_ack(existing_message):
                    acquire_archive_lock(logs_fd)
                    # A peer may have replaced the startup acknowledgement before this
                    # process acquired the directory lock. Re-read under the lock and
                    # never overwrite a genuine answer that won that race.
                    try:
                        existing, mode = read_archive(logs_fd, archive_name)
                    except FileNotFoundError:
                        # A peer removed the obsolete acknowledgement while this
                        # process waited. Continue through the no-replace publish.
                        existing = None
                        mode = 0
                    if existing is None:
                        replacing_startup_ack = False
                    else:
                        if mode != 0o600:
                            raise OSError(f"existing archive mode is {mode:04o}, expected 0600")
                        if existing == data:
                            return repo / ".ai" / "logs" / archive_name, False
                        try:
                            existing_message = existing.decode("utf-8")
                        except UnicodeDecodeError:
                            existing_message = ""
                        if not is_startup_contract_ack(existing_message):
                            raise OSError(
                                "existing archive changed before startup acknowledgement replacement"
                            )
                        if not recovery_request_id:
                            raise OSError("startup acknowledgement replacement lacks recovery identity")
                        persist_startup_recovery(repo, recovery_request_id, archive_name)
                        replacing_startup_ack = True
                else:
                    raise OSError("existing archive content differs for the same task/team/Request-ID")
            else:
                return repo / ".ai" / "logs" / archive_name, False

        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(temp_name, flags, 0o600, dir_fd=logs_fd)
        temp_created = True
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise OSError("temporary archive is not a regular file")
            os.fchmod(fd, 0o600)
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("short write while saving reviewer answer")
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)

        if replacing_startup_ack:
            os.replace(
                temp_name,
                archive_name,
                src_dir_fd=logs_fd,
                dst_dir_fd=logs_fd,
            )
            temp_created = False
        else:
            try:
                # The hard-link publish is atomic and never replaces an existing entry.
                os.link(
                    temp_name,
                    archive_name,
                    src_dir_fd=logs_fd,
                    dst_dir_fd=logs_fd,
                    follow_symlinks=False,
                )
            except FileExistsError:
                existing, mode = read_archive(logs_fd, archive_name)
                if mode != 0o600 or existing != data:
                    raise OSError("archive appeared concurrently with unsafe mode or different content")
            os.unlink(temp_name, dir_fd=logs_fd)
            temp_created = False
        os.fsync(logs_fd)
        return repo / ".ai" / "logs" / archive_name, replacing_startup_ack
    finally:
        if logs_fd >= 0:
            if temp_created:
                try:
                    os.unlink(temp_name, dir_fd=logs_fd)
                except OSError as error:
                    if error.errno != errno.ENOENT:
                        report(f"temporary archive cleanup failed: {error}")
            os.close(logs_fd)
        os.close(ai_fd)


def persist_final_message(
    repo: Path, team: str, task: str, request_id: str, message: str
) -> tuple[Path, bool]:
    """Publish the complete reviewer answer atomically before any reply side effect."""
    if not identifier(team) or not identifier(request_id) or not task:
        raise ValueError("archive identity is invalid")
    return persist_message(
        repo,
        archive_file_name(team, task, request_id),
        message,
        replace_startup_ack=True,
        recovery_request_id=request_id,
    )


def persist_unsent_message(repo: Path, message: str) -> Path:
    """Dead-letter an answer with the same safety guarantees as the normal archive."""
    content_hash = hashlib.sha256(message.encode("utf-8")).hexdigest()[:16]
    ai_fd = open_directory(repo / ".ai")
    logs_fd = -1
    try:
        logs_fd = open_logs_directory(ai_fd)
        pattern = re.compile(
            rf"^{re.escape(UNSENT_PREFIX)}\d{{8}}T\d{{12}}Z-{content_hash}\.md$"
        )
        existing = sorted(name for name in os.listdir(logs_fd) if pattern.fullmatch(name))
    finally:
        if logs_fd >= 0:
            os.close(logs_fd)
        os.close(ai_fd)
    if existing:
        # persist_message verifies 0600, regular-file type, and exact content.
        return persist_message(repo, existing[0], message)[0]
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return persist_message(repo, f"{UNSENT_PREFIX}{timestamp}-{content_hash}.md", message)[0]


def persist_startup_ack_skip(repo: Path, message: str) -> Path:
    """Record why a pure startup acknowledgement was intentionally not delivered."""
    record = (
        "# REVIEWER_STARTUP_ACK_SKIPPED\n\n"
        "Reason: response contained a startup acknowledgement without a "
        "later Request-ID or verdict line, so it was treated as lifecycle-only.\n\n"
        "## Original response\n\n"
        f"{message}\n"
    )
    return persist_unsent_message(repo, record)


def has_header_shape(message: str) -> bool:
    lines = message.splitlines()
    return all(any(re.fullmatch(rf"{re.escape(key)}:\s+\S.*", line) for line in lines) for key in HEADER_KEYS)


def request_id_from_message(message: str | None) -> str | None:
    if not message:
        return None
    for line in message.splitlines():
        match = re.fullmatch(r"Request-ID:\s*(\S+)", line.strip())
        if match and identifier(match.group(1)):
            return match.group(1)
    return None


def content_hash_from_message(message: str | None) -> str | None:
    if not message:
        return None
    for line in message.splitlines():
        match = re.fullmatch(r"Content-Hash:\s*([0-9a-f]{64})", line.strip())
        if match:
            return match.group(1)
    return None


def notify_parent_dead_letter(
    send_bin: str,
    repo_name: str,
    fallback_reason: str | None,
    path: Path,
    reason: str,
    request_id: str | None,
    replacement_request_id: str | None,
) -> tuple[bool, str]:
    """Send the persisted path and request identity to the repo's canonical parent."""
    try:
        if not regular_non_symlink(Path(send_bin)):
            return False, "agmsg send.sh is unavailable or unsafe"
        if not identifier(repo_name):
            return False, "repo name cannot form a safe cc-bridge team"
        bridge_team = f"{repo_name}-cc-bridge"
        team_check_warning = None
        team_confirmed = False
        team_check_timeout = NOTIFY_TIMEOUT_SEC
        test_mode = os.environ.get("CLAUDE_REVIEWER_HOOK_TEST") == "1"
        if test_mode:
            test_timeout = os.environ.get("REVIEWER_DEAD_LETTER_TIMEOUT_SEC", "")
            if test_timeout:
                try:
                    parsed_timeout = float(test_timeout)
                    if 0 < parsed_timeout <= NOTIFY_TIMEOUT_SEC:
                        team_check_timeout = parsed_timeout
                except ValueError:
                    pass
            team_bin_value = os.environ.get("REVIEWER_DEAD_LETTER_TEAM_BIN", "")
            team_bin = (
                Path(team_bin_value)
                if team_bin_value
                else Path(send_bin).with_name("team.sh")
            )
            if not team_bin_value and not regular_non_symlink(team_bin):
                # Older hook tests inject only send.sh. They exercise message shape,
                # not the production team-membership preflight.
                team_bin = None
                team_confirmed = True
        else:
            team_bin = Path(send_bin).with_name("team.sh")
        if team_bin is not None:
            if not regular_non_symlink(team_bin):
                team_check_warning = "agmsg team.sh is unavailable or unsafe"
            else:
                try:
                    team_check = subprocess.run(
                        [str(team_bin), bridge_team],
                        check=False,
                        capture_output=True,
                        text=True,
                        timeout=team_check_timeout,
                    )
                    combined_output = "\n".join(
                        part for part in (team_check.stdout, team_check.stderr) if part
                    )
                    output_lines = [line.strip() for line in combined_output.splitlines()]
                    missing_line = f"Team not found: {bridge_team}"
                    detail = " ".join(combined_output.split())[:500] or "no diagnostic"
                    if missing_line in output_lines:
                        return False, f"cc-bridge team is missing: {bridge_team}"
                    recipient_found = any(
                        re.fullmatch(r"claude-code\s+\([^\r\n]+\)\s+—\s+.+", line)
                        for line in output_lines
                    )
                    if team_check.returncode == 0 and recipient_found:
                        team_confirmed = True
                    else:
                        team_check_warning = (
                            f"cc-bridge team membership unconfirmed status="
                            f"{team_check.returncode}"
                        )
                        report(
                            "REVIEWER_DEAD_LETTER_TEAM_CHECK_DIAGNOSTIC: "
                            f"{team_check_warning}: {detail}"
                        )
                except subprocess.TimeoutExpired:
                    team_check_warning = (
                        f"cc-bridge team check timed out after {team_check_timeout}s"
                    )
            if team_check_warning:
                report(f"REVIEWER_DEAD_LETTER_TEAM_CHECK_WARNING: {team_check_warning}")
        old_id = request_id or "unknown"
        supersede = (
            f" old Request-ID={old_id} new Request-ID={replacement_request_id} 出し直しあり"
            if replacement_request_id and replacement_request_id != old_id
            else f" Request-ID={old_id}"
        )
        routed_reason = reason_with_repo_fallback(reason, fallback_reason)
        if team_check_warning:
            routed_reason = f"{routed_reason}; {team_check_warning}"
        reason_without_ansi = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", routed_reason)
        printable_reason = "".join(char if char.isprintable() else " " for char in reason_without_ansi)
        safe_reason = " ".join(printable_reason.split())[:800]
        body = (
            f"REVIEWER_UNSENT_SAVED repo={repo_name} path={path}{supersede} "
            f"reason={safe_reason}"
        )
        completed = subprocess.run(
            [send_bin, bridge_team, "claude-reviewer-stop-hook", "claude-code", body],
            check=False,
            capture_output=True,
            text=True,
            timeout=NOTIFY_TIMEOUT_SEC,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "no diagnostic").strip()[:500]
            report(
                "REVIEWER_DEAD_LETTER_SEND_DIAGNOSTIC: "
                f"status={completed.returncode}: {detail}"
            )
            return False, f"agmsg send failed status={completed.returncode}"
        if not team_confirmed:
            return False, (
                "agmsg send attempted but parent team membership was not confirmed: "
                f"{team_check_warning or 'no diagnostic'}"
            )
        return True, bridge_team
    except Exception as error:
        return False, str(error)


def notify_dead_letter(
    notify_bin: str,
    repo_name: str,
    fallback_reason: str | None,
    reason: str,
    team: str | None,
) -> None:
    """Best-effort push so a dropped reviewer answer is never only visible in stderr.

    A prior design relied solely on lane-watch.sh (a separately started, separately
    configured watcher) to surface dead-letters. Its own startup can silently fail
    (LANE_WATCH_SKIPPED) or its notify step can fail without anyone reading its log.
    Firing from inside the hook, at the exact moment of the drop, removes that
    configuration/timing dependency. Failure here must never affect Stop's exit code.
    """
    try:
        if not regular_non_symlink(Path(notify_bin)):
            return
        # reason strings can, in principle, carry helper stdout (see the
        # REQUIRED_HELPERS / reply-helper-failure call sites), so cap what leaves
        # the machine even though every current caller populates it from stderr only.
        routed_reason = reason_with_repo_fallback(reason, fallback_reason)
        body = f"repo={repo_name} team={team or 'unknown'} reason={routed_reason[:300]}"
        subprocess.run(
            [notify_bin, "reviewer-dead-letter", body],
            check=False,
            capture_output=True,
            timeout=NOTIFY_TIMEOUT_SEC,
        )
    except Exception as error:
        report(f"REVIEWER_DEAD_LETTER_NOTIFY_FAILED: {error}")


def dead_letter(
    repo: Path,
    message: str | None,
    reason: str,
    *,
    require_header_shape: bool = False,
    status: int = 0,
    team: str | None = None,
    notify_bin: str | None = None,
    agmsg_bin: str | None = None,
    request_id: str | None = None,
    replacement_request_id: str | None = None,
) -> int:
    """Persist a plausible reviewer answer while preserving fail-closed delivery."""
    if message is None:
        return status
    try:
        encoded = message.encode("utf-8")
    except UnicodeError:
        return status
    if b"\x00" in encoded:
        return status
    if require_header_shape and not has_header_shape(message):
        return status
    repo_name, fallback_reason = logical_repo_name(repo)
    # Persist first: preserving the answer must not depend on the network call below
    # succeeding or even completing promptly.
    try:
        path = persist_unsent_message(repo, message)
    except Exception as error:
        report(
            f"REVIEWER_DEAD_LETTER_FAILED: {error}; original reason: {reason}; "
            "reply not sent and Stop is allowed to exit"
        )
        if notify_bin:
            notify_dead_letter(notify_bin, repo_name, fallback_reason, reason, team)
        return 0
    report(f"REVIEWER_REPLY_DROPPED: {path}; reason: {reason}")
    agmsg_failure = ""
    if agmsg_bin:
        delivered, detail = notify_parent_dead_letter(
            agmsg_bin,
            repo_name,
            fallback_reason,
            path,
            reason,
            request_id or request_id_from_message(message),
            replacement_request_id,
        )
        if delivered:
            report(f"REVIEWER_DEAD_LETTER_PARENT_NOTIFIED: team={detail} to=claude-code")
        else:
            agmsg_failure = f"; agmsgによる親への通知に失敗: {detail}"
            report(f"REVIEWER_DEAD_LETTER_PARENT_NOTIFY_FAILED: {detail}")
    if notify_bin:
        notify_dead_letter(
            notify_bin,
            repo_name,
            fallback_reason,
            f"{reason}{agmsg_failure}",
            team,
        )
    return status


def load_reviewer_request(
    path: Path,
    task: dict,
    implementer_id: str,
    reviewer_id: str,
) -> dict:
    if not regular_non_symlink(path):
        raise ValueError("reviewer-current-request.json is not a regular non-symlink file")
    request = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(request, dict):
        raise ValueError("request root is not an object")
    for key in ("project", "repo", "branch", "task", "team"):
        if request.get(key) != task.get(key):
            raise ValueError(f"request.{key} does not match current-task.json")
    request_id = request.get("requestId")
    if not identifier(request_id):
        raise ValueError("requestId identifier is invalid")
    if request.get("from") != implementer_id or request.get("to") != reviewer_id:
        raise ValueError("request from/to does not match task identities")
    for key in ("team", "from", "to"):
        if not identifier(request.get(key)):
            raise ValueError(f"request.{key} identifier is invalid")
    return request


@lru_cache(maxsize=16)
def git_common_dir(path: Path) -> Path | None:
    try:
        completed = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--path-format=absolute", "--git-common-dir"],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = completed.stdout.strip()
    return Path(value).resolve() if completed.returncode == 0 and value else None


@lru_cache(maxsize=16)
def helper_source(repo: Path, templates_root: Path) -> tuple[Path, Path]:
    canonical = templates_root.parent.parent.resolve()
    repo_common = git_common_dir(repo)
    canonical_common = git_common_dir(canonical)
    if repo_common is None or canonical_common is None:
        report("HELPER_SOURCE_DETECTION_WARN: git保管庫の共有判定ができないため中央checkoutを基準にします")
    if repo_common is not None and repo_common == canonical_common:
        return repo.resolve(), Path("scripts")
    return canonical, Path("templates/scripts")


def committed_template_sha256(repo: Path, templates_root: Path, name: str) -> str | None:
    """Return sha256 of templates/scripts/<name> as committed at HEAD of the canonical
    ai-dev-tool checkout, or None when git cannot answer (not a repo, git missing).

    2026-08-16: comparing against the canonical *working tree* made every reviewer reply
    in every repo dead-letter whenever ai-dev-tool had uncommitted template edits (a lane
    was mid-implementation). knowledge/scripts/review-request.sh already compares against
    `git show HEAD:templates/scripts/<name>`; align the hook to the same committed truth.
    """
    try:
        source_repo, source_tree = helper_source(repo, templates_root)
        rel = source_tree / name
    except ValueError:
        return None
    try:
        completed = subprocess.run(
            ["git", "-C", str(source_repo), "show", f"HEAD:{rel.as_posix()}"],
            check=False,
            capture_output=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return hashlib.sha256(completed.stdout).hexdigest()


def current_template_head(repo: Path, templates_root: Path) -> str | None:
    canonical, _ = helper_source(repo, templates_root)
    try:
        completed = subprocess.run(
            ["git", "-C", str(canonical), "rev-parse", "--verify", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = completed.stdout.strip()
    return value if completed.returncode == 0 and re.fullmatch(r"[0-9a-f]{40,64}", value) else None


def load_helper_baseline(
    repo: Path,
    templates_root: Path,
    names: tuple[str, ...],
    optional_names: tuple[str, ...] = (),
) -> dict | None:
    path = repo / ".ai" / "context" / "helper-baseline.json"
    if not path.exists() and not path.is_symlink():
        return None
    if not regular_non_symlink(path):
        raise ValueError("helper-baseline.json is not a regular non-symlink file")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        raise ValueError("helper-baseline.json has an invalid schema")
    source_repo = data.get("sourceRepo")
    source_head = data.get("sourceHead")
    hashes = data.get("helpers")
    source, source_tree = helper_source(repo, templates_root)
    accepted_sources = {source}
    if source_tree == Path("scripts"):
        # 切替前のbaselineは中央checkoutを記録していた。hashとsourceHeadの検査は維持する。
        accepted_sources.add(templates_root.parent.parent.resolve())
    if not isinstance(source_repo, str) or Path(source_repo).resolve() not in accepted_sources:
        raise ValueError("helper-baseline.json sourceRepo does not match ai-dev-tool")
    if not isinstance(source_head, str) or not re.fullmatch(r"[0-9a-f]{40,64}", source_head):
        raise ValueError("helper-baseline.json sourceHead is invalid")
    if not isinstance(hashes, dict):
        raise ValueError("helper-baseline.json helpers is invalid")
    for name in names:
        if not re.fullmatch(r"[0-9a-f]{64}", str(hashes.get(name) or "")):
            raise ValueError(f"helper-baseline.json hash is invalid: {name}")
    present_optional = [name for name in optional_names if name in hashes]
    generation = optional_baseline_generation(present_optional, optional_names)
    if generation == "partial":
        missing = ", ".join(name for name in optional_names if name not in hashes)
        raise ValueError(f"optional helper hashes are incomplete: {missing}")
    if generation == "legacy":
        # 旧世代の基準は旧 baseline をそのまま受け入れ、新 5 本は次回の正規起動基準から検査する。
        present_optional = []
    for name in present_optional:
        if not re.fullmatch(r"[0-9a-f]{64}", str(hashes.get(name) or "")):
            raise ValueError(f"helper-baseline.json hash is invalid: {name}")
    return data


def baseline_is_behind(repo: Path, templates_root: Path, baseline_head: str, current_head: str) -> bool:
    source_repo, _ = helper_source(repo, templates_root)
    try:
        completed = subprocess.run(
            [
                "git", "-C", str(source_repo), "merge-base", "--is-ancestor",
                baseline_head, current_head,
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


def helpers_changed_since_baseline(
    repo: Path,
    templates_root: Path,
    source_tree: Path,
    names: tuple[str, ...],
    baseline_head: str,
    current_head: str,
) -> bool:
    source_repo, _ = helper_source(repo, templates_root)
    try:
        completed = subprocess.run(
            [
                "git", "-C", str(source_repo), "diff", "--quiet",
                baseline_head, current_head, "--",
                *(str(source_tree / name) for name in names),
            ],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        return True
    return completed.returncode != 0


def helper_hash_status(
    repo: Path,
    templates_root: Path,
    names: tuple[str, ...],
    optional_names: tuple[str, ...] = (),
) -> tuple[str | None, str | None]:
    try:
        baseline = load_helper_baseline(repo, templates_root, names, optional_names)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return f"MISMATCH_REVIEW_HELPER: helper-baseline.json: {error}", None
    extended_baseline = baseline is not None and all(
        name in baseline["helpers"] for name in optional_names
    )
    recorded_optional = (
        tuple(name for name in optional_names if name in baseline["helpers"])
        if baseline is not None
        else ()
    )
    if extended_baseline:
        optional_checked = optional_names
    elif (
        recorded_optional
        and optional_baseline_generation(recorded_optional, optional_names) == "staged"
    ):
        # R3(2026-09-19) F3-1: 途中世代(14 本形)は、記録に載っている helper だけを
        # 現物と照合する。載っていない 2 本は記録が揃った時点から検査する。
        optional_checked = recorded_optional
    else:
        optional_checked = ()
    checked_names = names + optional_checked
    current_head = current_template_head(repo, templates_root)
    deployed_hashes: dict[str, str] = {}
    for name in checked_names:
        deployed = repo / "scripts" / name
        if not regular_non_symlink(deployed):
            return f"helper is not a regular non-symlink file: {name}", None
        try:
            deployed_hashes[name] = sha256(deployed)
        except OSError as error:
            return f"helper hash failed for {name}: {error}", None
    baseline_matches = baseline is not None and all(
        deployed_hashes[name] == baseline["helpers"][name] for name in checked_names
    )
    if not baseline_matches:
        for name in checked_names:
            committed_hash = committed_template_sha256(repo, templates_root, name)
            if committed_hash is None:
                return f"MISMATCH_REVIEW_HELPER: {name}: committed HEAD unavailable", None
            if deployed_hashes[name] != committed_hash:
                return f"MISMATCH_REVIEW_HELPER: {name}", None
    warning = None
    if baseline is not None and optional_names and not extended_baseline:
        pending = [name for name in optional_names if name not in baseline["helpers"]]
        detail = f"({', '.join(pending)})" if pending else ""
        warning = (
            "HELPER_BASELINE_OPTIONAL_PENDING: 既存レーンは従来helperを検査し、"
            f"新規helper{detail}は次回の正規起動基準から検査します"
        )
    if (
        baseline is not None
        and baseline_matches
        and current_head
        and current_head != baseline["sourceHead"]
        and baseline_is_behind(repo, templates_root, baseline["sourceHead"], current_head)
    ):
        _, source_tree = helper_source(repo, templates_root)
        baseline_source_tree = source_tree
        if (
            source_tree == Path("scripts")
            and Path(baseline["sourceRepo"]).resolve() == templates_root.parent.parent.resolve()
            and repo.resolve() != templates_root.parent.parent.resolve()
        ):
            baseline_source_tree = Path("templates/scripts")
        if helpers_changed_since_baseline(
            repo,
            templates_root,
            baseline_source_tree,
            checked_names,
            baseline["sourceHead"],
            current_head,
        ):
            label = "このレーンのhelper" if baseline_source_tree == Path("scripts") else "ai-dev-tool"
            behind_warning = (
                f"HELPER_BASELINE_BEHIND: {label} {current_head[:12]} より古い "
                f"(baseline {baseline['sourceHead'][:12]})"
            )
            warning = f"{warning}\n{behind_warning}" if warning else behind_warning
    return None, warning


def load_latest_request(path: Path, task: dict, implementer_id: str, reviewer_id: str) -> dict:
    if not regular_non_symlink(path):
        raise ValueError("review-request.json is not a regular non-symlink file")
    latest = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(latest, dict):
        raise ValueError("review-request.json root is not an object")
    status = latest.get("status")
    if status not in {"prepared", "send-attempted", "sent", "accepted", "reset"}:
        raise ValueError(
            f"latest review request status is {status!r}, expected a known review state"
        )
    for key in ("project", "repo", "branch", "task", "team"):
        if latest.get(key) != task.get(key):
            raise ValueError(f"latest request.{key} does not match current-task.json")
    if latest.get("from") != implementer_id or latest.get("to") != reviewer_id:
        raise ValueError("latest request from/to does not match task identities")
    if not identifier(latest.get("requestId")):
        raise ValueError("latest Request-ID is invalid")
    if status in {"sent", "accepted"}:
        content_hash = latest.get("contentHash")
        if not isinstance(content_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", content_hash):
            raise ValueError("latest request contentHash is invalid")
    return latest


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        if len(raw) > MAX_STDIN_BYTES:
            report("stdin JSON is oversized; reply not sent")
            return 0
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("stdin root is not an object")
    except Exception as error:
        report(f"invalid Stop JSON: {error}")
        return 0

    projects_root, templates_root, node_bin, notify_bin, agmsg_bin = roots()
    try:
        projects_root = projects_root.resolve(strict=True)
        cwd_value = payload.get("cwd")
        if not isinstance(cwd_value, str) or not cwd_value:
            raise ValueError("cwd is missing")
        repo = Path(cwd_value).resolve(strict=True)
        if repo == projects_root or projects_root not in repo.parents:
            raise ValueError("cwd escapes PROJECTS_ROOT")
        top = subprocess.run(
            ["/usr/bin/git", "-C", str(repo), "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        if Path(top).resolve(strict=True) != repo:
            raise ValueError("cwd is not the real git root")
    except Exception as error:
        report(f"unsafe cwd: {error}")
        return 0

    raw_message = payload.get("last_assistant_message")
    message = raw_message.strip() if isinstance(raw_message, str) else None
    # Startup acknowledgements are lifecycle messages, not reviewer answers. Detect
    # them before task/request validation so a missing or concurrently replaced state
    # cannot turn the acknowledgement into a dead-letter and parent notification.
    if message and is_startup_contract_ack(message):
        try:
            skipped_path = persist_startup_ack_skip(repo, message)
            report(
                "REVIEWER_STARTUP_ACK_SKIPPED: "
                f"{skipped_path}; reason: no later Request-ID or verdict line"
            )
        except Exception as error:
            report(f"REVIEWER_STARTUP_ACK_SKIP_LOG_FAILED: {error}")
        return 0

    task_file = repo / ".ai" / "current-task.json"
    try:
        if not regular_non_symlink(task_file):
            raise ValueError("current-task.json is not a regular non-symlink file")
        task = json.loads(task_file.read_text(encoding="utf-8"))
        implementer_id, reviewer_id = validate_task_profile(task)
    except Exception as error:
        reason = f"invalid task profile: {error}"
        report(reason)
        return dead_letter(
            repo,
            message,
            reason,
            require_header_shape=True,
            notify_bin=notify_bin,
            agmsg_bin=agmsg_bin,
        )

    request_file = repo / ".ai" / "context" / "reviewer-current-request.json"
    if not request_file.exists():
        return dead_letter(
            repo,
            message,
            "reviewer-current-request.json is missing",
            require_header_shape=True,
            team=task["team"],
            notify_bin=notify_bin,
            agmsg_bin=agmsg_bin,
        )
    if not regular_non_symlink(request_file):
        reason = "reviewer-current-request.json is not a regular non-symlink file"
        report(reason)
        return dead_letter(
            repo, message, reason, team=task["team"], notify_bin=notify_bin, agmsg_bin=agmsg_bin
        )
    try:
        request = load_reviewer_request(request_file, task, implementer_id, reviewer_id)
        request_id = request["requestId"]
    except Exception as error:
        reason = f"invalid reviewer request: {error}"
        report(reason)
        return dead_letter(
            repo, message, reason, team=task["team"], notify_bin=notify_bin, agmsg_bin=agmsg_bin
        )

    if message is None:
        report("last_assistant_message is missing")
        return 0
    try:
        encoded = message.encode("utf-8")
    except UnicodeError as error:
        report(f"last_assistant_message is invalid UTF-8: {error}")
        return 0
    if not message:
        report("last_assistant_message is empty")
        return 0
    if b"\x00" in encoded:
        report("last_assistant_message contains NUL")
        return 0
    if len(encoded) < 80:
        reason = "last_assistant_message is shorter than 80 bytes"
        report(reason)
        return dead_letter(
            repo,
            message,
            reason,
            team=request["team"],
            notify_bin=notify_bin,
            agmsg_bin=agmsg_bin,
            request_id=request_id,
        )
    # A force-new/supersede can land while the reviewer is still writing the old-ID
    # answer. Rebind only when the old inbox body normalizes to the latest request's
    # contentHash; otherwise the requests are materially different and delivery stays
    # fail-closed with an explicit old/new-ID parent notification.
    rebound_from: str | None = None
    retry_replaced_startup_ack = False
    latest_request_file = repo / ".ai" / "context" / "review-request.json"
    if regular_non_symlink(latest_request_file):
        try:
            latest = load_latest_request(latest_request_file, task, implementer_id, reviewer_id)
        except Exception as error:
            reason = f"latest review request is invalid: {error}; reply not sent"
            report(reason)
            return dead_letter(
                repo, message, reason, team=request["team"], notify_bin=notify_bin,
                agmsg_bin=agmsg_bin, request_id=request_id,
            )
        if latest["status"] not in {"sent", "accepted"}:
            report(
                f"REVIEW_REBIND_SKIPPED: latest status={latest['status']}; "
                "continue the existing reviewer reply route"
            )
            latest_request_id = request_id
        else:
            latest_request_id = latest["requestId"]
        if latest["status"] == "accepted":
            if latest_request_id == request_id:
                try:
                    archive_path, replaced_startup_ack = persist_final_message(
                        repo, request["team"], request["task"], request_id, message
                    )
                except Exception as error:
                    reason = f"REVIEW_ARCHIVE_FAILED: {error}; accepted reply was not silently dropped"
                    report(reason)
                    return dead_letter(
                        repo, message, reason, team=request["team"], notify_bin=notify_bin,
                        agmsg_bin=agmsg_bin, request_id=request_id,
                    )
                report(f"REVIEW_ARCHIVED: {archive_path}")
                try:
                    recovery_pending = replaced_startup_ack or startup_recovery_pending(
                        repo, request_id, archive_path.name
                    )
                    recovery_action = (
                        prepare_startup_retry_state(repo, request_id, message)
                        if recovery_pending else "none"
                    )
                except Exception as error:
                    reason = f"startup acknowledgement recovery failed: {error}"
                    report(reason)
                    return dead_letter(
                        repo, message, reason, team=request["team"], notify_bin=notify_bin,
                        agmsg_bin=agmsg_bin, request_id=request_id,
                    )
                if recovery_action == "delivered":
                    clear_startup_recovery(repo, request_id)
                    report(f"REVIEW_REPLY_ALREADY_ACCEPTED: Request-ID={request_id}; prior resend completed")
                    return 0
                if recovery_pending:
                    retry_replaced_startup_ack = True
                    report(
                        f"REVIEWER_STARTUP_ACK_ARCHIVE_REPLACED: Request-ID={request_id}; "
                        "resending genuine review"
                    )
                else:
                    report(f"REVIEW_REPLY_ALREADY_ACCEPTED: Request-ID={request_id}; no resend needed")
                    return 0
            else:
                reason = (
                    f"old Request-ID {request_id} was superseded by already accepted "
                    f"Request-ID {latest_request_id}; old reply was not rebound (出し直しあり)"
                )
                report(reason)
                return dead_letter(
                    repo, message, reason, team=request["team"], notify_bin=notify_bin,
                    agmsg_bin=agmsg_bin, request_id=request_id,
                    replacement_request_id=latest_request_id,
                )
        if latest_request_id != request_id:
            old_body = request.get("body")
            recorded_hash = content_hash_from_message(old_body)
            if recorded_hash is None and isinstance(old_body, str) and f"Request-ID: {request_id}" in old_body:
                # 旧形式にはContent-Hash行が無い。互換用の厳密比較だけを試し、
                # 文字列の往復変換で同一性を証明できなければ安全側で親通知へ倒す。
                normalized = old_body.replace(request_id, "__REQUEST_ID__").replace("\r\n", "\n").rstrip("\n")
                recorded_hash = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
            if recorded_hash != latest["contentHash"]:
                reason = (
                    f"old Request-ID {request_id} was superseded by {latest_request_id}; "
                    "request content differs, so reply was not rebound (出し直しあり)"
                )
                report(reason)
                return dead_letter(
                    repo, message, reason, team=request["team"], notify_bin=notify_bin,
                    agmsg_bin=agmsg_bin, request_id=request_id,
                    replacement_request_id=latest_request_id,
                )
            trusted_templates = templates_root.resolve()
            hash_error, hash_warning = helper_hash_status(
                repo, trusted_templates,
                ("ai-review-inbox.mjs", "ai-workflow-lib.mjs", "ai-e2e-lib.mjs")
            )
            if hash_warning:
                report(hash_warning)
            if hash_error:
                reason = f"cannot rebind superseded review: {hash_error}"
                report(reason)
                return dead_letter(
                    repo, message, reason, team=request["team"], notify_bin=notify_bin,
                    agmsg_bin=agmsg_bin, request_id=request_id,
                    replacement_request_id=latest_request_id,
                )
            inbox_helper = repo / "scripts" / "ai-review-inbox.mjs"
            try:
                completed = subprocess.run(
                    [node_bin, str(inbox_helper), "--request-id", latest_request_id],
                    cwd=repo,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=90,
                )
            except Exception as error:
                completed = None
                rebind_error = str(error)
            else:
                rebind_error = (
                    (completed.stderr or completed.stdout or "no diagnostic").strip()[:2_000]
                    if completed.returncode != 0 else ""
                )
            if completed is None or completed.returncode != 0:
                reason = f"superseded Request-ID inbox import failed: {rebind_error}"
                report(reason)
                return dead_letter(
                    repo, message, reason, team=request["team"], notify_bin=notify_bin,
                    agmsg_bin=agmsg_bin, request_id=request_id,
                    replacement_request_id=latest_request_id,
                )
            try:
                rebound_request = load_reviewer_request(
                    request_file, task, implementer_id, reviewer_id
                )
                if rebound_request["requestId"] != latest_request_id:
                    raise ValueError("reviewer-current-request.json still has the old Request-ID")
            except Exception as error:
                reason = f"superseded Request-ID import did not persist safely: {error}"
                report(reason)
                return dead_letter(
                    repo, message, reason, team=request["team"], notify_bin=notify_bin,
                    agmsg_bin=agmsg_bin, request_id=request_id,
                    replacement_request_id=latest_request_id,
                )
            rebound_from = request_id
            request = rebound_request
            request_id = latest_request_id
            report(f"REVIEW_REQUEST_ID_REBOUND: old={rebound_from} new={request_id}")
    # ai-review-reply.mjs rebuilds the Project/Repo/Branch/Task/Team/Request-ID header
    # itself from this same reviewer-current-request.json before it ever sends anything
    # (see its `body = ...` line), so the model's own text does not need to reproduce
    # those 6 lines verbatim for the reply to route correctly. Requiring an exact match
    # here used to dead-letter genuine, complete reviews whenever the model's formatting
    # drifted even slightly (observed 4-5x on 2026-08-08 alone) with no upstream benefit,
    # since the identity actually used downstream always comes from this trusted file.
    header_values = {
        "Project": request["project"],
        "Repo": request["repo"],
        "Branch": request["branch"],
        "Task": request["task"],
        "Team": request["team"],
        "Request-ID": request_id,
    }
    lines = message.splitlines()
    missing_headers = [key for key in HEADER_KEYS if f"{key}: {header_values[key]}" not in lines]
    if missing_headers:
        # The archive below is one-shot per (team, task, requestId): once written it is
        # immutable, and a later, genuinely final Stop event for the same Request-ID
        # would itself get dead-lettered as REVIEW_ARCHIVE_FAILED (content mismatch)
        # rather than overwrite it. Dropping the header requirement entirely would let
        # any incidental >=80-byte Stop event (an interim status update, a message from
        # a pane that gets re-kicked with the same Request-ID after going idle -- both
        # documented recovery patterns in this codebase) permanently capture that slot
        # ahead of the real review. Requiring the bare Request-ID value to appear
        # somewhere is a much lower bar than the 6-line block (fixing the reported
        # formatting-drift dead-letters) while still keeping that capture scenario
        # implausible, since an unrelated message is very unlikely to contain this
        # exact opaque token by chance.
        acceptable_ids = tuple(value for value in (request_id, rebound_from) if value)
        # Keep the legacy exact-ID guard for ordinary messages. The only extra shape
        # admitted is this task's approved target: a supported startup acknowledgement
        # immediately followed by a real Request-ID or verdict signal. An ordinary
        # verdict-only progress update still cannot reserve the one-shot archive.
        if not (
            mentions_acceptable_request_id(message, acceptable_ids)
            or is_startup_contract_review(message, acceptable_ids)
        ):
            reason = (
                "last_assistant_message is missing exact headers and does not even "
                f"mention Request-ID {request_id} anywhere; cannot confirm this is the "
                "final answer for this round"
            )
            report(reason)
            return dead_letter(
                repo,
                message,
                reason,
                team=request["team"],
                notify_bin=notify_bin,
                agmsg_bin=agmsg_bin,
                request_id=request_id,
            )
        report(
            "last_assistant_message is missing exact headers (auto-repaired from "
            f"reviewer-current-request.json before send): {', '.join(missing_headers)}"
        )

    if not has_review_verdict(lines):
        report(
            "REVIEW_VERDICT_WARNING: last_assistant_message is missing a machine-readable "
            "Verdict: ok|findings line; reply will still be archived and sent"
        )

    try:
        archive_path, replaced_startup_ack = persist_final_message(
            repo, request["team"], request["task"], request_id, message
        )
    except Exception as error:
        reason = f"REVIEW_ARCHIVE_FAILED: {error}; reply not sent"
        report(reason)
        return dead_letter(
            repo,
            message,
            reason,
            team=request["team"],
            notify_bin=notify_bin,
            agmsg_bin=agmsg_bin,
            request_id=request_id,
        )
    report(f"REVIEW_ARCHIVED: {archive_path}")
    try:
        recovery_pending = replaced_startup_ack or startup_recovery_pending(
            repo, request_id, archive_path.name
        )
        recovery_action = (
            prepare_startup_retry_state(repo, request_id, message)
            if recovery_pending else "none"
        )
    except Exception as error:
        reason = f"startup acknowledgement recovery failed: {error}"
        report(reason)
        return dead_letter(
            repo, message, reason, team=request["team"], notify_bin=notify_bin,
            agmsg_bin=agmsg_bin, request_id=request_id,
        )
    if recovery_action == "delivered":
        clear_startup_recovery(repo, request_id)
        report(f"REVIEW_REPLY_ALREADY_ACCEPTED: Request-ID={request_id}; prior resend completed")
        return 0
    if recovery_pending:
        retry_replaced_startup_ack = True
        report(
            f"REVIEWER_STARTUP_ACK_ARCHIVE_REPLACED: Request-ID={request_id}; "
            "resending genuine review"
        )

    full_message = message
    if len(encoded) > MAX_MESSAGE_BYTES:
        # The archive keeps the complete answer. Only the agmsg reply is safely truncated.
        message = truncate_utf8(message)
        report(f"last_assistant_message exceeded {MAX_MESSAGE_BYTES} bytes; truncated safely")

    templates_root = templates_root.resolve()
    hash_error, hash_warning = helper_hash_status(
        repo, templates_root, CORE_REQUIRED_HELPERS, EXTENDED_REQUIRED_HELPERS
    )
    if hash_warning:
        report(hash_warning)
    if hash_error:
        reason = hash_error
        report(reason)
        return dead_letter(
            repo, full_message, reason, team=request["team"], notify_bin=notify_bin,
            agmsg_bin=agmsg_bin, request_id=request_id,
        )

    helper = repo / "scripts" / "ai-review-reply.mjs"
    try:
        helper_args = [node_bin, str(helper), "--message", message, "--yes"]
        if retry_replaced_startup_ack:
            helper_args.extend(["--request-id", request_id])
            reply_state = repo / ".ai" / "context" / f"reviewer-reply-{request_id}.json"
            if regular_non_symlink(reply_state):
                helper_args.append("--retry")
        completed = subprocess.run(
            helper_args,
            cwd=repo,
            check=False,
            capture_output=True,
            text=True,
            timeout=90,
        )
    except Exception as error:
        reason = f"reply execution failed: {error}"
        report(reason)
        return dead_letter(
            repo, full_message, reason, team=request["team"], notify_bin=notify_bin,
            agmsg_bin=agmsg_bin, request_id=request_id,
        )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "no diagnostic").strip()[:2_000]
        reason = f"reply helper failed status={completed.returncode}: {detail}"
        report(reason)
        return dead_letter(
            repo, full_message, reason, team=request["team"], notify_bin=notify_bin,
            agmsg_bin=agmsg_bin, request_id=request_id,
        )
    if retry_replaced_startup_ack:
        try:
            clear_startup_recovery(repo, request_id)
        except Exception as error:
            report(f"REVIEWER_STARTUP_ACK_RECOVERY_CLEANUP_WARNING: {error}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
