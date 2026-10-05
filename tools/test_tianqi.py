# -*- coding: utf-8 -*-
"""tianqiip（天启IP）客户端单元测试 —— 全部 mock 掉 HTTP，不联网、不消耗套餐。

覆盖：错误码翻译 / 配置自检 / extract 参数拼装 / JSON 解析 / 到期时间/
      Lease 拼 URL / 白名单去重与幂等 / my_ip 国内优先 / 与 dewu_proxies 的对接。

    python tools/test_tianqi.py
"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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


# ================================================================ HTTP 假件
class FakeResp:
    def __init__(self, payload, status=200):
        self.status_code = status
        self._payload = payload
        self.text = (payload if isinstance(payload, str)
                     else json.dumps(payload, ensure_ascii=False))

    def json(self):
        if isinstance(self._payload, str):
            raise ValueError("Expecting value")
        return self._payload


CALLS = []
ROUTES = {}


R_GETIP = "tianqiip.com/getip"
R_FETCH = "tianqiip.com/white/fetch"
R_ADD = "tianqiip.com/white/add"
R_DEL = "tianqiip.com/white/delete"


def fake_get(url, params=None, timeout=None, headers=None, **kw):
    """★ 按「完整 URL 里含某个 key」匹配，不能按最后一段路径匹配 ——
    members.3322.org/dyndns/getip 和天启的 /getip 会撞车（真踩过）。"""
    CALLS.append((url, dict(params or {})))
    for key, fn in ROUTES.items():
        if key in url:
            return fn(dict(params or {}))
    return FakeResp({"code": 9999, "msg": "no route"})


def install():
    """把 requests.get 换成假的。返回还原函数。"""
    import requests
    old = requests.get
    requests.get = fake_get
    return lambda: setattr(requests, "get", old)


def ok_extract(ip="1.2.3.4", port=1080, city="鞍山", prov="辽宁", isp="电信",
               expire=None):
    def fn(p):
        item = {"ip": ip, "port": str(port), "city": city, "prov": prov, "isp": isp}
        if expire is not None:
            item["expire"] = expire
        return FakeResp({"code": 1000, "data": [item]})
    return fn


def main():
    import tianqiip as TQ
    import dewu_proxies as PX

    restore = install()
    try:
        # ====================================================== ① 错误码翻译
        sec("① 错误码 → 人话（三张表分开，因为 1001~1009 段号重叠）")
        ck("提取 1003 说清是 secret 填错", "提取密钥异常" in TQ.explain(1003, "extract"),
           TQ.explain(1003, "extract"))
        ck("提取 1006 说「暂无可用 IP」", "暂无可用" in TQ.explain(1006, "extract"))
        ck("白名单 1003 说的是 key/sign（不是 secret）",
           "key" in TQ.explain(1003, "white") and "secret" not in TQ.explain(1003, "white"),
           TQ.explain(1003, "white"))
        ck("白名单 1007 = IP 已存在（重复添加不算错）", "已存在" in TQ.explain(1007, "white"))
        ck("★ 407 翻译成「白名单没加本机 IP」", "白名单" in TQ.explain(407, "proxy"),
           TQ.explain(407, "proxy"))
        ck("★ 451 翻译成「没提取过或已过期」", "过期" in TQ.explain(451, "proxy"),
           TQ.explain(451, "proxy"))
        ck("456 未实名也认得", "实名" in TQ.explain(456, "proxy"))
        ck("未知码不装懂", TQ.explain(9999) == "未知错误码 9999", TQ.explain(9999))
        ck("非数字也不崩", isinstance(TQ.explain(None), str))
        # 三张表必须都被翻过一遍，不能有落下的
        gap = []
        for _kind, _table in (("extract", TQ.EXTRACT_CODES), ("white", TQ.WHITE_CODES),
                              ("proxy", TQ.PROXY_CODES)):
            gap += [(_kind, c) for c in _table if "未知错误码" in TQ.explain(c, _kind)]
        ck("错误码表里没有漏翻的（三张表各自查，段号重叠不能混用 kind）", not gap, gap)

        # ====================================================== ② 配置自检
        sec("② 配置自检：缺什么要说清楚")
        t = TQ.TianqiIP()
        ck("空配置 → configured=False", t.configured is False)
        ck("缺项清单含 secret 和 sign",
           "提取秘钥(secret)" in t.missing() and "用户签名(sign)" in t.missing(), t.missing())
        ck("white_configured 还要 key", t.white_configured is False
           and "用户账号(key)" in t.missing_white())
        ck("有 secret+sign 就能提取",
           TQ.TianqiIP(secret="s", sign="g").configured is True)
        ck("只有 key+sign 不算能提取（getip 要的是 secret）",
           TQ.TianqiIP(key="k", sign="g").configured is False)

        # ====================================================== ③ extract 参数
        sec("③ extract 参数拼装（参数名错了就白花额度）")
        ROUTES[R_GETIP] = ok_extract()
        CALLS.clear()
        c = TQ.TianqiIP(secret="SEC", key="KEY", sign="SIGN", protocol=3, life=3)
        items, err = c.extract(num=1)
        url, p = CALLS[-1]
        ck("err 为 None 表示成功", err is None, err)
        ck("打到 /getip", url.endswith("/getip"), url)
        ck("secret 用了提取秘钥（不是 key）", p.get("secret") == "SEC", p.get("secret"))
        ck("sign 带上了", p.get("sign") == "SIGN")
        ck("★ time 必须带（按次提取的必填项）", p.get("time") == 3, p.get("time"))
        ck("port=3 表示要 SOCKS5", p.get("port") == 3, p.get("port"))
        ck("type=json（好解析）", p.get("type") == "json")
        ck("num 传了", p.get("num") == 1)
        ck("mr=1 去重", p.get("mr") == 1)
        ck("ts=1 要到期时间", p.get("ts") == 1)
        ck("cs=1 要位置 / ys=1 要运营商", p.get("cs") == 1 and p.get("ys") == 1)
        ck("没传 region 就不带这个参数", "region" not in p)
        ck("没传 yys 就不带这个参数", "yys" not in p)

        CALLS.clear()
        c.extract(num=9999)
        ck("num 超 200 被夹到 200（否则 1002）", CALLS[-1][1].get("num") == 200,
           CALLS[-1][1].get("num"))
        CALLS.clear()
        c.extract(num=0)
        ck("num=0 兜成 1", CALLS[-1][1].get("num") == 1)

        c2 = TQ.TianqiIP(secret="S", sign="G", life=99)
        ck("life 只允许 3/5/10/15，非法值兜回 3", c2.life == 3, c2.life)
        c3 = TQ.TianqiIP(secret="S", sign="G", life=10)
        ck("life=10 正常", c3.life == 10)
        CALLS.clear()
        TQ.TianqiIP(secret="S", sign="G", life=10, region="110,120", yys="电信").extract()
        p2 = CALLS[-1][1]
        ck("region 支持逗号多个", p2.get("region") == "110,120", p2.get("region"))
        ck("yys 传了运营商", p2.get("yys") == "电信")

        sec("③b 没配好时不发请求（避免无意义的 1003）")
        CALLS.clear()
        items, err = TQ.TianqiIP(secret="", sign="").extract()
        ck("直接报缺什么，且一次 HTTP 都没发",
           err and "缺" in err and not CALLS, (err, CALLS))

        # ====================================================== ④ 解析
        sec("④ 解析返回：字段 / URL 拼装 / 异常归一")
        ROUTES[R_GETIP] = ok_extract(ip="121.227.60.236", port=20252)
        c = TQ.TianqiIP(secret="S", sign="G", life=3)
        lease, err = c.extract_lease()
        ck("拿到 Lease", lease is not None and err is None, err)
        ck("ip/port 解析对", lease.ip == "121.227.60.236" and lease.port == 20252)
        ck("★ sock5 的 url 是 socks5h://（DNS 在代理侧解析）",
           lease.url == "socks5h://121.227.60.236:20252", lease.url)
        ck("归属地拼出来了", lease.where() == "辽宁鞍山 · 电信", lease.where())

        ck("port=1 → http://", TQ.TianqiIP(secret="S", sign="G", protocol=1)
           .extract_lease()[0].url.startswith("http://"))
        ck("port=2 → https://", TQ.TianqiIP(secret="S", sign="G", protocol=2)
           .extract_lease()[0].url.startswith("https://"))

        ROUTES[R_GETIP] = ok_extract()
        c4 = TQ.TianqiIP(secret="S", sign="G", auth_user="u", auth_pass="p")
        l4, _ = c4.extract_lease()
        ck("★ 账号密码模式：URL 里带上凭据（且不出现双 ://）",
           l4.url == "socks5h://u:p@1.2.3.4:1080", l4.url)

        # 单个 dict（不是 list）也要能吃
        ROUTES[R_GETIP] = lambda p: FakeResp(
            {"code": 1000, "data": {"ip": "9.9.9.9", "port": "80"}})
        it, err = c.extract()
        ck("data 给单个对象（不是数组）也能解析",
           err is None and len(it) == 1 and it[0]["ip"] == "9.9.9.9", (it, err))

        # 脏行被丢掉
        ROUTES[R_GETIP] = lambda p: FakeResp({"code": 1000, "data": [
            {"ip": "1.1.1.1", "port": "80"}, {"ip": "2.2.2.2"}, {"port": "80"},
            {"ip": "", "port": "80"}]})
        it, err = c.extract()
        ck("缺 ip 或缺 port 的脏行被丢掉，只留合法的",
           err is None and [x["ip"] for x in it] == ["1.1.1.1"], it)

        ROUTES[R_GETIP] = lambda p: FakeResp({"code": 1006, "msg": "暂无可用IP"})
        it, err = c.extract()
        ck("1006 → 人话里带「暂无可用」", it == [] and "暂无可用" in err, err)

        ROUTES[R_GETIP] = lambda p: FakeResp("<html>502 Bad Gateway</html>")
        it, err = c.extract()
        ck("返回的不是 JSON → 说清并附原文片段",
           it == [] and "不是 JSON" in err, err)

        def boom(p):
            raise ConnectionError("connection refused")
        ROUTES[R_GETIP] = boom
        it, err = c.extract()
        ck("网络异常被归一成人话（不是抛出去）",
           it == [] and "请求天启接口失败" in err, err)

        ROUTES[R_GETIP] = lambda p: FakeResp({"code": 1000, "data": []})
        it, err = c.extract()
        ck("code=1000 但没给 IP 也要报出来",
           it == [] and "没给出可用 IP" in err, err)

        # ====================================================== ⑤ 到期时间
        sec("⑤ 到期时间：能认就认，认不出按寿命算")
        now = int(time.time())
        ck("unix 秒", abs(TQ._parse_expire(now + 120) - (now + 120)) <= 2)
        ck("毫秒也能认", abs(TQ._parse_expire((now + 120) * 1000) - (now + 120)) <= 2)
        ck("日期字符串能认", TQ._parse_expire("2026-10-05 13:20:00") is not None)
        ck("认不出返回 None（交给寿命兜底）",
           TQ._parse_expire("随便写的") is None and TQ._parse_expire("") is None)

        ROUTES[R_GETIP] = ok_extract(expire=now + 90)
        l5, _ = c.extract_lease()
        ck("有 expire 就用它", abs(l5.left - 90) <= 3, l5.left)
        ROUTES[R_GETIP] = ok_extract()
        l6, _ = TQ.TianqiIP(secret="S", sign="G", life=5).extract_lease()
        ck("没给 expire → 按寿命算（5 分钟 ≈ 300s）", 290 <= l6.left <= 300, l6.left)
        ck("alive(need) 按剩余寿命判断",
           l6.alive(240) and not l6.alive(400))

        # ====================================================== ⑥ 白名单
        sec("⑥ 白名单：幂等 + 不重复添加 + 多个 IP 逗号拼")
        WL = {"ips": ["1.1.1.1", "2.2.2.2"]}
        ROUTES[R_FETCH] = lambda p: FakeResp({"code": 200, "data": list(WL["ips"])})
        ROUTES[R_ADD] = lambda p: (WL["ips"].extend(p["ip"].split(",")),
                                   FakeResp({"code": 200, "info": "操作成功"}))[1]
        ROUTES[R_DEL] = lambda p: FakeResp({"code": 200, "info": "操作成功"})

        cw = TQ.TianqiIP(key="KEY", sign="SIGN")
        ips, err = cw.white_fetch()
        ck("fetch 拿到列表", err is None and ips == ["1.1.1.1", "2.2.2.2"], (ips, err))

        CALLS.clear()
        ok, msg = cw.ensure_white("1.1.1.1")
        ck("已在白名单 → 不重复添加（只发了 fetch 一次）",
           ok and len(CALLS) == 1 and CALLS[0][0].endswith("/fetch"), CALLS)

        CALLS.clear()
        ok, msg = cw.ensure_white("3.3.3.3")
        ck("不在白名单 → 自动加",
           ok and any(u.endswith("/add") for u, _p in CALLS) and "3.3.3.3" in WL["ips"],
           (msg, WL["ips"]))

        CALLS.clear()
        ok, msg = cw.white_add(["4.4.4.4", "5.5.5.5"])
        ck("多个 IP 用逗号拼成一个参数",
           CALLS[-1][1].get("ip") == "4.4.4.4,5.5.5.5", CALLS[-1][1].get("ip"))
        ck("add 的 key/sign 带上了",
           CALLS[-1][1].get("key") == "KEY" and CALLS[-1][1].get("sign") == "SIGN")
        ck("brand 固定 2", CALLS[-1][1].get("brand") == 2)

        ROUTES[R_ADD] = lambda p: FakeResp({"code": 1007, "msg": "ip已存在"})
        ok, msg = cw.white_add("1.1.1.1")
        ck("★ 1007「IP 已存在」当成功（目标状态已达成）", ok is True, msg)

        ROUTES[R_ADD] = lambda p: FakeResp({"code": 1003, "msg": "密钥或签名不正确"})
        ok, msg = cw.white_add("9.9.9.9")
        ck("真出错要报出来（1003 → key/sign 错）", ok is False and "key" in msg, msg)

        ROUTES[R_FETCH] = lambda p: FakeResp({"code": 200, "data": "6.6.6.6,7.7.7.7"})
        ips, err = cw.white_fetch()
        ck("data 是逗号串也能解析", ips == ["6.6.6.6", "7.7.7.7"], ips)

        ck("没配 key 时 ensure_white 直接报缺什么",
           TQ.TianqiIP(sign="S").ensure_white("1.2.3.4")[1].find("key") >= 0)

        # ====================================================== ⑦ my_ip
        sec("⑦ 本机公网 IP：国内优先，失败会换下一个")
        ROUTES.clear()
        ROUTES["ip.3322.net/"] = lambda p: FakeResp("223.88.71.54")
        ip, err = TQ.my_ip(urls=["http://ip.3322.net/"])
        ck("从回显里提取出 IP", ip == "223.88.71.54" and err is None, (ip, err))

        seen = []

        def bad(p):
            seen.append(1)
            raise ConnectionError("nope")

        ROUTES["//a/"] = bad
        ROUTES["//b/"] = lambda p: FakeResp("10.0.0.1")
        ip, err = TQ.my_ip(urls=["http://a/x", "http://b/x"])
        ck("第一个站挂了会自动换下一个（不是直接放弃）",
           ip == "10.0.0.1" and len(seen) == 1, (ip, seen))

        ip, err = TQ.my_ip(urls=["http://nowhere-xyz/"])
        ck("全都失败 → 报错而不是返回空字符串", ip == "" and "查不到" in err, err)

        sec("⑦b 探测地址必须国内优先（这是踩过的坑）")
        ck("默认用的是 dewu_proxies.CHECK_URLS（单一事实来源）",
           TQ.my_ip.__doc__ and "国内" in TQ.my_ip.__doc__)
        ck("CHECK_URLS 第一个是国内站",
           PX.CHECK_URLS[0].startswith("http://ip.3322.net"), PX.CHECK_URLS[0])

        # ====================================================== ⑧ describe
        sec("⑧ 归属地短描述（账号后面要显示的就是它）")
        ck("省+市拼一起", TQ.describe({"prov": "辽宁", "city": "鞍山", "isp": "电信"})
           == "辽宁鞍山 · 电信", TQ.describe({"prov": "辽宁", "city": "鞍山", "isp": "电信"}))
        ck("省=市 时不重复", TQ.describe({"prov": "上海", "city": "上海"}) == "上海",
           TQ.describe({"prov": "上海", "city": "上海"}))
        ck("市已含省就不重复", TQ.describe({"prov": "辽宁", "city": "辽宁鞍山"}) == "辽宁鞍山",
           TQ.describe({"prov": "辽宁", "city": "辽宁鞍山"}))
        ck("只有运营商也行", TQ.describe({"isp": "移动"}) == "移动")
        ck("什么都没有 → 空串（界面别显示 None）", TQ.describe({}) == ""
           and TQ.describe(None) == "")

        # ====================================================== ⑨ 对接
        sec("⑨ 和 dewu_proxies 对接：提出来就能直接喂进代理池")
        ROUTES[R_GETIP] = ok_extract(ip="114.101.252.126", port=57577)
        px, err = TQ.TianqiIP(secret="S", sign="G").one_proxy(also_white=False)
        ck("one_proxy 不带白名单也能用（also_white=False）", err is None, err)
        ck("给了 url / ip / port / where",
           px["url"] == "socks5h://114.101.252.126:57577" and px["ip"] == "114.101.252.126"
           and px["where"] == "辽宁鞍山 · 电信", px)
        ck("给了 expire_at / left 好让界面显示倒计时", px["expire_at"] > time.time()
           and px["left"] > 0, (px["expire_at"], px["left"]))

        d, perr = PX.normalize_line(px["url"])
        ck("★ 能被 dewu_proxies.normalize_line 认出来", perr is None, perr)
        ck("解析出的 host/port 和提取的一致",
           d["host"] == "114.101.252.126" and d["port"] == 57577, d)
        ck("kind 判成 socks", d["kind"] == "socks", d)
        ck("免密（has_auth=False）—— 白名单模式下本来就该这样",
           d["has_auth"] is False, d)

        ROUTES[R_GETIP] = lambda p: FakeResp({"code": 1005, "msg": "套餐提取数量上限"})
        px, err = TQ.TianqiIP(secret="S", sign="G").one_proxy(also_white=False)
        ck("提取失败时 one_proxy 返回 None + 人话",
           px is None and "上限" in err, (px, err))

        sec("⑨b 一点到位的失败路径：白名单没弄好就不去提取（省额度）")
        ROUTES.clear()
        ROUTES[R_FETCH] = lambda p: FakeResp({"code": 1003, "msg": "密钥或签名不正确"})
        got = []
        ROUTES[R_GETIP] = lambda p: (got.append(1), FakeResp({"code": 1000, "data": []}))[1]
        px, err = TQ.TianqiIP(secret="S", key="K", sign="G").one_proxy()
        ck("白名单失败 → 直接返回，不浪费一次提取",
           px is None and not got and "白名单" in err, (err, got))

        sec("⑨c 调试辅助")
        ck("headers_get 会把 secret/sign 打码",
           "***" in TQ.headers_get({"secret": "abcdefghijklmn", "num": 1})
           and "abcdefghijklmn" not in TQ.headers_get({"secret": "abcdefghijklmn"}),
           TQ.headers_get({"secret": "abcdefghijklmn"}))

    finally:
        restore()

    print("\n" + "=" * 68)
    print("  通过 %d 项 / 失败 %d 项" % (PASS, FAIL))
    if FAILED:
        print("  失败清单：")
        for n in FAILED:
            print("    - %s" % n)
    print("=" * 68)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
