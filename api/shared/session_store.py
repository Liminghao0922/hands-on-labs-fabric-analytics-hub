"""Concurrent session control backed by Azure Cosmos DB for NoSQL.

Design (see SESSION_CONTROL.md for details):

- The container holds one "slot" document per allowed concurrent session
  (slot-0000 ... slot-{max-1}). Slots are created lazily on first use.
- A slot is free when its ``expiresAt`` (UNIX seconds) is in the past.
- A free slot is claimed with an ETag-conditional patch, so two concurrent
  requests can never claim the same slot, even when the Function App scales
  out to several instances.
- Heartbeat / release use a conditional patch with a filter predicate
  (``c.sessionKey = '<key>'``), so a session can only extend or release a slot
  it still owns. One round trip per call.

All tunables are read from application settings at call time, so TTL,
heartbeat interval and the maximum number of sessions can be changed from the
Function App configuration without redeploying the frontend.
"""

import hashlib
import logging
import os
import random
import re
import threading
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

SLOT_ID_PATTERN = re.compile(r"^slot-\d{4}$")
BROWSER_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{8,64}$")

# Number of free-slot candidates fetched per query, and how many query rounds
# are attempted before reporting that the limit is reached.
_CANDIDATES_PER_QUERY = 10
_CLAIM_ROUNDS = 3


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Invalid integer for %s=%r. Using default %s.", name, raw, default)
        return default
    if value < minimum or value > maximum:
        clamped = min(max(value, minimum), maximum)
        logger.warning("%s=%s is out of range [%s, %s]. Using %s.", name, value, minimum, maximum, clamped)
        return clamped
    return value


@dataclass(frozen=True)
class SessionConfig:
    enabled: bool
    company_id: str
    max_sessions: int
    ttl_seconds: int
    heartbeat_interval_seconds: int
    count_mode: str  # "browser" or "user"
    release_on_close: bool
    enforce_on_api: bool
    cosmos_endpoint: Optional[str]
    cosmos_key: Optional[str]
    cosmos_database: str
    cosmos_container: str
    heartbeat_mode: str = "activity"
    activity_check_seconds: int = 600
    idle_timeout_seconds: int = 600
    warning_seconds: int = 60
    api_extends_session: bool = False
    fail_open: bool = False
    renewal_margin_seconds: int = 120

    def to_client_dict(self) -> dict:
        """Values the browser needs. Returned by acquire/heartbeat responses."""
        return {
            "enabled": self.enabled,
            "maxSessions": self.max_sessions,
            "ttlSeconds": self.ttl_seconds,
            "heartbeatIntervalSeconds": self.heartbeat_interval_seconds,
            "releaseOnClose": self.release_on_close,
            "countMode": self.count_mode,
            "heartbeatMode": self.heartbeat_mode,
            "activityCheckSeconds": self.activity_check_seconds,
            "idleTimeoutSeconds": self.idle_timeout_seconds,
            "warningSeconds": self.warning_seconds,
            "renewalMarginSeconds": self.renewal_margin_seconds,
        }


