"""管理员发行的免码入口：随机令牌、服务端检查、事务内核销额度。"""
import datetime
import hashlib
from sqlalchemy import select, update
from .models import AccessLink

COOKIE_ACCESS = "dw_access"


def digest(token):
    return hashlib.sha256(str(token).encode()).hexdigest()


def valid(link):
    return bool(link and link.enabled and
                (not link.expires_at or link.expires_at > datetime.datetime.now()) and
                link.used < 1)


def lookup_link(s, token, lock=False):
    if not token or len(token) > 100:
        return None
    query = select(AccessLink).where(AccessLink.token_hash == digest(token))
    if lock:
        query = query.with_for_update()
    return s.scalars(query).first()


def request_grant(request):
    from .db import db_session
    with db_session() as s:
        link = lookup_link(s, request.cookies.get(COOKIE_ACCESS))
        if not valid(link):
            return None
        return {"id": link.id, "note": link.note or link.slug,
                "remaining": max(0, 1 - link.used)}


def consume_grant(s, token):
    link = lookup_link(s, token, lock=True)
    if not valid(link):
        return None
    result = s.execute(update(AccessLink).where(
        AccessLink.id == link.id, AccessLink.enabled.is_(True),
        AccessLink.used == link.used
    ).values(used=link.used + 1), execution_options={"synchronize_session": False})
    return link.id if result.rowcount == 1 else None
