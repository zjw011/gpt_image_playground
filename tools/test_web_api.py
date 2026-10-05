# -*- coding: utf-8 -*-
"""Web 版端到端接口测试（对着真实运行的服务打）。

    python run_web.py            # 另开一个窗口先把服务跑起来
    python tools/test_web_api.py [base_url]

用真实的得物账号 curl（dist/accounts.json 里的第一条）走「粘贴 curl 登录」这条路，
避免测试依赖测试账号的密码。会真的拉一次商品列表（只读，不花金币）。
"""
import json
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8123"
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


def main():
    s = requests.Session()
    admin = requests.Session()

    # ---------------------------------------------------------------- 静态页
    sec("① 静态页面")
    r = s.get(BASE + "/")
    ck("GET / 返回 200", r.status_code == 200, r.status_code)
    ck("首页含 app.js", "app.js" in r.text)
    r = s.get(BASE + "/admin")
    ck("GET /admin 也返回同一个 SPA", r.status_code == 200 and "app.js" in r.text)
    r = s.get(BASE + "/style.css")
    ck("GET /style.css 200", r.status_code == 200)
    ck("未登录访问 /api/state → 401", s.get(BASE + "/api/state").status_code == 401)

    # ---------------------------------------------------------------- 管理员
    sec("② 管理员：登录 / 生成兑换码 / 概览")
    adm_user = os.environ.get("ADMIN_USER") or "admin"
    r = admin.post(BASE + "/api/admin/login", json={"username": adm_user, "password": "bad"})
    ck("错误密码被拒", r.json().get("ok") is False)
    pw = os.environ.get("ADMIN_PW") or (open(os.path.join(ROOT, "webdata", "ADMIN_PASSWORD.txt"),
                                             encoding="utf-8").read().strip()
                                        if os.path.exists(os.path.join(ROOT, "webdata",
                                                                       "ADMIN_PASSWORD.txt"))
                                        else "")
    if not pw:
        print("  ! 拿不到管理员密码（设 ADMIN_PW 环境变量），跳过管理端用例")
        return report()
    r = admin.post(BASE + "/api/admin/login", json={"username": adm_user, "password": pw})
    if not r.json().get("ok"):
        # 用户名可能被改过（默认 admin，本项目已改成 xiaole）
        r = admin.post(BASE + "/api/admin/login", json={"username": "xiaole", "password": pw})
    ck("管理员登录成功", r.json().get("ok") is True, r.text[:120])
    ck("管理 cookie 已下发", "dw_admin" in admin.cookies)

    r = admin.post(BASE + "/api/admin/codes/generate",
                   json={"count": 3, "quota": 1, "prefix": "TEST", "note": "自动测试"})
    j = r.json()
    ck("批量生成 3 个兑换码", j.get("ok") and len(j.get("codes", [])) == 3, r.text[:150])
    code1 = (j.get("codes") or ["", "", ""])[0]
    ck("兑换码格式像 TEST-XXXX-XXXX", code1.startswith("TEST-") and len(code1) == 14, code1)

    r = admin.get(BASE + "/api/admin/codes")
    ck("兑换码列表能查到", r.json().get("ok") and r.json().get("total", 0) >= 3)

    r = admin.get(BASE + "/api/admin/overview")
    ck("概览返回统计字段", set(["users", "tasks", "codes"]).issubset(r.json().get("stats", {}).keys()))

    r = admin.get(BASE + "/api/admin/settings")
    ck("全局设置含活动 id", "dewu_activity" in r.json().get("settings", {}))
    ck("★ 通用设置接口不带公共账号（明文密码不外泄）",
       "public_account" not in r.json().get("settings", {}))

    # ---------------------------------------------------- 公共账号（拉商品用）
    sec("②b 公共账号：配置读写 / 密码不回明文")
    r = admin.get(BASE + "/api/admin/public-account")
    j = r.json()
    ck("GET /public-account 可用", j.get("ok") is True, r.text[:150])
    ck("返回 config 且带打码字段", isinstance(j.get("config"), dict)
       and "password_mask" in j["config"] and "has_password" in j["config"])
    ck("返回 status（含 running/logs）",
       isinstance(j.get("status"), dict) and "running" in j["status"]
       and "logs" in j["status"])
    ck("★ config 里没有明文字段 password", "password" not in j.get("config", {}))

    r = admin.post(BASE + "/api/admin/public-account",
                   json={"phone": "13800000000", "password": "test-pass-123",
                         "enabled": False, "interval_sec": 45})
    j = r.json()
    ck("保存公共账号成功", j.get("ok") is True, r.text[:150])
    ck("回显手机号正确", j.get("config", {}).get("phone") == "13800000000", str(j.get("config")))
    ck("★ 回显密码是打码的", j.get("config", {}).get("password_mask") == "t************",
       str(j.get("config", {}).get("password_mask")))
    ck("间隔被保存（45）", j.get("config", {}).get("interval_sec") == 45)

    r = admin.post(BASE + "/api/admin/public-account",
                   json={"phone": "13800000000", "password": "**********"})
    ck("★ 前端回显的星号不会覆盖真密码",
       r.json().get("config", {}).get("password_mask") == "t************",
       str(r.json().get("config", {}).get("password_mask")))

    r = admin.post(BASE + "/api/admin/public-account/test", json={})
    j = r.json()
    ck("测试接口会真的去登录（失败也返回 ok=false + 原因）",
       j.get("ok") is False and bool(j.get("msg")), r.text[:160])

    r = admin.post(BASE + "/api/admin/public-account",
                   json={"phone": "", "password": "", "enabled": False})
    ck("★ 清空手机号后 configured=false", r.json().get("config", {}).get("configured") is False)

    # ---------------------------------------------------- 天启IP（开抢前换 IP）
    sec("②c 天启IP：配置读写 / 密钥不回明文")
    r = admin.get(BASE + "/api/admin/tianqi")
    j = r.json()
    ck("GET /tianqi 可用", j.get("ok") is True, r.text[:150])
    ck("返回 config + 提前登录秒数", isinstance(j.get("config"), dict)
       and j.get("lead_login_sec") == 120, j.get("lead_login_sec"))
    ck("返回寿命可选值", j.get("lives") == [3, 5, 10, 15], j.get("lives"))

    r = admin.post(BASE + "/api/admin/tianqi",
                   json={"secret": "sec-abcdef123456", "sign": "sign-98765432",
                         "key": "key-11223344", "enabled": True, "life": 3,
                         "protocol": 3})
    j = r.json()
    ck("保存天启配置成功", j.get("ok") is True, r.text[:150])
    c = j.get("config", {})
    ck("★ secret 回的是打码值", c.get("secret") and c["secret"] != "sec-abcdef123456"
       and "*" in c["secret"], c.get("secret"))
    ck("★ 明文密钥不出现在响应里", "sec-abcdef123456" not in r.text)
    ck("has_secret=True", c.get("has_secret") is True)
    ck("configured=True", c.get("configured") is True)
    ck("ready=True（开关也开了）", c.get("ready") is True)

    r = admin.post(BASE + "/api/admin/tianqi",
                   json={"secret": "sec-************", "enabled": True})
    ck("★ 打码值发回来不会覆盖真密钥",
       r.json().get("config", {}).get("secret") == c.get("secret"),
       str(r.json().get("config", {}).get("secret")))

    r = admin.post(BASE + "/api/admin/tianqi/test", json={})
    j = r.json()
    ck("测试提取返回 ok=false + 可读原因（填的是假密钥）",
       j.get("ok") is False and bool(j.get("msg")), r.text[:180])

    r = admin.get(BASE + "/api/admin/settings")
    ck("★ 通用设置接口也不带天启密钥",
       "tianqi" not in r.json().get("settings", {}))

    admin.post(BASE + "/api/admin/tianqi", json={"enabled": False})

    # ---------------------------------------------------------------- 用户登录
    sec("③ 用户登录（粘贴 curl 兜底通道）")
    accs = json.load(open(os.path.join(ROOT, "dist", "accounts.json"), encoding="utf-8"))
    curl = accs[0]["list_curl"]
    r = s.post(BASE + "/api/login", json={"curl": "curl 'https://x.com/' -H 'a: b'"})
    ck("无效 curl 被拒", r.json().get("ok") is False, r.text[:110])

    r = s.post(BASE + "/api/login", json={"curl": curl})
    j = r.json()
    ck("curl 登录成功", j.get("ok") is True, r.text[:200])
    ck("用户 cookie 已下发", "dw_sid" in s.cookies)

    r = s.get(BASE + "/api/me")
    j = r.json()
    ck("/api/me 返回用户信息", j.get("ok") and "phone" in j.get("user", {}))
    ck("/api/me 带 settings", isinstance(j.get("settings"), dict))
    ck("/api/me 带 global.require_code", "require_code" in j.get("global", {}))

    # ---------------------------------------------------------------- 懒登录
    sec("③b 懒登录：提交账号密码只存不登，开抢前 2 分钟才登录")
    lazy = requests.Session()
    r = lazy.post(BASE + "/api/login", json={"phone": "abc", "password": "x"})
    ck("手机号格式不对被拒", r.json().get("ok") is False, r.text[:120])
    r = lazy.post(BASE + "/api/login", json={"phone": "13900000009", "password": ""})
    ck("空密码被拒", r.json().get("ok") is False, r.text[:120])

    r = lazy.post(BASE + "/api/login",
                  json={"phone": "13900000009", "password": "dewu-pass-123"})
    j = r.json()
    ck("★ 提交账号密码就进去了（后台不登录）", j.get("ok") is True, r.text[:200])
    ck("★ 明确标了 lazy=true", j.get("lazy") is True, str(j))
    ck("★ 返回的提示就是那句「开抢前才会自动登录」",
       "开抢前" in (j.get("msg") or "") and "自动登录" in (j.get("msg") or ""),
       j.get("msg"))

    m = lazy.get(BASE + "/api/me").json()
    lg = m.get("login") or {}
    ck("★ /api/me 说这个人还没登录", lg.get("logged_in") is False, str(lg))
    ck("★ 但记下了「有密码」→ 会懒登录", lg.get("has_password") is True, str(lg))
    ck("懒登录模式 lazy=true", lg.get("lazy") is True)
    ck("提前登录秒数是 120", lg.get("lead_sec") == 120, lg.get("lead_sec"))
    ck("★ 这时没有出口 IP（还没登录过）",
       lg.get("ip") == "" and lg.get("where") == "", str(lg))
    ck("/api/me 里 global 带了 lead_login_sec",
       (m.get("global") or {}).get("lead_login_sec") == 120,
       (m.get("global") or {}).get("lead_login_sec"))

    # 需要 token 的功能会「按需登一次」——用的是假密码，所以这里必须是
    # 「登录失败 + 可读原因」，而不是 500、也不是「登录态丢失」这种含糊话。
    r = lazy.post(BASE + "/api/probe", json={})
    j = r.json()
    ck("★ 链路诊断在没登录时会去真登录，失败给可读原因",
       j.get("ok") is False and bool(j.get("msg")) and "登录态丢失" not in (j.get("msg") or ""),
       r.text[:200])

    lazy.post(BASE + "/api/logout", json={})

    # 切回 curl 模式要能覆盖掉存的密码（否则会一直走懒登录）
    r = s.post(BASE + "/api/login", json={"curl": curl})
    ck("老用户重新用 curl 登录仍然成功", r.json().get("ok") is True, r.text[:160])
    m = s.get(BASE + "/api/me").json()
    ck("★ curl 模式不标 lazy", (m.get("login") or {}).get("lazy") is False,
       str(m.get("login")))

    # ---------------------------------------------------------------- 商品
    sec("④ 商品列表（图片/价格/库存/金币四个字段必须齐全）")
    r = s.post(BASE + "/api/products/refresh", json={})
    j = r.json()
    ck("刷新列表成功", j.get("ok") is True, r.text[:200])
    st = s.get(BASE + "/api/state").json()
    ps = st.get("products") or []
    ck("拿到商品（>0）", len(ps) > 0, "数量 %s" % len(ps))
    if ps:
        p = ps[0]
        ck("字段 picture", "picture" in p and isinstance(p["picture"], str))
        ck("字段 price（分）", p.get("price") is not None)
        ck("字段 priceYuan", p.get("priceYuan") is not None)
        ck("字段 stock", "stock" in p)
        ck("字段 cost（金币）", p.get("cost") is not None)
        ck("字段 cName", bool(p.get("cName")))
        with_img = [x for x in ps if x.get("picture")]
        ck("大部分商品有图片", len(with_img) >= len(ps) * 0.8,
           "%d/%d" % (len(with_img), len(ps)))
        print("     样例：%s | %s | 库存 %s | %s 金币"
              % (p["cName"][:22], "¥%.2f" % (p["priceYuan"] or 0), p.get("stock"), p.get("cost")))

    # ---------------------------------------------------------------- 兑换码
    sec("⑤ 兑换码：一码一任务")
    ck("不填兑换码被拒", s.post(BASE + "/api/tasks", json={"cId": ps[0]["cId"]}).json().get("ok") is False)
    ck("瞎编兑换码被拒", s.post(BASE + "/api/tasks",
                              json={"cId": ps[0]["cId"], "code": "NOPE-0000-0000"}).json().get("ok") is False)
    ck("不存在的商品被拒", s.post(BASE + "/api/tasks",
                               json={"cId": 99999999, "code": code1}).json().get("ok") is False)

    r = s.post(BASE + "/api/tasks", json={"cId": ps[0]["cId"], "code": code1,
                                          "time": "23:59:59", "fallback": True})
    j = r.json()
    ck("用合法兑换码建任务成功", j.get("ok") is True, r.text[:200])
    task_id = j.get("task_id")

    r = s.post(BASE + "/api/tasks", json={"cId": ps[0]["cId"], "code": code1, "time": "23:59:58"})
    ck("同一个码第二次被拒（一码一任务）", r.json().get("ok") is False, r.text[:160])

    codes = admin.get(BASE + "/api/admin/codes?q=" + code1).json().get("codes") or []
    ck("后台看到该码已 used", codes and codes[0].get("status") == "used", str(codes[:1]))
    ck("后台看到该码绑定了用户", codes and codes[0].get("bound_user_id") is not None)

    # ---------------------------------------------------------------- 任务
    sec("⑥ 任务列表 / 操作")
    st = s.get(BASE + "/api/state").json()
    ts = st.get("tasks") or []
    ck("任务出现在列表里", any(t["id"] == task_id for t in ts), str([t["id"] for t in ts]))
    t = next((x for x in ts if x["id"] == task_id), {})
    ck("任务含商品图片字段", "picture" in t)
    ck("任务状态是等待", t.get("status") == "等待", t.get("status"))
    ck("任务带自动降级标记", t.get("fallback") is True)

    r = s.post(BASE + "/api/tasks/%d/stop" % task_id, json={})
    ck("停止任务接口可用", r.json().get("ok") is True, r.text[:120])
    r = s.post(BASE + "/api/tasks/%d/delete" % task_id, json={})
    ck("删除任务接口可用", r.json().get("ok") is True)
    st = s.get(BASE + "/api/state").json()
    ck("删除后任务不再出现", not any(x["id"] == task_id for x in st.get("tasks", [])))

    # 回归：删任务是「先置停止位、再写已删除」，后台线程被叫醒之后会走
    # 「已手动停止」分支。如果那里不设防，它会把删掉的任务又写回「已取消」，
    # 列表里就冒出一张卡。等几秒让线程真的醒过来再看一次。
    time.sleep(3.5)
    st = s.get(BASE + "/api/state").json()
    ck("等 3.5 秒后任务仍然不出现（后台线程没把它复活）",
       not any(x["id"] == task_id for x in st.get("tasks", [])),
       str([(x["id"], x["status"]) for x in st.get("tasks", [])]))

    # ---------------------------------------------------------------- 隔离
    sec("⑦ 多用户隔离（换个浏览器 = 换个用户，不能串）")
    other = requests.Session()
    r = other.get(BASE + "/api/state")
    ck("未登录的第二个会话拿不到状态", r.status_code == 401)
    r = other.post(BASE + "/api/login", json={"curl": accs[1]["list_curl"] if len(accs) > 1 else curl})
    j = r.json()
    if len(accs) > 1 and j.get("ok"):
        st2 = other.get(BASE + "/api/state").json()
        ck("用户2 的任务列表是空的（没有看到用户1 的）",
           len(st2.get("tasks") or []) == 0, "用户2 看到 %d 条" % len(st2.get("tasks") or []))
        ck("用户2 的 phone 与用户1 不同",
           st2.get("logs") is not None and s.get(BASE + "/api/me").json()["user"]["phone"]
           != other.get(BASE + "/api/me").json()["user"]["phone"])
    else:
        print("  ! 只有一个可用账号，跳过跨用户隔离用例")

    # ---------------------------------------------------------------- 设置
    sec("⑧ 设置 / 推送 / 已下线功能")
    r = s.post(BASE + "/api/settings", json={"watch": {"interval_sec": 45, "notify_new": True},
                                             "fallback": {"enabled": True, "min_ratio": 0.2}})
    j = r.json()
    ck("保存设置成功", j.get("ok") is True)
    ck("★ 遗留的 watch 段仍能落库（不报错，只是用户端不再有入口）",
       (j.get("settings", {}).get("watch") or {}).get("interval_sec") == 45)
    ck("降级比例已落库", (j.get("settings", {}).get("fallback") or {}).get("min_ratio") == 0.2)

    r = s.post(BASE + "/api/settings", json={"push": {"topic": "dewu!!中文"}})
    ck("群组编码被清洗（只留 ASCII）",
       (r.json().get("settings", {}).get("push") or {}).get("topic") == "dewu", r.text[:160])

    r = s.post(BASE + "/api/push/test", json={})
    ck("没填 token 时测试推送给出提示", r.json().get("ok") is False)

    r = s.get(BASE + "/api/answer/today")
    j = r.json()
    ck("★ 每日答题已下线（给可读原因，不再登录客户账号）",
       j.get("ok") is False and "下线" in (j.get("msg") or ""), r.text[:160])

    r = s.post(BASE + "/api/watch/start", json={"interval_sec": 300})
    j = r.json()
    ck("★ 库存监听已下线（用户端不再起监听、不拿客户账号轮询商品）",
       j.get("ok") is False and "下线" in (j.get("msg") or ""), r.text[:120])
    st = s.get(BASE + "/api/state").json()
    ck("★ 没有监听线程在跑", (st.get("watch") or {}).get("running") is not True)
    r = s.post(BASE + "/api/watch/stop", json={})
    ck("关闭库存监听幂等可用", "ok" in r.json(), r.text[:120])

    # ---------------------------------------------------------------- 登出
    # ---------------------------------------------------------------- 代理 IP
    sec("⑨ 代理 IP 池（导入 / 分配 / 用户侧开关）")
    made_pid = None
    try:
        admin.post(BASE + "/api/admin/settings", json={"proxy_enabled": False})
        # 先清场：这一节要断言「池子里正好 3 个」，所以要保证跑之前是空的。
        # （否则上一轮跑剩的、或手工 curl 造的数据会让计数和换 IP 都失败）
        _old = [p["id"] for p in admin.get(BASE + "/api/admin/proxies").json()["proxies"]]
        if _old:
            admin.post(BASE + "/api/admin/proxies/delete", json={"ids": _old})
        ck("开跑前池子是空的", admin.get(BASE + "/api/admin/proxies").json()["stats"]["total"] == 0)

        j = admin.post(BASE + "/api/admin/proxies/import", json={
            "text": "192.0.2.10:1080:tester:pw\n192.0.2.11:1080:tester:pw\n"
                    "192.0.2.12:8080#测试备注\n这一行是坏的\n"
                    "192.0.2.10:1080:tester:pw",
            "scheme": "socks5h", "label": "自动测试"}).json()
        ck("批量导入成功", j.get("ok") and j.get("added") == 3, j)
        ck("坏行被挑出来并给了行号", j.get("bad_count") == 1
           and j["errors"][0]["line"] == 4, j.get("errors"))
        ck("重复行被去重", j.get("added") == 3, j.get("added"))

        lst = admin.get(BASE + "/api/admin/proxies").json()
        ck("列表返回 3 个", lst["stats"]["total"] == 3, lst["stats"])
        ck("密码被打码（列表里看不到明文）",
           all("pw" not in p["mask"] for p in lst["proxies"]), lst["proxies"][0]["mask"])
        mine = [p for p in lst["proxies"] if p["label"] == "自动测试"]
        ck("没写 # 备注的落到批次备注", len(mine) == 2, len(mine))
        ck("# 后面的备注优先于批次备注",
           any(p["label"] == "测试备注" for p in lst["proxies"]))
        made_pid = mine[0]["id"]

        r = admin.post(BASE + "/api/admin/proxies/%d" % made_pid,
                       json={"enabled": False, "label": "改过"})
        ck("单个代理可停用/改备注",
           r.json()["proxy"]["enabled"] is False and r.json()["proxy"]["label"] == "改过")
        admin.post(BASE + "/api/admin/proxies/%d" % made_pid, json={"enabled": True})

        px = s.get(BASE + "/api/proxy").json()["proxy"]
        ck("用户侧代理状态可读", px.get("assigned") is False, px)
        ck("总开关没开时 ready=False（不会偷偷走代理）", px.get("ready") is False, px)

        admin.post(BASE + "/api/admin/settings", json={"proxy_enabled": True})
        j3 = s.post(BASE + "/api/settings",
                    json={"proxy": {"enabled": True, "mode": "sticky", "rotate_n": 15}}).json()
        ck("用户能改自己的代理设置",
           j3["settings"]["proxy"]["enabled"] is True
           and j3["settings"]["proxy"]["rotate_n"] == 15, j3.get("settings", {}).get("proxy"))
        px = s.get(BASE + "/api/proxy").json()["proxy"]
        ck("总开关打开后 ready=True", px.get("ready") is True, px)
        ck("没绑定时用户侧拿不到出口地址", not px.get("current"), px.get("current"))

        # 换 IP 要在池子还满（3 条都还没被 auto_assign 分走）的时候验证。
        r = s.post(BASE + "/api/proxy/rotate", json={})
        ck("能手动换个 IP", r.json().get("ok") is True, r.text[:160])
        first = s.get(BASE + "/api/proxy").json()["proxy"]
        ck("换完之后就绑上了", first.get("assigned") is True, first)
        ck("用户侧只能看到脱敏后的出口",
           "***" in first.get("current", "") or first.get("current", "").count(":") == 1,
           first.get("current"))
        r = s.post(BASE + "/api/proxy/rotate", json={})
        second = s.get(BASE + "/api/proxy").json()["proxy"]
        ck("再换一次会真的换到另一个出口",
           r.json().get("ok") is True
           and second.get("current") != first.get("current"),
           "%s -> %s" % (first.get("current"), second.get("current")))

        r = admin.post(BASE + "/api/admin/proxies/auto_assign",
                       json={"only_ok": True})
        ck("自动分配（只挑探测通过的）不报错", r.json().get("ok") is True, r.text[:120])
        r = admin.post(BASE + "/api/admin/proxies/auto_assign", json={"only_ok": False})
        j2 = r.json()
        ck("不挑探测结果时能真的分出去", j2.get("ok") is True and j2.get("assigned", 0) >= 1,
           j2)

        r = s.post(BASE + "/api/proxy/test", json={})
        ck("探测接口可用（192.0.2.x 是保留地址，必然不通）",
           r.json().get("ok") is False and "代理不通" in r.json().get("msg", ""),
           r.text[:140])
    finally:
        # 收尾：恢复总开关、清空代理池（这一节自己造的 + 开跑前清掉的都在这里还原成「空」）
        try:
            admin.post(BASE + "/api/admin/settings", json={"proxy_enabled": False})
            s.post(BASE + "/api/settings", json={"proxy": {"enabled": False}})
            kills = [p["id"] for p in
                     admin.get(BASE + "/api/admin/proxies").json()["proxies"]]
            if kills:
                admin.post(BASE + "/api/admin/proxies/delete", json={"ids": kills})
        except Exception as e:
            print("  ! 收尾出错：%r" % (e,))

    # ---------------------------------------------------------------- 登出
    sec("⑩ 登出")
    s.post(BASE + "/api/logout", json={})
    ck("登出后 /api/state 401", s.get(BASE + "/api/state").status_code == 401)

    return report()


def report():
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