def load_session_config() -> SessionConfig:
    mode = (os.getenv("SESSION_HEARTBEAT_MODE") or "activity").strip().lower()
    if mode not in ("activity", "interval"):
        logger.warning("Invalid SESSION_HEARTBEAT_MODE=%r. Using 'activity'.", mode)
        mode = "activity"
    activity_check = _env_int("SESSION_ACTIVITY_CHECK_SECONDS", 600, 60, 3600)
    idle_timeout = _env_int("SESSION_IDLE_TIMEOUT_SECONDS", 600, 60, 86400)
    warning = _env_int("SESSION_WARNING_SECONDS", 60, 10, 600)
    renewal_margin = _env_int("SESSION_RENEWAL_MARGIN_SECONDS", 120, 30, 3600)
    heartbeat = _env_int("SESSION_HEARTBEAT_INTERVAL_SECONDS", 300, 15, 3600)
    ttl = _env_int("SESSION_TTL_SECONDS", 900, 60, 86400)
    if mode == "activity":
        if renewal_margin < warning + 60:
            adjusted = warning + 60
            logger.warning(
                "SESSION_RENEWAL_MARGIN_SECONDS=%s is below warning period + 60s. Using %s.",
                renewal_margin, adjusted,
            )
            renewal_margin = adjusted
        minimum = renewal_margin + 60
        if ttl < minimum:
            logger.warning("SESSION_TTL_SECONDS=%s is below the activity-mode minimum. Using %s.", ttl, minimum)
            ttl = minimum
    elif ttl < heartbeat * 2:
        # A TTL shorter than two heartbeats would expire healthy sessions when a
        # single heartbeat is delayed (for example by browser timer throttling).
        adjusted = heartbeat * 3
        logger.warning(
            "SESSION_TTL_SECONDS=%s is shorter than 2 x SESSION_HEARTBEAT_INTERVAL_SECONDS=%s. Using %s.",
            ttl,
            heartbeat,
            adjusted,
        )
        ttl = adjusted

    count_mode = (os.getenv("SESSION_COUNT_MODE") or "browser").strip().lower()
    if count_mode not in ("browser", "user"):
        logger.warning("Invalid SESSION_COUNT_MODE=%r. Using 'browser'.", count_mode)
        count_mode = "browser"

    company_id = (os.getenv("SESSION_COMPANY_ID") or "default").strip()
    if not re.match(r"^[A-Za-z0-9_-]{1,64}$", company_id):
        raise ValueError("SESSION_COMPANY_ID must be 1-64 characters of letters, digits, '-' or '_'.")

    return SessionConfig(
        enabled=_env_bool("SESSION_CONTROL_ENABLED", False),
        company_id=company_id,
        max_sessions=_env_int("SESSION_MAX_COUNT", 30, 1, 9999),
        ttl_seconds=ttl,
        heartbeat_interval_seconds=heartbeat,
        count_mode=count_mode,
        release_on_close=_env_bool("SESSION_RELEASE_ON_CLOSE", True),
        enforce_on_api=_env_bool("SESSION_ENFORCE_ON_API", True),
        cosmos_endpoint=os.getenv("COSMOS_ENDPOINT"),
        cosmos_key=os.getenv("COSMOS_KEY") or None,
        cosmos_database=os.getenv("COSMOS_DATABASE") or "sessiondb",
        cosmos_container=os.getenv("COSMOS_CONTAINER") or "sessions",
        heartbeat_mode=mode,
        activity_check_seconds=activity_check,
        idle_timeout_seconds=idle_timeout,
        warning_seconds=warning,
        api_extends_session=_env_bool("SESSION_API_EXTEND", False),
        fail_open=_env_bool("SESSION_FAIL_OPEN", False),
        renewal_margin_seconds=renewal_margin,
    )


def make_session_key(config: SessionConfig, user_upn: str, browser_id: Optional[str]) -> str:
    """Return the value that identifies one counted session.

    The key is a SHA-256 hex digest, so it is safe to embed in a Cosmos DB
    filter predicate and does not expose the browser ID in the database.
    In "browser" mode the key also includes the user, so one user's browser ID
    cannot be used to extend or release another user's session.
    """
    user = (user_upn or "").strip().lower()
    if not user:
        raise InvalidSessionRequest("Missing user identity.")
    if config.count_mode == "user":
        raw = f"user|{user}"
    else:
        if not isinstance(browser_id, str) or not BROWSER_ID_PATTERN.fullmatch(browser_id):
            raise InvalidSessionRequest("Missing or invalid browserId.")
        raw = f"browser|{user}|{browser_id}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class SessionError(Exception):
    pass


class InvalidSessionRequest(SessionError):
    pass


class SessionLimitReached(SessionError):
    pass


@dataclass
class SlotRef:
    id: str
    etag: Optional[str] = None
    expires_at: int = 0


@dataclass
class SessionGrant:
    slot_id: str
    expires_at: int


# ---------------------------------------------------------------------------
# Data access
# ---------------------------------------------------------------------------


def _status_code(exc: Exception) -> Optional[int]:
    return getattr(exc, "status_code", None)


