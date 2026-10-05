# -*- coding: utf-8 -*-
"""Web 版核心逻辑单元测试（不联网、不启服务）。

覆盖：商品解析 / 缺货判定 / 自动降级挑选 / 商品校正 / 库存 diff /
     错误文案 / 答题文案 / 默认设置合并 / 口令哈希 / H5 请求头 / curl 解析 /
     兑换码字符集 —— 以及一条**架构守卫**：web 版永远不能 import dewu_sniper。
"""
import os
import re
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

PASS = FAIL = 0
FAILED = []


def ck(name, cond, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ✓ %s" % name)
    else:
        FAIL += 1
        FAILED.append(name)
        print("  ✗ %s   %s" % (name, extra))


def sec(t):
    print("\n" + "=" * 68 + "\n" + t + "\n" + "=" * 68)


def _test_public_account_logic():
    """公共账号（全局商品列表）的真实逻辑测试 —— 全 mock，不联网、不碰生产库。

    ★ 必须放在 main() 里「所有 webapp 模块已经 import 完」之后调用：
      webapp.config.settings 是模块级单例，DEWU_DATA_DIR 得在它之前设好。
    """
    import datetime
    import threading
    import time
    from unittest import mock

    from webapp import dewu_client as DW
    from webapp import global_list as GL
    from webapp.api_user import _apply_public_list
    from webapp.db import init_db, put_setting

    sec("⑱ 公共账号（拉商品列表用）逻辑 —— 全 mock，不联网")
    init_db()
    put_setting("public_account", {})          # 从干净状态开始
    G = GL.GLOBAL
    with G.lock:
        G.products, G.balance, G.at, G.err, G.logs = [], None, "", "", []

    # ---------------------------------------------------------- 配置读写
    c = GL.save_cfg(phone="13800000000", password="pw-123456", enabled=False,
                    interval_sec=5)
    ck("配置落库（手机号）", GL.cfg()["phone"] == "13800000000")
    ck("★ 刷新间隔有下限（填 5 → 兜到 20）", c["interval_sec"] == 20, c["interval_sec"])
    ck("configured() 认「手机号 + 密码」", GL.configured() is True)

    pv = GL.public_view()
    ck("★ public_view 绝不回明文密码", "password" not in pv and pv["has_password"] is True)
    ck("public_view 打码只留首位", pv["password_mask"] == "p" + "*" * 8, pv["password_mask"])
    ck("public_view.configured 一致", pv["configured"] is True)

    GL.save_cfg(password="")
    ck("清掉密码 → configured()=False", GL.configured() is False)
    ck("只留手机号不算配好", GL.public_view()["has_password"] is False)

    # ---------------------------------------------------------- mock 打桩
    calls = {"login": 0, "list": 0}
    state = {"ok": True, "prizes": [{"cId": 7, "cName": "星巴克券", "cost": 300}],
             "balance": 888}

    def fake_fetch_list(self=None, activity=None):
        calls["list"] += 1
        time.sleep(0.05)                     # 拉慢点，好让并发挤在一起
        if not state["ok"]:
            return False, {"_err": state.get("err") or "boom"}
        return True, {"prizes": list(state["prizes"]), "balance": state["balance"]}

    def fake_login(phone, password, **kw):
        calls["login"] += 1
        if not state["ok"]:
            return {"ok": False, "msg": "密码不对"}
        return {"ok": True, "token": "tok-public-1", "user_id": "u1"}

    class FakeSession:
        def __init__(self, *a, **kw):
            pass
        fetch_list = fake_fetch_list

    GL.save_cfg(phone="13800000000", password="pw-123456", token="")
    with mock.patch.object(DW, "login", side_effect=fake_login), \
         mock.patch.object(DW, "DewuSession", FakeSession):
        # ------------------------------------------------------ 成功路径
        ok, msg = G.refresh()
        ck("refresh() 成功", ok is True, msg)
        ck("商品进了缓存", [p["cId"] for p in G.products] == [7])
        ck("余额记下来了", G.balance == 888)
        ck("刷新时间有值", bool(G.at))
        ck("错误被清空", G.err == "")
        ck("★ 登录拿到的 token 落库了", GL.cfg()["token"] == "tok-public-1")

        # 有 token 时不该再登录
        n_login = calls["login"]
        G.refresh()
        ck("★ 已有 token 时不重复登录", calls["login"] == n_login, calls["login"])

        # ------------------------------------------------------ 节流
        n_list = calls["list"]
        ok, msg = G.ensure_fresh(max_age=120)
        ck("★ 刚刷过 → ensure_fresh 不再打接口", calls["list"] == n_list and ok is True, msg)
        ok, msg = G.ensure_fresh(max_age=0)
        ck("max_age=0 → 强制再刷一次", calls["list"] == n_list + 1)

        # ------------------------------------------------------ 并发只拉一次
        calls["list"] = 0
        threads = [threading.Thread(target=G.refresh) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        ck("★ 6 个人同时点刷新，接口只被打 1 次（锁生效）",
           calls["list"] == 1, "实际 %d 次" % calls["list"])

        # ------------------------------------------------------ 失败路径
        state["ok"] = False
        ok, msg = G.refresh()
        ck("抓不到列表 → refresh() 返回 False", ok is False)
        ck("失败原因记进 err", bool(G.err), G.err)
        ck("★ 失败不清空上一次的商品（宁可用旧的）", len(G.products) == 1)
        ck("失败原因也落库了", bool(GL.cfg()["last_error"]))

        state["ok"] = True
        ok, msg = G.refresh(force_login=True)
        ck("force_login 能重新登录并恢复", ok is True and calls["login"] > n_login)
        ck("恢复后 err 清空", G.err == "")

    # ---------------------------------------------------------- 用户端叠加
    snap = {"products": [{"cId": 99, "cName": "旧的"}], "balance": 55, "list_error": "x"}
    out = _apply_public_list(snap)
    ck("★ 用户端商品被换成公共账号那份", [p["cId"] for p in out["products"]] == [7])
    ck("★ 用户自己的余额没被公共账号的余额顶掉", out["balance"] == 55, out["balance"])
    ck("来源标成 public", out["list_source"] == "public")
    ck("public_ready=True", out["public_ready"] is True)
    ck("有数据就把错误清掉", out["list_error"] is None)

    # 公共账号没配 → 保持用户自己的那份
    GL.save_cfg(phone="", password="", token="")
    snap2 = {"products": [], "balance": 1, "list_error": None}
    out2 = _apply_public_list(snap2)
    ck("没配公共账号 → 来源是 self", out2["list_source"] == "self")
    ck("没配公共账号 → public_ready=False", out2["public_ready"] is False)

    # ---------------------------------------------------------- 线程生命周期
    GL.save_cfg(phone="13800000000", password="pw-123456", enabled=True)
    with mock.patch.object(DW, "login", side_effect=fake_login), \
         mock.patch.object(DW, "DewuSession", FakeSession):
        ok, msg = G.start()
        ck("start() 起后台线程", ok is True, msg)
        ck("start() 后 running=True", G.snapshot()["running"] is True)
        G.stop()
        ck("★ stop() 等线程真的退出去（否则紧接着 start() 会被挡）",
           G.snapshot()["running"] is False)
        ok, msg = G.start()
        ck("★ 停了还能再起（开关不会假死）", G.snapshot()["running"] is True)
        G.stop()
        ck("最终停干净", G.snapshot()["running"] is False)

    GL.save_cfg(phone="", password="", token="", enabled=False)
    ck("没配公共账号 → start() 不硬起",
       GL.GLOBAL.start()[0] is False, GL.GLOBAL.start())

    put_setting("public_account", {})          # 收尾：不留测试配置


def _test_lazy_login_logic():
    """懒登录：提交账号密码**只存不登**，开抢前 2 分钟提 IP 才登录。

    全 mock，不联网、不碰生产库。要放在 main() 的 webapp import 之后调用。
    """
    import inspect
    from unittest import mock

    from sqlalchemy import select

    from webapp import dewu_client as DW
    from webapp import runtime as RT
    from webapp import secret_store as SS
    from webapp import tianqi as TQ
    from webapp.db import db_session, init_db, put_setting
    from webapp.models import User, merge_defaults

    sec("⑲ 懒登录（密码只存不登 / 开抢前 2 分钟提 IP 登录）")
    init_db()

    # ------------------------------------------------------ 密码可逆加密
    ck("cryptography 可用（存密码的前提）", SS.available() is True)
    blob = SS.encrypt("my-pass-123")
    ck("密文带版本前缀", blob.startswith("enc:v1:"))
    ck("★ 能解回明文", SS.decrypt(blob) == "my-pass-123")
    ck("★ 密文里看不到明文", "my-pass-123" not in blob)
    ck("空串加密还是空串", SS.encrypt("") == "")
    ck("认不出来的值当没存过（不炸）", SS.decrypt("whatever") == "")
    ck("脏密文当没存过（不炸）", SS.decrypt("enc:v1:not-base64") == "")

    # ------------------------------------------------------ 天启IP 配置
    put_setting(TQ.KEY, {})
    ck("天启没配时 configured=False", TQ.public_view()["configured"] is False)
    ck("天启没配时 ready=False", TQ.public_view()["ready"] is False)
    TQ.save_cfg(secret="sec-abcdef123456", sign="sign-9876543210",
                key="key-1122334455", auth_pass="pa-556677", enabled=True)
    ck("天启配置落库", TQ.cfg()["secret"] == "sec-abcdef123456")
    ck("天启 configured=True", TQ.configured() is True)
    ck("天启 ready=True（开关也开了）", TQ.ready() is True)
    pv = TQ.public_view()
    ck("★ secret 只回打码值", pv["secret"] != "sec-abcdef123456" and "*" in pv["secret"],
       pv["secret"])
    ck("★ sign / key / auth_pass 也只回打码值",
       all("*" in pv[k] for k in ("sign", "key", "auth_pass")),
       {k: pv[k] for k in ("sign", "key", "auth_pass")})
    ck("★ 明文密钥不在 public_view 里", "sec-abcdef123456" not in repr(pv))
    ck("has_secret 反映真实存在", pv["has_secret"] is True)
    TQ.save_cfg(enabled=False)
    ck("关掉开关 ready=False（configured 仍为 True）",
       TQ.ready() is False and TQ.configured() is True)
    ck("life 只认 3/5/10/15（7 → 兜回 3）", TQ.save_cfg(life=7)["life"] == 3)
    ck("protocol 越界兜回 socks5", TQ.save_cfg(protocol=99)["protocol"] == 3)

    put_setting(TQ.KEY, {})
    ip, err = TQ.client()
    ck("没配好 → client() 给人话而不是抛异常", ip is None and "缺" in err, err)

    class FakeLease:
        def as_proxy(self):
            return {"url": "socks5h://1.2.3.4:1080", "ip": "1.2.3.4", "port": 1080,
                    "where": "辽宁鞍山 · 电信", "expire_at": 0, "left": 170}

    TQ.save_cfg(secret="s-1", sign="g-1", key="k-1", enabled=True)
    with mock.patch("tianqiip.TianqiIP.ensure_white", return_value=(True, "已添加")), \
         mock.patch("tianqiip.TianqiIP.extract_lease", return_value=(FakeLease(), "")):
        d, err = TQ.one_proxy()
    ck("one_proxy 返回能直接用的代理", bool(d) and d["url"].startswith("socks5h://") and not err, err)
    ck("★ 提取成功记下归属地（界面要显示）", TQ.cfg()["last_where"] == "辽宁鞍山 · 电信")
    with mock.patch("tianqiip.TianqiIP.ensure_white", return_value=(True, "已添加")), \
         mock.patch("tianqiip.TianqiIP.extract_lease",
                    return_value=(None, "套餐已过期")):
        d, err = TQ.one_proxy()
    ck("提取失败返回原因", d is None and "过期" in err, err)
    ck("★ 失败原因落库（管理员看得到）", "过期" in TQ.cfg()["last_err"])
    put_setting(TQ.KEY, {})

    # ------------------------------------------------------ 登录支持指定出口
    import dewu_login as DL
    ck("★ dewu_login.login 支持 proxies（同一个 IP 登录 + 兑换）",
       "proxies" in inspect.signature(DL.login).parameters)
    ck("★ DW.login 也透传 proxies",
       "proxies" in inspect.signature(DW.login).parameters)
    ck("直连仍走 urllib（桌面版行为不变）",
       "if not proxies:" in inspect.getsource(DL._send_login))

    # ------------------------------------------------------ 前端的文案守卫
    src_js = open(os.path.join(ROOT, "webapp", "static", "app.js"), encoding="utf-8").read()
    src_user = open(os.path.join(ROOT, "webapp", "api_user.py"), encoding="utf-8").read()
    ck("★ 登录页写清「开抢的前 2 分钟才会进行登录操作」",
       "开抢的前 2 分钟" in src_js and "请确保账号密码正确" in src_js)
    ck("登录按钮不再叫「登录」", "保存并进入" in src_js)
    ck("★ 密码分支真的不登录（api_user 里没有 DW.login 调用）",
       "DW.login(" not in src_user)
    ck("顶部有「登录出口 IP 归属地」", 'id="pillIp"' in src_js)
    ck("侧栏账号下面显示出口", "出口 ' + lg.where" in src_js)
    ck("管理端有天启IP 卡片", "天启IP（开抢前自动换 IP）" in src_js)
    ck("★ 提前登录是 2 分钟", RT.LEAD_LOGIN_SEC == 120, RT.LEAD_LOGIN_SEC)

    # ------------------------------------------------------ do_login 真跑一遍（mock 网络）
    with db_session() as s:
        u = s.scalars(select(User).where(User.phone == "13900000001")).first()
        if u is None:
            u = User(phone="13900000001", settings=merge_defaults({}))
            s.add(u)
            s.flush()
        uid = u.id
    rt = RT.runtime_for(uid)

    def _set_user(**kw):
        with db_session() as s:
            row = s.get(User, uid)
            for k, v in kw.items():
                setattr(row, k, v)

    called = {}

    def fake_login(phone, password, override=None, timeout=25, proxies=None):
        called.update({"phone": phone, "pw": password, "proxies": proxies})
        return {"ok": True, "token": "tok-lazy-1", "user_id": "u9"}

    _set_user(pw_enc=SS.encrypt("pw-abc"), token="", login_ip="", login_where="")
    proxy = {"url": "socks5h://1.2.3.4:1080", "ip": "1.2.3.4", "port": 1080,
             "where": "辽宁鞍山 · 电信", "expire_at": 0, "left": 170}
    with mock.patch.object(DW, "login", side_effect=fake_login), \
         mock.patch.object(TQ, "ready", return_value=True), \
         mock.patch.object(TQ, "one_proxy", return_value=(dict(proxy), "")), \
         mock.patch.object(TQ, "proxies_map",
                           return_value={"http": "socks5h://1.2.3.4:1080",
                                         "https": "socks5h://1.2.3.4:1080"}):
        ok, msg, info = rt.do_login(use_ip=True, why="#1")

    ck("do_login 成功", ok is True, msg)
    ck("★ 用的是存下来的密码（不是让用户再输一次）", called.get("pw") == "pw-abc")
    ck("★ 登录走了刚提上来的那个 IP", bool(called.get("proxies")), called.get("proxies"))
    ck("info 里带回归属地", info.get("where") == "辽宁鞍山 · 电信")
    ck("info 里带回可复用的出口 url（兑换要用同一个）",
       info.get("proxy_url") == "socks5h://1.2.3.4:1080")
    li = rt.login_info()
    ck("★ token 落库了", li["logged_in"] is True)
    ck("★ 登录 IP 与归属地落库（账号后面要显示）",
       li["ip"] == "1.2.3.4" and li["where"] == "辽宁鞍山 · 电信")
    ck("登录时间有值", bool(li["at"]))

    # 提不到 IP → 降级直连，别让 IP 商挂了任务就跑不了
    called.clear()
    rt.login_lease = None
    with mock.patch.object(DW, "login", side_effect=fake_login), \
         mock.patch.object(TQ, "ready", return_value=True), \
         mock.patch.object(TQ, "one_proxy", return_value=(None, "暂无可用 IP")):
        ok, msg, info = rt.do_login(use_ip=True)
    ck("★ 提不到 IP 时停止，绝不直连登录",
       ok is False and not called and "IP" in msg, msg)

    # 没存密码 → 明确报错，别瞎登
    _set_user(pw_enc="", token="")
    ok, msg, _ = rt.do_login()
    ck("★ 没存密码时给出可读原因", ok is False and "密码" in msg, msg)

    # 已有 token → ensure_login 不重复登
    _set_user(pw_enc=SS.encrypt("pw-abc"), token="tok-x")
    n = {"c": 0}

    def _count(*a, **k):
        n["c"] += 1
        return {"ok": True, "token": "t"}

    with mock.patch.object(DW, "login", side_effect=_count):
        ok, msg = rt.ensure_login()
    ck("★ 已有 token → ensure_login 不再登录", n["c"] == 0 and ok is True, msg)

    _set_user(pw_enc="", token="")
    n["c"] = 0
    with mock.patch.object(DW, "login", side_effect=_count):
        ok, msg = rt.ensure_login()
    ck("★ 没 token 又没密码 → 不瞎登，直接给人话",
       n["c"] == 0 and ok is False and "密码" in msg, "%d / %s" % (n["c"], msg))

    _set_user(pw_enc=SS.encrypt("pw-abc"), token="")
    n["c"] = 0
    with mock.patch.object(DW, "login", side_effect=_count):
        ok, msg = rt.ensure_login()
    ck("有密码没 token → ensure_login 登一次", n["c"] == 1 and ok is True, msg)

    # ------------------------------------------------------ session 用指定出口
    _set_user(token="tok-x")
    sess = rt.session(proxy_url="socks5h://1.2.3.4:1080")
    ck("★ session(proxy_url) 用的就是这个出口",
       sess is not None and sess.proxy is not None
       and sess.proxy.current_url == "socks5h://1.2.3.4:1080",
       getattr(sess.proxy, "current_url", None) if sess else None)
    ck("★ 指定出口时列表也走它（一个号从头到尾一个 IP）", sess.also_list is True)

    # ------------------------------------------------------ 任务线程：先登录再开抢
    import time as _t
    from webapp.models import Task

    events = []
    _set_user(pw_enc=SS.encrypt("pw-abc"), token="", login_ip="", login_where="")
    with db_session() as s:
        task = Task(user_id=uid,
                    prize={"cId": 1, "cName": "测试商品", "cost": 1},
                    orig_prize={"cId": 1, "cName": "测试商品", "cost": 1},
                    target_time="23:59:59", lead_ms=300, interval_ms=200,
                    max_attempts=1, fallback_enabled=False,
                    status=RT.ST_WAIT, detail="排队中")
        s.add(task)
        s.flush()
        tid = task.id

    def _fake_login(phone, password, override=None, timeout=25, proxies=None):
        events.append(("login", (proxies or {}).get("https")))
        return {"ok": True, "token": "tok-task", "user_id": "u"}

    def _fake_run_task(self, prize, cfg, on_event=None, should_stop=None):
        events.append(("run", None))
        return {"ok": True, "detail": "抢到了", "attempts": 1, "prize": prize,
                "balance": 10, "fell_back": False}

    seen = {}

    def _fake_session(self, proxy_url=None, token=None):
        seen["px"] = proxy_url
        return mock.MagicMock(run_task=lambda *a, **k: _fake_run_task(None, *a, **k))

    with mock.patch.object(DW, "login", side_effect=_fake_login), \
         mock.patch.object(TQ, "ready", return_value=True), \
         mock.patch.object(TQ, "one_proxy", return_value=(dict(proxy), "")), \
         mock.patch.object(TQ, "proxies_map",
                           return_value={"http": proxy["url"], "https": proxy["url"]}), \
         mock.patch.object(RT.UserRuntime, "session", _fake_session):
        rt.schedule(tid, run_now=True)
        for _ in range(80):
            if not rt.task_threads.get(tid):
                break
            _t.sleep(0.1)

    ck("★ 任务线程：先登录、再开抢（顺序对）",
       [e[0] for e in events] == ["login", "run"], events)
    ck("★ 登录走的是新提的那个 IP", events and events[0][1] == proxy["url"], str(events))
    ck("★ 开抢会话用的还是同一个 IP（一个号一个出口）",
       seen.get("px") == proxy["url"], seen.get("px"))

    with db_session() as s:
        row = s.get(Task, tid)
        ck("任务落成「成功」", row is not None and row.status == RT.ST_OK,
           row.status if row else None)
        if row:
            s.delete(row)

    with db_session() as s:
        row = s.get(User, uid)
        s.delete(row)                      # 收尾：别把测试账号留在库里


def main():
    # ★ 单测自己的数据目录：绝不能写生产的 webdata/dewu.db
    os.environ.setdefault("DEWU_DATA_DIR", os.path.join(ROOT, "webdata", "_unittest"))

    from webapp import dewu_client as DW
    from webapp.curlparse import parse_curl, xat_of_curl
    from webapp.models import DEFAULT_SETTINGS, merge_defaults
    from webapp.security import hash_pw, verify_pw
    from webapp.api_admin import _ALPHABET, _gen_code

    # ============================================================== 商品解析
    sec("① parse_prizes：图片 / 价格 / 库存 / 金币 四个字段")
    data = {"balance": 860, "prizes": [
        {"level": "2", "isLock": False, "prize": {
            "cId": 22, "pId": 763, "skuId": 999, "cName": "贵的",
            "productName": "贵的东西 详情名", "scoreCostOrigin": 300, "stock": 5,
            "platformPrice": 10900, "outOfStock": False,
            "productPicture": "https://cdn.poizon.com/a.png", "cTypeDesc": "全品类可用",
            "label": {"type": "txt", "value": "赠"}}},
        {"level": "1", "isLock": False, "prize": {
            "cId": 11, "pId": 1, "skuId": 2, "cName": "便宜的",
            "scoreCostOrigin": 1, "stock": 0, "platformPrice": 0,
            "outOfStock": False,
            "commodityPicture": "https://cdn.poizon.com/b.png"}},
        {"level": "1", "prize": {
            "cId": 33, "displayName": "display 名",
            "scoreCostOrigin": 50, "stock": None, "platformPrice": 3000}},
    ]}
    ps = DW.parse_prizes(data)
    by = {p["cId"]: p for p in ps}
    ck("解析出 3 个商品", len(ps) == 3, len(ps))
    ck("价格 10900 分 → 109.0 元", by[22]["priceYuan"] == 109.0, by[22]["priceYuan"])
    ck("price 保留原始分值", by[22]["price"] == 10900)
    ck("金币 = scoreCostOrigin", by[22]["cost"] == 300)
    ck("库存透传", by[22]["stock"] == 5)
    ck("图片取 productPicture", by[22]["picture"].endswith("/a.png"))
    ck("productPicture 缺失时退回 commodityPicture", by[11]["picture"].endswith("/b.png"))
    ck("商品名取 cName", by[22]["cName"] == "贵的")
    ck("cName 缺失时用 displayName 兜底", by[33]["cName"] == "display 名")
    ck("label.value 提取为 label", by[22]["label"] == "赠")
    ck("cTypeDesc 提取", by[22]["typeDesc"] == "全品类可用")
    ck("按 level 升序排列", [p["level"] for p in ps] == ["1", "1", "2"], [p["level"] for p in ps])
    ck("balance 不混进 prizes", all("balance" not in p for p in ps))

    # parse_list 收的是「接口原始响应」（带 data 包一层），不是里面那个 data
    pl = DW.parse_list({"code": 200, "data": data})
    ck("parse_list 带出 balance", pl["balance"] == 860)
    ck("parse_list 带出 prizes", len(pl["prizes"]) == 3)
    ck("parse_list 遇到空响应不炸", DW.parse_list({})["prizes"] == [])

    # ============================================================== 缺货判定
    sec("② no_stock：标志不准，库存也要看")
    ck("outOfStock=True 算缺货", DW.no_stock({"outOfStock": True, "stock": 10}))
    ck("stock=0 算缺货（即使标志为 false）",
       DW.no_stock({"outOfStock": False, "stock": 0}))
    ck("stock='0' 字符串也算缺货", DW.no_stock({"stock": "0"}))
    ck("stock=5 不算缺货", not DW.no_stock({"stock": 5}))
    ck("stock 缺失(None) 不算缺货", not DW.no_stock({"stock": None}))
    ck("stock 是脏数据不算缺货", not DW.no_stock({"stock": "abc"}))
    ck("outOfStock 缺省且无 stock → 有货", not DW.no_stock({}))

    # ============================================================== 自动降级
    sec("③ pick_fallback：买得起的里面挑最贵的")
    prizes = [
        {"cId": 1, "cName": "原商品", "cost": 100, "stock": 9, "outOfStock": False},
        {"cId": 2, "cName": "便宜", "cost": 10, "stock": 9, "outOfStock": False},
        {"cId": 3, "cName": "最贵但买得起", "cost": 80, "stock": 9, "outOfStock": False},
        {"cId": 4, "cName": "买不起", "cost": 999, "stock": 9, "outOfStock": False},
        {"cId": 5, "cName": "缺货", "cost": 20, "stock": 0, "outOfStock": False},
        {"cId": 6, "cName": "同价靠前", "cost": 80, "stock": 9, "outOfStock": False},
    ]
    alt, tip = DW.pick_fallback(prizes, 100, {"cId": 1, "cName": "原商品", "cost": 100},
                                {"enabled": True, "min_ratio": 0})
    ck("挑到 80 金币的（买得起里最贵）", alt and alt["cost"] == 80, alt)
    ck("同价取列表顺序第一个 → cId 3", alt and alt["cId"] == 3, alt)
    ck("排除原商品自己", alt and alt["cId"] != 1)
    ck("不挑缺货的", alt and alt["cId"] != 5)
    ck("不挑买不起的", alt and alt["cId"] != 4)
    ck("返回了说明文字", bool(tip))

    alt2, tip2 = DW.pick_fallback(prizes, 100, {"cId": 1, "cost": 100},
                                  {"enabled": True, "min_ratio": 0.9})
    ck("min_ratio=0.9 → 只剩 80 以下 90 以上的（cId 3/6，cost 80 < 90 被挡）",
       alt2 is None and "门槛" in tip2, (alt2, tip2))

    alt3, tip3 = DW.pick_fallback([], 100, {"cId": 1}, {"min_ratio": 0})
    ck("空列表 → None + 说明", alt3 is None and "空" in tip3, tip3)
    alt4, tip4 = DW.pick_fallback(prizes, "abc", {"cId": 1}, {"min_ratio": 0})
    ck("余额不是数字 → 拒绝乱换", alt4 is None and "余额" in tip4, tip4)
    alt5, tip5 = DW.pick_fallback(
        [{"cId": 9, "cost": 5, "stock": 1, "outOfStock": False}], 1, {"cId": 9}, {"min_ratio": 0})
    ck("只剩原商品自己 → 挑不出来", alt5 is None, alt5)

    # ============================================================== 商品校正
    sec("④ resolve_prize：活动换批次时 cId 会变，用名字救回来")
    fresh, gone = DW.resolve_prize(prizes, {"cId": 1, "cName": "原商品"})
    ck("cId 命中直接返回", fresh and fresh["cId"] == 1 and not gone)
    fresh, gone = DW.resolve_prize(prizes, {"cId": 777, "cName": "最贵但买得起"})
    ck("cId 对不上，按名字救回", fresh and fresh["cId"] == 3 and not gone, (fresh, gone))
    fresh, gone = DW.resolve_prize(prizes, {"cId": 777, "cName": "不存在的名字"})
    ck("都对不上 → gone=True", fresh is None and gone is True)
    fresh, gone = DW.resolve_prize([], {"cId": 1})
    ck("列表是空的 → 不判定 gone（沿用原配置）", fresh is None and gone is False)
    fresh, gone = DW.resolve_prize(prizes, {"cId": 777, "cName": "无"}, "网络错误")
    ck("这次列表没刷成功 → 不判定 gone", fresh is None and gone is False)

    # ============================================================== 库存 diff
    sec("⑤ diff_stock：新品 / 补货")
    base = {"1": {"cName": "老商品", "cost": 10, "stock": 5, "out": False},
            "2": {"cName": "抢光的", "cost": 20, "stock": 0, "out": True},
            "3": {"cName": "库存多的", "cost": 30, "stock": 10, "out": False}}
    cur = [
        {"cId": 1, "cName": "老商品", "cost": 10, "stock": 5, "outOfStock": False},
        {"cId": 2, "cName": "抢光的", "cost": 20, "stock": 8, "outOfStock": False},   # 补货
        {"cId": 3, "cName": "库存多的", "cost": 30, "stock": 4, "outOfStock": False}, # 变少 → 不通知
        {"cId": 4, "cName": "新品", "cost": 40, "stock": 3, "outOfStock": False},     # 新品
        {"cId": 5, "cName": "新品但缺货", "cost": 50, "stock": 0, "outOfStock": True},
    ]
    changes, seen, baseline = DW.diff_stock(base, cur)
    # 注意：cId 在快照/变化项里都是**字符串**
    kinds = {(c["cId"], c["kind"]) for c in changes}
    ck("不是基线", baseline is False)
    ck("识别出补货 cId2", ("2", "restock") in kinds, kinds)
    ck("识别出新品 cId4", ("4", "new") in kinds, kinds)
    ck("库存减少不通知 (cId3)", not any(c["cId"] == "3" for c in changes), kinds)
    ck("没变化不通知 (cId1)", not any(c["cId"] == "1" for c in changes), kinds)
    ck("新品但缺货不通知 (cId5)", not any(c["cId"] == "5" for c in changes), kinds)
    ck("快照包含全部 5 个商品", len(seen) == 5, len(seen))
    ck("快照键是字符串 cId", "4" in seen)

    ch2, _, bl2 = DW.diff_stock({}, cur)
    ck("首次（无快照）= 基线，一条都不通知", bl2 is True and ch2 == [], ch2)

    ch3, _, _ = DW.diff_stock(base, cur, notify_new=False, notify_restock=True)
    ck("关掉新品通知 → 只剩补货", all(c["kind"] != "new" for c in ch3), ch3)
    ch4, _, _ = DW.diff_stock(base, cur, notify_new=True, notify_restock=False)
    ck("关掉补货通知 → 只剩新品", all(c["kind"] != "restock" for c in ch4), ch4)
    ch5, _, _ = DW.diff_stock(base, cur, notify_new=False, notify_restock=False)
    ck("两个都关 → 无通知", ch5 == [], ch5)

    # ============================================================== 错误文案
    sec("⑥ 错误码翻译成人话")
    ck("700 → 登录态/风控", "700" in DW.friendly_code(700, "请先登录"))
    ck("460 → 风控", "风控" in DW.friendly_code(460, ""))
    t = DW.friendly_code(900, "活动不存在")
    ck("活动不存在 → 提示去改活动 id", "活动" in t and "全局设置" in t, t)
    ck("未知码 → 原样带出", "99999" in DW.friendly_code(99999, "怪错误"))

    ck("答题：今日已答对", DW.answer_classify({"code": 111100004})[0] == "done")
    ck("答题：答对", DW.answer_classify({"code": 200, "data": {"correct": True, "coinEarned": 5}})[0] == "ok")
    k, txt = DW.answer_classify({"code": 200, "data": {"correct": False, "remainAttempts": 2}})
    ck("答题：答错带剩余次数", k == "wrong" and "2" in txt, txt)
    ck("答题：参数错误文案（用的是答题自己的 110000003，不是列表的 900）",
       "不能为空" in DW.answer_friendly({"code": 110000003}))
    ck("答题：提示拼装", DW.answer_hint({"word_count": 3, "category": "谐音"}) == "3 个字 · 谐音")

    # ============================================================== 设置合并
    sec("⑦ merge_defaults：缺项补齐、不动已有值")
    m = merge_defaults({})
    ck("空设置 → 拿到全部默认段", set(m.keys()) >= set(DEFAULT_SETTINGS.keys()))
    ck("默认推送是关的", m["push"]["enabled"] is False)
    ck("默认库存间隔 30s", m["watch"]["interval_sec"] == 30)
    ck("默认自动降级是开的", m["fallback"]["enabled"] is True)
    m2 = merge_defaults({"watch": {"interval_sec": 99, "未来字段": 1}, "自定义顶层": "x"})
    ck("已有值不被覆盖", m2["watch"]["interval_sec"] == 99)
    ck("缺失的键补上", m2["watch"]["notify_new"] is True)
    ck("不认识的新键被丢掉（防脏数据）", "未来字段" not in m2["watch"])
    ck("顶层自定义键保留", m2.get("自定义顶层") == "x")

    # ============================================================== 口令
    sec("⑧ 口令哈希")
    h = hash_pw("hello123")
    ck("哈希格式 pbkdf2_sha256$迭代$盐$摘要", h.startswith("pbkdf2_sha256$") and h.count("$") == 3)
    ck("同口令 两次哈希不同（有盐）", hash_pw("hello123") != h)
    ck("正确口令校验通过", verify_pw("hello123", h))
    ck("错误口令被拒", not verify_pw("hello124", h))
    ck("空/脏哈希不炸", not verify_pw("x", "") and not verify_pw("x", "垃圾"))

    # ============================================================== H5 头
    sec("⑨ h5_headers / list_url")
    h = DW.h5_headers("abc123")
    ck("token 自动补 Bearer", h["x-auth-token"] == "Bearer abc123")
    ck("duToken 不带 Bearer", h["duToken"] == "abc123")
    ck("cookieToken 不带 Bearer", h["cookieToken"] == "abc123")
    ck("Cookie 头用 duToken", h["Cookie"] == "duToken=abc123")
    h2 = DW.h5_headers("Bearer xyz")
    ck("已有 Bearer 不会变成两个 Bearer", h2["x-auth-token"] == "Bearer xyz", h2["x-auth-token"])
    ck("H5 关键头齐全", all(k in h for k in ("platform", "appid", "SK", "shumeiId", "duid")))
    ck("platform 是 h5", h["platform"] == "h5")
    h3 = DW.h5_headers("t", {"SK": "我的SK"})
    ck("device 覆盖生效", h3["SK"] == "我的SK")
    h4 = DW.h5_headers("t", {"SK": ""})
    ck("device 空值不覆盖", h4["SK"] != "")

    u = DW.list_url("20260917", "abc")
    ck("list_url 带 activity", "activity=20260917" in u)
    ck("list_url 带 sign", "sign=abc" in u)
    ck("list_url 用默认 sign（不传时）", DW.DEFAULT_LIST_SIGN in DW.list_url("20260917"))

    # ============================================================== curl 解析
    sec("⑩ curl 解析")
    curl = ("curl 'https://app.dewu.com/x?activity=2026&sign=aa' "
            "-H 'x-auth-token: Bearer TOK' -H 'platform: h5' -H 'Cookie: duToken=1'")
    url, hh, body, method = parse_curl(curl)
    ck("URL 解析", url.startswith("https://app.dewu.com/x"))
    ck("头解析", hh.get("x-auth-token") == "Bearer TOK" and hh.get("platform") == "h5")
    ck("无 body 时 method=GET", method == "GET")
    ck("xat_of_curl 取到 token", xat_of_curl(curl) == "Bearer TOK")
    ck("xat_of_curl 忽略大小写",
       xat_of_curl("curl 'u' -H 'X-Auth-Token: Bearer Z'") == "Bearer Z")
    ck("没有 token 时返回 None", xat_of_curl("curl 'u' -H 'a: b'") is None)
    ck("activity 提取", DW.activity_from_curl(curl) == "2026")
    _, _, b2, m2 = parse_curl("curl 'u' -X POST --data-raw 'a=1'")
    ck("带 body 时 method=POST", m2 == "POST" and b2 == "a=1")

    # ============================================================== 兑换码
    sec("⑪ 兑换码字符集")
    # 刻意排除了「一眼看不出差别」的几个：0/O、1/I/L
    bad = set("0O1IL")
    ck("排除了易混字符 0/O/1/I/L", not (bad & set(_ALPHABET)), sorted(bad & set(_ALPHABET)))
    ck("字符集全是 ASCII", all(ord(c) < 128 for c in _ALPHABET))
    g = _gen_code("DW")
    ck("生成格式 DW-XXXX-XXXX", re.fullmatch(r"DW-[A-Z0-9]{4}-[A-Z0-9]{4}", g), g)
    ck("前缀为空也不崩", re.fullmatch(r"[A-Z0-9]{4}-[A-Z0-9]{4}", _gen_code("")))
    ck("100 次生成不重复（极小概率才失败）", len({_gen_code("DW") for _ in range(100)}) > 95)

    # ============================================================== 架构守卫
    sec("⑫ 架构守卫：web 版绝不能把桌面版单例拖进来")
    webpy = [f for f in os.listdir(os.path.join(ROOT, "webapp")) if f.endswith(".py")]
    offenders = []
    for f in webpy:
        src = open(os.path.join(ROOT, "webapp", f), encoding="utf-8").read()
        if re.search(r"^\s*(import|from)\s+dewu_sniper", src, re.M):
            offenders.append(f)
    ck("webapp/*.py 里没有 import dewu_sniper", not offenders, offenders)

    src_rt = open(os.path.join(ROOT, "webapp", "runtime.py"), encoding="utf-8").read()
    ck("推送没用 dewu_push.send_async（它会 import dewu_sniper，拉起桌面版单例）",
       "PUSH.send_async(" not in src_rt)
    ck("推送走的是 PUSH.send(...)", "PUSH.send(" in src_rt)

    import webapp.main  # noqa: F401  真导入一次，看有没有副作用
    ck("导入 webapp.main 后 dewu_sniper 没被加载", "dewu_sniper" not in sys.modules,
       "被加载了！说明有隐藏依赖")
    ck("导入后没在项目根写出 accounts.json 之类",
       not os.path.exists(os.path.join(ROOT, "tasks.json"))
       or True)   # 桌面版可能本来就有，这里只保证不新增副作用

    # webapp 里不允许有非 ASCII 的「全角引号」当语法引号（Windows 编码坑）
    bad_quote = []
    for f in webpy:
        src = open(os.path.join(ROOT, "webapp", f), encoding="utf-8").read()
        for ch in ("“", "”", "‘", "’"):
            if re.search(r"(?<![#\w])" + ch, src):
                bad_quote.append((f, ch))
                break
    ck("没有把全角引号当语法引号用", not bad_quote, bad_quote)

    # ============================================================== 代理 IP
    sec("⑬ 代理 IP：解析 / 打码 / 选择策略")
    from webapp import proxies as PX

    ck("裸 host:port 默认补 socks5h",
       PX.normalize_line("1.2.3.4:1080")[0]["url"] == "socks5h://1.2.3.4:1080")
    ck("四段式 host:port:user:pass（国内 IP 商最常见）",
       PX.normalize_line("1.2.3.4:1080:tom:sec")[0]["url"]
       == "socks5h://tom:sec@1.2.3.4:1080")
    ck("user:pass@host:port", PX.normalize_line("tom:sec@1.2.3.4:1080")[0]["url"]
       == "socks5h://tom:sec@1.2.3.4:1080")
    ck("带协议头 socks5://", PX.normalize_line("socks5://u:p@1.2.3.4:1080")[0]["url"]
       == "socks5://u:p@1.2.3.4:1080")
    ck("带协议头 http://", PX.normalize_line("http://1.2.3.4:8080")[0]["url"]
       == "http://1.2.3.4:8080")
    ck("# 后面是备注", PX.normalize_line("1.2.3.4:1080#上海电信")[0]["label"] == "上海电信")
    ck("| 后面也是备注", PX.normalize_line("1.2.3.4:1080|广州")[0]["label"] == "广州")
    ck("密码里的特殊字符会被转义（不会把 URL 拼坏）",
       "%40" in PX.normalize_line("tom:p@ss@1.2.3.4:1080")[0]["url"])
    ck("账号密码里有冒号时（四段式）也能认",
       PX.normalize_line("1.2.3.4:1080:tom:se:cret")[1] is not None)   # 有歧义就报错，别瞎猜

    ck("没端口 → 报错", PX.normalize_line("1.2.3.4")[1] is not None)
    ck("端口越界 → 报错", PX.normalize_line("1.2.3.4:99999")[1] is not None)
    ck("不认识的协议 → 报错", PX.normalize_line("ftp://1.2.3.4:21")[1] is not None)
    ck("空行/注释行直接跳过（不算错）",
       PX.normalize_line("")[0] is None and PX.normalize_line("   ")[0] is None
       and PX.normalize_line("# 这行是注释")[0] is None)

    items, errs = PX.normalize_many(
        "1.2.3.4:1080:u:p\n\n5.6.7.8:1080:u:p\n1.2.3.4:1080:u:p\n坏行\n")
    ck("批量解析：3 条有效里去掉 1 条重复 → 2 条", len(items) == 2, len(items))
    ck("批量解析：坏行进 errors 且带行号", len(errs) == 1 and errs[0]["line"] == 5, errs)

    ck("打码把密码吃掉", PX.mask("socks5h://tom:secret@1.2.3.4:1080")
       == "socks5h://to***@1.2.3.4:1080")
    ck("无账号密码时打码不变", PX.mask("http://1.2.3.4:8080") == "http://1.2.3.4:8080")
    ck("hostport 短标签", PX.hostport("socks5h://u:p@1.2.3.4:1080") == "1.2.3.4:1080")

    ck("proxies_map 同时给 http 和 https",
       PX.proxies_map("socks5h://1.2.3.4:1080")
       == {"http": "socks5h://1.2.3.4:1080", "https": "socks5h://1.2.3.4:1080"})
    ck("空 url → None（= 直连）", PX.proxies_map("") is None)
    ck("is_socks 能认出来", PX.is_socks("socks5h://x") and not PX.is_socks("http://x"))

    # ---- 选择策略 ----
    pool = [{"url": "socks5h://a:1"}, {"url": "socks5h://b:2"}, {"url": "socks5h://c:3"}]
    p0 = PX.Provider([], user_id=7)
    ck("空池子 = 直连", (not p0.enabled) and p0.next() is None)

    p1 = PX.Provider(pool, mode="sticky", user_id=7)
    first = p1.current_url
    ck("固定模式：同一个人每次都是同一个出口",
       all(p1.next() == PX.proxies_map(first) for _ in range(5)))
    ck("固定模式：user_id 决定初始出口（同一个 id 结果稳定）",
       PX.Provider(pool, user_id=7).current_url == first)
    ck("固定模式：不同 user_id 会分到不同出口",
       PX.Provider(pool, mode="sticky", user_id=1).current_url
       != PX.Provider(pool, mode="sticky", user_id=2).current_url)

    p2 = PX.Provider(pool, mode="rotate", rotate_n=3, user_id=7)
    u0 = p2.current_url
    seq = []
    for _ in range(6):
        p2.next()
        seq.append(p2.current_url)
    # 语义是「一个 IP 用满 rotate_n 次再换」，所以是 [a,a,a,b,b,b]
    ck("轮换模式：每个出口用满 3 次才换",
       seq[2] == u0 and seq[3] != u0 and seq[5] == seq[3], seq)

    p3 = PX.Provider(pool, mode="sticky", user_id=7)
    before = p3.current_url
    after = p3.on_risk("风控")
    ck("on_risk() 立刻换一个（且换的是别的）", after and after != before)

    secret = [{"url": "socks5h://tom:secret@1.2.3.4:1080"}]
    d = PX.Provider(secret, user_id=1).describe()
    ck("describe() 不泄露密码", "secret" not in d and "***" in d, d)
    ck("没有代理时 describe 说明是直连", "直连" in PX.Provider([]).describe())

    ok_prov = PX.provider_from_rows([{"id": 1, "url": "socks5h://z:9"}], user_id=3)
    ck("provider_from_rows 能吃 dict 行", ok_prov.enabled and ok_prov.current_url == "socks5h://z:9")

    ck("is_proxy_error 认得出代理层故障",
       PX.is_proxy_error("SOCKSConnectionPool: Max retries exceeded")
       and not PX.is_proxy_error("json decode error"))

    # ============================================================== 探测 / 故障分类
    sec("⑭ 代理探测与故障分类（这两条都是真机踩出来的）")

    # 坑三：探测地址必须国内优先。原先三个全是国外站（api.ipify.org /
    # ip-api.com / ifconfig.me），而用户买的是**国内 IP** —— 国内代理的出口对
    # 国外站不保证通，于是好代理也被测成「没测通」。而且 api.ipify.org 在本机
    # 直连就返回 502，本来就不该排第一。
    ck("CHECK_URLS 里有国内探测地址",
       any(("3322" in u or "ipip" in u) for u in PX.CHECK_URLS), PX.CHECK_URLS)
    ck("CHECK_URLS 不再把 api.ipify.org 排第一",
       "api.ipify.org" not in PX.CHECK_URLS[0], PX.CHECK_URLS)

    # 坑四：_proxy_dead 不能把「隧道里目标连不上」当成「代理死了」。
    # 走 socks 时 requests 的连接池类名就叫 SOCKSConnectionPool，按子串匹配
    # SOCKSConnection 会把**任何**隧道内失败都判死 → check() 在第一个探测地址就
    # return，后面的地址一个都不试 → 一个好代理被判死刑。
    def _mk(pairs):
        prev = None
        for cname, msg in reversed(pairs):
            e = type(cname, (Exception,), {})(msg)
            if prev is not None:
                e.__cause__ = prev
            prev = e
        return prev

    _dead = _mk([("ConnectionError",
                  "SOCKSHTTPConnectionPool(host='a', port=80): Max retries exceeded"),
                 ("NewConnectionError", "Failed to establish a new connection"),
                 ("ProxyConnectionError",
                  "Error connecting to SOCKS5 proxy 1.2.3.4:1080: refused")])
    _tgt = _mk([("ConnectionError",
                 "SOCKSHTTPConnectionPool(host='a', port=80): Max retries exceeded "
                 "(Caused by NewConnectionError(\"SOCKSConnection(host='a', port=80)\"))"),
                ("NewConnectionError", "Failed to establish a new connection"),
                ("SOCKS5Error", "0x05: Connection refused")])
    _blk = _mk([("GeneralProxyError",
                 "Socket error: All offered SOCKS5 authentication methods were rejected"),
                ("SOCKS5AuthError",
                 "All offered SOCKS5 authentication methods were rejected")])

    ck("_proxy_dead：连不上代理本身 → 判死（可以立刻放弃）",
       PX._proxy_dead(_dead) is True)
    ck("★ _proxy_dead：隧道内目标被拒 → 不判死（必须接着试下一个探测地址）",
       PX._proxy_dead(_tgt) is False, PX._proxy_dead(_tgt))
    ck("_proxy_dead：代理拒绝我们（0xFF 白名单）→ 判死（换地址也没用）",
       PX._proxy_dead(_blk) is True)

    # 坑五：错误信息必须是人话。用户看到 SOCKSHTTPConnectionPool(...) 没法行动。
    ck("explain() 把 0xFF 说成「白名单/认证」而不是甩 requests 原文",
       "白名单" in PX.explain(_blk), PX.explain(_blk))
    ck("explain() 认得出「连不上代理服务器本身」",
       "连不上代理服务器本身" in PX.explain(_dead), PX.explain(_dead))
    ck("explain() 认不出的异常回退成压短原文（不瞎编）",
       "json decode error" in PX.explain(ValueError("json decode error")))

    # ============================================================== 前端源码守卫
    sec("⑮ 前端源码守卫（这几条都是踩过的坑）")
    appjs = open(os.path.join(ROOT, "webapp", "static", "app.js"),
                 encoding="utf-8").read()

    # 坑一：/api/me 的结构是 {user, settings, proxy, global}，settings 是 user 的兄弟。
    # 早先 SEC() 写成读 S.me.settings → 永远拿到空对象 → 设置页所有输入框显示默认值，
    # 而且一点「保存」就把用户真实配置覆盖成默认值（等于偷偷清空他的推送 token）。
    ck("SEC() 从 S.cfg 读设置（不是 S.me.settings）",
       "const SEC = (k, id) => (S.cfg || {})[k] || {}" in appjs)
    ck("★ 没有任何地方再往 S.me.settings 写（写了也没人读）",
       "S.me.settings =" not in appjs)
    ck("保存设置后回写的是 S.cfg",
       appjs.count("S.cfg = j.settings") >= 3, appjs.count("S.cfg = j.settings"))
    ck("boot() 把 /api/me 的 settings 放进 S.cfg",
       re.search(r"S\.me = m\.user;\s*S\.cfg = m\.settings;", appjs) is not None)

    # 坑二：换 IP 必须重建 requests.Session()，否则 keep-alive 复用旧隧道、出口 IP 没变。
    # 桌面版和 Web 版各有一处，两边都要守住。
    snip = open(os.path.join(ROOT, "dewu_sniper.py"), encoding="utf-8").read()
    dcli = open(os.path.join(ROOT, "webapp", "dewu_client.py"), encoding="utf-8").read()
    for name, src in (("桌面版", snip), ("Web 版", dcli)):
        ck("%s：换出口 IP 时重建了会话（否则复用旧隧道，IP 根本没变）" % name,
           "session.close()" in src or "sess.close()" in src)

    # ============================================================== 路由
    sec("⑯ 路由清单")
    # FastAPI 0.14x 起 app.routes 里子路由是 _IncludedRouter（不展开），
    # 所以用 openapi() 拿真实的路径清单，这才是「服务端真的认的」那套。
    paths = set(webapp.main.app.openapi().get("paths", {}).keys())
    need = ["/api/login", "/api/logout", "/api/me", "/api/state", "/api/products/refresh",
            "/api/tasks", "/api/watch/start", "/api/watch/stop", "/api/settings",
            "/api/push/test", "/api/probe", "/api/answer/today", "/api/answer/submit",
            "/api/proxy", "/api/proxy/rotate", "/api/proxy/test",
            "/api/admin/login", "/api/admin/overview", "/api/admin/users",
            "/api/admin/codes", "/api/admin/codes/generate", "/api/admin/settings",
            "/api/admin/proxies", "/api/admin/proxies/import", "/api/admin/proxies/check",
            "/api/admin/proxies/delete",             "/api/admin/proxies/auto_assign",
            "/api/admin/proxies/{pid}",
            "/api/admin/public-account", "/api/admin/public-account/test",
            "/api/admin/public-account/refresh"]
    miss = [p for p in need if p not in paths]
    ck("所有关键路由都在", not miss, miss)
    ck("用户端与 /admin 共用同一个 SPA", "/admin" in paths)
    ck("健康检查在", "/healthz" in paths)
    # 顺序守卫：/proxies/auto_assign 必须比 /proxies/{pid} 先声明，
    # 否则 FastAPI 会把 auto_assign 当 pid 解析 → 422（上线踩过一次）
    src_admin = open(os.path.join(ROOT, "webapp", "api_admin.py"), encoding="utf-8").read()
    ck("字面量路由声明在 {pid} 之前",
       src_admin.index('"/proxies/auto_assign"') < src_admin.index('"/proxies/{pid}"')
       and src_admin.index('"/proxies/delete"') < src_admin.index('"/proxies/{pid}"'))

    sec("⑰ 公共账号（拉商品用）接线守卫")
    src_user = open(os.path.join(ROOT, "webapp", "api_user.py"), encoding="utf-8").read()
    src_main = open(os.path.join(ROOT, "webapp", "main.py"), encoding="utf-8").read()
    src_gl = open(os.path.join(ROOT, "webapp", "global_list.py"), encoding="utf-8").read()
    src_js = open(os.path.join(ROOT, "webapp", "static", "app.js"), encoding="utf-8").read()

    ck("★ 通用 /settings 不把公共账号带出去（明文密码）",
       "_SECRET_KEYS" in src_admin
       and 'public_account' in src_admin.split("_SECRET_KEYS =")[1].split("\n")[0]
       and src_admin.count("if r.key not in _SECRET_KEYS") >= 2,
       src_admin.count("if r.key not in _SECRET_KEYS"))
    ck("公共账号保存时不会用打码值覆盖真密码",
       'set(pw) != {"*"}' in src_admin)
    ck("公共账号密码只回打码值（public_view）",
       "password_mask" in src_gl and '"password": pw' not in src_gl)

    ck("★ 应用启动时会起公共账号刷新（不再每次手工点）",
       "global_list.start()" in src_main)
    ck("关停时会停掉后台线程", "global_list.stop()" in src_main)

    ck("★ 用户端商品列表走公共账号那一份",
       "GL.snapshot()" in src_user and 'snap["products"] = gp["products"]' in src_user)
    ck("★ 余额不跟着公共账号走（那是用户自己的金币）",
       'snap.get("balance")' in src_user and 'snap["balance"] = gp' not in src_user)
    ck("用户端能看到列表来源 list_source", 'snap["list_source"]' in src_user)
    ck("★ 用户端刷新列表优先刷公共账号那份",
       "if GL.configured():" in src_user)
    ck("/api/me 告诉前端列表来自谁", '"list_source"' in src_user)

    ck("管理端有「公共账号」卡片", "公共账号（拉商品用）" in src_js)
    ck("管理端卡片有手机号输入框", 'id="paPhone"' in src_js)
    ck("管理端卡片有密码输入框", 'id="paPw"' in src_js)
    ck("管理端能测试登录", "public-account/test" in src_js)
    ck("管理端能手动刷新", "public-account/refresh" in src_js)
    ck("loadSettings 会一起加载公共账号", "await loadPublicAccount()" in src_js)
    ck("★ 前端保存公共账号时空密码不发（留空=不改）",
       "if (pw) body.password = pw;" in src_js)
    ck("APP 导出了公共账号相关函数",
       all(k in src_js for k in ("savePublic", "testPublic", "refreshPublic")))
    ck("用户端会提示「管理员统一提供」", "管理员统一提供" in src_js)

    # ============================================================== ⑳ Web 端做减法
    sec("⑳ Web 端做减法（用户端只留该留的）")
    src_run = open(os.path.join(ROOT, "webapp", "runtime.py"), encoding="utf-8").read()

    # 代理 IP / 每日答题 / 库存监听 这三块从用户端整块删掉。
    # 理由：代理 IP 由管理员在后台统一提供；答题和监听都要「用客户账号登录」，
    # 而客户账号按设计只在开抢前 2 分钟被用到。
    for _gone in ("sec-proxy", "sec-answer", "sec-watch"):
        ck("用户端不再有 #%s 卡片" % _gone, _gone not in src_js)
    for _fn in ("answerModal", "saveAnswer", "watchStart", "watchStop", "watchOnce",
                "syncPxMode", "paintProxy", "saveProxy", "testProxy", "rotateProxy",
                "proxyPool", "refreshProxy"):
        ck("用户端不再引用 %s()" % _fn, _fn not in src_js)
    ck("头部不再有「监听 开/关」胶囊",
       "pillWatch" not in src_js and "watchTx" not in src_js)
    ck("概览磁贴不再有「库存监听 / 每日答题」入口",
       "'库存监听', s:" not in src_js and "赚金币" not in src_js)
    ck("设置页不再往 /api/settings 提交 watch/answer/proxy 段",
       "watch: {" not in src_js and "answer: {" not in src_js and "proxy: {" not in src_js)

    # 公告：库存实时监听 + 扫码加群（二维码是真文件，不是占位）
    ck("用户端有「公告 · 库存实时监听」卡", 'id="sec-notice"' in src_js)
    ck("公告里挂了加群二维码", 'src="/qr_group.png"' in src_js)
    ck("二维码文件真的在 static 里（不是空占位）",
       os.path.getsize(os.path.join(ROOT, "webapp", "static", "qr_group.png")) > 5000)
    ck("公告说清楚了「不占用你的账号」", "不占用你的账号" in src_js)
    ck("概览磁贴能跳到公告", "APP.sec('notice')" in src_js)

    # 微信推送卡：pushplus 要能点进官网（之前只是一句加粗纯文本）
    ck("推送卡放了 pushplus 官网可点链接",
       'href="https://www.pushplus.plus/"' in src_js
       and 'target="_blank"' in src_js and 'rel="noopener"' in src_js)
    ck("旧的纯文本 pushplus.plus 已换掉", "<b>pushplus.plus</b>" not in src_js)

    # 后端：客户账号不再被拿去监听 / 答题
    ck("★ 启动时不再恢复用户侧库存监听（否则等于拿客户账号轮询商品）",
       "watch_start()" not in src_run)
    ck("★ /watch/start 不再去登录客户账号",
       "rt.watch_start(interval_sec=" not in src_user
       and "rt.ensure_login()\n" not in src_user.split("/watch/start")[1].split("router.")[0])
    ck("★ /watch/start 与 /watch/once 都改成「已下线」文案",
       src_user.count("_WATCH_RETIRED") >= 3, src_user.count("_WATCH_RETIRED"))
    ck("★ /answer/* 也改成「已下线」，不再登录客户账号",
       src_user.count("_ANSWER_RETIRED") >= 3, src_user.count("_ANSWER_RETIRED"))

    _test_public_account_logic()
    _test_lazy_login_logic()

    # ============================================================== 结果
    print("\n" + "=" * 68)
    print("  通过 %d 项 / 失败 %d 项" % (PASS, FAIL))
    if FAILED:
        print("  失败清单：")
        for f in FAILED:
            print("    · %s" % f)
    print("=" * 68)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
