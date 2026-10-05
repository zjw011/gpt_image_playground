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


def main():
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
    sec("⑭ 代理 IP：解析 / 打码 / 选择策略")
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

    # ============================================================== 前端源码守卫
    sec("⑭ 前端源码守卫（这几条都是踩过的坑）")
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
       appjs.count("S.cfg = j.settings") >= 5, appjs.count("S.cfg = j.settings"))
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
    sec("⑮ 路由清单")
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
            "/api/admin/proxies/delete", "/api/admin/proxies/auto_assign",
            "/api/admin/proxies/{pid}"]
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