class CosmosSlotRepository:
    """Thin data-access layer over one Cosmos DB container (partition key /companyId)."""

    def __init__(self, container, company_id: str):
        self._container = container
        self._pk = company_id

    def _query(self, query: str, parameters: List[dict]) -> list:
        return list(
            self._container.query_items(
                query=query,
                parameters=parameters,
                partition_key=self._pk,
            )
        )

    def read_slot(self, slot_id: str) -> Optional[dict]:
        try:
            return self._container.read_item(item=slot_id, partition_key=self._pk)
        except Exception as exc:
            if _status_code(exc) == 404:
                return None
            raise

    def find_slot_by_key(self, session_key: str, max_sessions: int) -> Optional[SlotRef]:
        rows = self._query(
            "SELECT TOP 1 c.id, c._etag, c.expiresAt FROM c "
            "WHERE c.type = 'slot' AND c.sessionKey = @key AND c.slotNo < @max",
            [{"name": "@key", "value": session_key}, {"name": "@max", "value": max_sessions}],
        )
        if not rows:
            return None
        row = rows[0]
        return SlotRef(id=row["id"], etag=row.get("_etag"), expires_at=int(row.get("expiresAt") or 0))

    def find_free_slots(self, now: int, max_sessions: int, limit: int) -> List[SlotRef]:
        rows = self._query(
            f"SELECT TOP {int(limit)} c.id, c._etag FROM c "
            "WHERE c.type = 'slot' AND c.slotNo < @max AND c.expiresAt <= @now",
            [{"name": "@max", "value": max_sessions}, {"name": "@now", "value": now}],
        )
        return [SlotRef(id=row["id"], etag=row.get("_etag")) for row in rows]

    def count_active(self, now: int, max_sessions: int) -> int:
        rows = self._query(
            "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'slot' AND c.slotNo < @max AND c.expiresAt > @now",
            [{"name": "@max", "value": max_sessions}, {"name": "@now", "value": now}],
        )
        return int(rows[0]) if rows else 0

    def count_slots(self, max_sessions: int) -> int:
        rows = self._query(
            "SELECT VALUE COUNT(1) FROM c WHERE c.type = 'slot' AND c.slotNo < @max",
            [{"name": "@max", "value": max_sessions}],
        )
        return int(rows[0]) if rows else 0

    def existing_slot_numbers(self) -> set:
        rows = self._query("SELECT VALUE c.slotNo FROM c WHERE c.type = 'slot'", [])
        return {int(n) for n in rows}

    def create_slot(self, slot_no: int) -> None:
        body = {
            "id": f"slot-{slot_no:04d}",
            "companyId": self._pk,
            "type": "slot",
            "slotNo": slot_no,
            "sessionKey": None,
            "userId": None,
            "acquiredAt": 0,
            "expiresAt": 0,
            "lastSeenAt": 0,
        }
        try:
            self._container.create_item(body=body)
        except Exception as exc:  # 409 = created concurrently by another request
            if _status_code(exc) != 409:
                raise

    def claim(self, slot: SlotRef, fields: Dict[str, object]) -> bool:
        """Set fields only if the slot is unchanged since it was read (ETag check)."""
        from azure.core import MatchConditions

        try:
            self._container.patch_item(
                item=slot.id,
                partition_key=self._pk,
                patch_operations=[{"op": "set", "path": f"/{k}", "value": v} for k, v in fields.items()],
                etag=slot.etag,
                match_condition=MatchConditions.IfNotModified,
            )
            return True
        except Exception as exc:
            if _status_code(exc) in (404, 412):
                return False
            raise

    def update_if_owner(
        self,
        slot_id: str,
        session_key: str,
        fields: Dict[str, object],
        max_sessions: Optional[int] = None,
    ) -> bool:
        """Set fields only if the slot is still owned by session_key (one round trip)."""
        predicate = f"FROM c WHERE c.sessionKey = '{session_key}'"
        if max_sessions is not None:
            predicate += f" AND c.slotNo < {int(max_sessions)}"
        try:
            self._container.patch_item(
                item=slot_id,
                partition_key=self._pk,
                patch_operations=[{"op": "set", "path": f"/{k}", "value": v} for k, v in fields.items()],
                filter_predicate=predicate,
            )
            return True
        except Exception as exc:
            if _status_code(exc) in (404, 412):
                return False
            raise


_client_lock = threading.Lock()
_container_cache: Dict[tuple, object] = {}


def _get_cosmos_container(config: SessionConfig):
    """Create the Cosmos client once per process and reuse it across invocations."""
    if not config.cosmos_endpoint:
        raise SessionError("COSMOS_ENDPOINT is not configured.")

    cache_key = (config.cosmos_endpoint, config.cosmos_database, config.cosmos_container, bool(config.cosmos_key))
    container = _container_cache.get(cache_key)
    if container is not None:
        return container

    with _client_lock:
        container = _container_cache.get(cache_key)
        if container is None:
            from azure.cosmos import CosmosClient

            if config.cosmos_key:
                # Local development only (for example with the Cosmos DB emulator).
                client = CosmosClient(config.cosmos_endpoint, credential=config.cosmos_key)
            else:
                from azure.identity import DefaultAzureCredential

                client = CosmosClient(config.cosmos_endpoint, credential=DefaultAzureCredential())
            container = client.get_database_client(config.cosmos_database).get_container_client(
                config.cosmos_container
            )
            _container_cache[cache_key] = container
    return container


# ---------------------------------------------------------------------------
# Session logic
# ---------------------------------------------------------------------------


class SessionStore:
    def __init__(self, config: SessionConfig, repository, clock: Callable[[], float] = time.time):
        self.config = config
        self._repo = repository
        self._clock = clock

    def _now(self) -> int:
        return int(self._clock())

    def _ensure_slots(self) -> None:
        existing = self._repo.existing_slot_numbers()
        for slot_no in range(self.config.max_sessions):
            if slot_no not in existing:
                self._repo.create_slot(slot_no)

    def acquire(self, session_key: str, user_upn: str) -> SessionGrant:
        cfg = self.config
        now = self._now()
        expires_at = now + cfg.ttl_seconds

        # 1) Idempotency: the same browser/user already holds a slot
        #    (page reload, retry after a timeout, second tab, resume from sleep).
        mine = self._repo.find_slot_by_key(session_key, cfg.max_sessions)
        if mine and self._repo.update_if_owner(
            mine.id, session_key, {"expiresAt": expires_at, "lastSeenAt": now}, cfg.max_sessions
        ):
            return SessionGrant(slot_id=mine.id, expires_at=expires_at)

        # 2) Claim a free slot. ETag check guarantees one owner per slot.
        fields = {
            "sessionKey": session_key,
            "userId": user_upn,
            "acquiredAt": now,
            "expiresAt": expires_at,
            "lastSeenAt": now,
        }
        provisioned = False
        for _ in range(_CLAIM_ROUNDS):
            candidates = self._repo.find_free_slots(now, cfg.max_sessions, _CANDIDATES_PER_QUERY)
            if not candidates:
                if not provisioned and self._repo.count_slots(cfg.max_sessions) < cfg.max_sessions:
                    self._ensure_slots()
                    provisioned = True
                    continue
                break
            random.shuffle(candidates)  # spread concurrent requests over different slots
            for slot in candidates:
                if self._repo.claim(slot, fields):
                    logger.info("Session acquired company=%s slot=%s", cfg.company_id, slot.id)
                    return SessionGrant(slot_id=slot.id, expires_at=expires_at)

        logger.info("Session limit reached company=%s max=%s", cfg.company_id, cfg.max_sessions)
        raise SessionLimitReached(f"The maximum number of concurrent sessions ({cfg.max_sessions}) is in use.")

    def extend(self, slot_id: str, session_key: str) -> Optional[SessionGrant]:
        """Heartbeat. Returns None when the slot is no longer owned by this session."""
        if not slot_id or not SLOT_ID_PATTERN.match(slot_id):
            return None
        now = self._now()
        expires_at = now + self.config.ttl_seconds
        ok = self._repo.update_if_owner(
            slot_id,
            session_key,
            {"expiresAt": expires_at, "lastSeenAt": now},
            self.config.max_sessions,
        )
        return SessionGrant(slot_id=slot_id, expires_at=expires_at) if ok else None

    def validate(self, slot_id: str, session_key: str) -> Optional[SessionGrant]:
        """Check ownership and expiry with one point read and no writes."""
        if not isinstance(slot_id, str) or not SLOT_ID_PATTERN.fullmatch(slot_id):
            return None
        if int(slot_id[5:]) >= self.config.max_sessions:
            return None
        slot = self._repo.read_slot(slot_id)
        reason = None
        if slot is None:
            reason = "missing"
        elif slot["slotNo"] >= self.config.max_sessions:
            reason = "outside_limit"
        elif slot["sessionKey"] != session_key:
            reason = "owner_mismatch"
        elif slot["expiresAt"] <= self._now():
            reason = "expired"
        if reason:
            logger.warning(
                "Session validation rejected company=%s slot=%s reason=%s",
                self.config.company_id, slot_id, reason,
            )
            return None
        return SessionGrant(slot_id=slot_id, expires_at=slot["expiresAt"])

    def release(self, slot_id: Optional[str], session_key: str) -> bool:
        if slot_id and SLOT_ID_PATTERN.match(slot_id):
            target = slot_id
        else:
            mine = self._repo.find_slot_by_key(session_key, 9999)
            if not mine:
                return False
            target = mine.id
        released = self._repo.update_if_owner(
            target,
            session_key,
            {"sessionKey": None, "userId": None, "expiresAt": 0},
        )
        if released:
            logger.info("Session released company=%s slot=%s", self.config.company_id, target)
        return released

    def status(self) -> dict:
        return {
            **self.config.to_client_dict(),
            "activeSessions": self._repo.count_active(self._now(), self.config.max_sessions),
        }


def get_session_store(config: Optional[SessionConfig] = None) -> SessionStore:
    cfg = config or load_session_config()
    container = _get_cosmos_container(cfg)
    return SessionStore(cfg, CosmosSlotRepository(container, cfg.company_id))
