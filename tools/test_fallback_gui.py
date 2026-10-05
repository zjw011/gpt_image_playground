# -*- coding: utf-8 -*-
"""自动降级的界面回归测试（离屏跑，不联网、不碰真实 config.json）。

盯住:
  1. 「降级设置」按钮的两态文案
  2. 弹窗控件: 总开关 · 三个触发勾 · 价格门槛下拉 · 保存/取消
  3. 回显当前配置、保存时 5 个参数一起写回
  4. 保存后同步「失效自动降级」勾选框
  5. 任务表格: 降级后的商品要带「（降级）」并标橙色，鼠标停上去能看见原配置
  6. 接线守卫: 03 有勾选框 / add_task 会传 fallback

跑法: python tools/test_fallback_gui.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

OK, BAD = [], []


def chk(name, cond, extra=""):
    (OK if cond else BAD).append(name)
    print("  %s %s%s" % ("[PASS]" if cond else "[FAIL]", name,
                         ("  " + str(extra)) if extra else ""))


class FakeBtn(object):
    def __init__(self):
        self._t = ""
        self._tip = ""

    def text(self):
        return self._t

    def setText(self, s):
        self._t = s

    def toolTip(self):
        return self._tip

    def setToolTip(self, s):
        self._tip = s


DEFAULT_FB = {"enabled": True, "on_gone": True, "on_soldout": True,
              "on_poor": False, "min_ratio": 0.0}


class FakeM(object):
    def __init__(self):
        self.fb = dict(DEFAULT_FB)
        self.saved = []
        self.logs = []

    def fb_cfg(self):
        return dict(self.fb)

    def fb_save_cfg(self, **kw):
        kw = {k: v for k, v in kw.items() if v is not None}
        self.saved.append(kw)
        self.fb.update(kw)
        return dict(self.fb)

    def log(self, s):
        self.logs.append(str(s))


MSGLOG = []


class FakeMB(object):
    Yes, No = 1, 0

    @staticmethod
    def information(*a, **k):
        MSGLOG.append(("info", a[1] if len(a) > 1 else ""))

    @staticmethod
    def warning(*a, **k):
        MSGLOG.append(("warn", a[1] if len(a) > 1 else ""))

    @staticmethod
    def question(*a, **k):
        return 1


import dewu_gui as G  # noqa: E402
from PySide6.QtCore import Qt, QTimer  # noqa: E402
from PySide6.QtWidgets import (  # noqa: E402
    QApplication, QWidget, QDialog, QLabel, QCheckBox, QComboBox,
    QPushButton, QTableWidget,
)

app = QApplication.instance() or QApplication([])

real_M, real_MB = G.M, G.QMessageBox
fakeM = FakeM()
G.M = fakeM
G.QMessageBox = FakeMB


class StubWin(QWidget):
    """冒充 MainWindow: 挂上待测方法，绕开真实 __init__。"""

    def __init__(self):
        super().__init__()
        self.btn_fb = FakeBtn()

        class FakeChk(object):
            def __init__(self):
                self._c = False

            def setChecked(self, v):
                self._c = bool(v)

            def isChecked(self):
                return self._c

        self.chk_fb = FakeChk()


StubWin._refresh_fb_btn = G.MainWindow._refresh_fb_btn
StubWin.fallback_settings = G.MainWindow.fallback_settings

win = StubWin()


def find_dlg():
    for w in QApplication.topLevelWidgets():
        if isinstance(w, QDialog) and "自动降级设置" in w.windowTitle() and w.isVisible():
            return w
    return None


def btn(dlg, text):
    return next((b for b in dlg.findChildren(QPushButton) if b.text() == text), None)


def chkbox(dlg, text):
    return next((c for c in dlg.findChildren(QCheckBox) if c.text() == text), None)


# ---------------- 1. 按钮两态 ----------------
print("== 1. 「降级设置」按钮文案 ==")
fakeM.fb = dict(DEFAULT_FB)
win._refresh_fb_btn()
chk("开着 -> 「降级设置 · 开」", win.btn_fb.text() == "降级设置 · 开", win.btn_fb.text())
chk("tooltip 列出三类触发", all(k in win.btn_fb.toolTip()
                                for k in ("下架就换", "抢不到也换", "买不起也换")),
    win.btn_fb.toolTip()[:80])
chk("tooltip 写明门槛", "不设门槛" in win.btn_fb.toolTip(), win.btn_fb.toolTip())

fakeM.fb = dict(DEFAULT_FB, enabled=False)
win._refresh_fb_btn()
chk("关着 -> 「降级设置 · 关」", win.btn_fb.text() == "降级设置 · 关", win.btn_fb.text())
chk("关着时 tooltip 说明行为", "按失败停手" in win.btn_fb.toolTip(), win.btn_fb.toolTip())

fakeM.fb = dict(DEFAULT_FB, min_ratio=0.5)
win._refresh_fb_btn()
chk("门槛 0.5 -> tooltip 写「不低于原价一半」",
    "不低于原价一半" in win.btn_fb.toolTip(), win.btn_fb.toolTip())

# ---------------- 2. 弹窗控件 ----------------
print("\n== 2. 弹窗控件与回显 ==")
res = {}
res["err"] = None
fakeM.fb = dict(DEFAULT_FB, on_poor=True, min_ratio=0.8)


def step2():
    d = find_dlg()
    if d is None:
        res["err"] = "弹窗没弹出来"
        return
    res["dlg"] = d
    res["labels"] = [l.text() for l in d.findChildren(QLabel)]
    res["chk_texts"] = [c.text() for c in d.findChildren(QCheckBox)]
    res["chk_state"] = {c.text(): c.isChecked() for c in d.findChildren(QCheckBox)}
    res["combos"] = [(c.currentText(), c.currentData()) for c in d.findChildren(QComboBox)]
    res["btns"] = [b.text() for b in d.findChildren(QPushButton)]
    QTimer.singleShot(60, step3)


def step3():
    d = res["dlg"]
    # 改一改：关掉「抢不到也换」、门槛改成一半，保存
    chkbox(d, "抢不到也换").setChecked(False)
    d.findChildren(QComboBox)[0].setCurrentIndex(1)      # 不低于原价 50%
    res["summary_before_save"] = [l.text() for l in d.findChildren(QLabel)]
    ok = btn(d, "保存")
    res["btn_ok"] = ok is not None
    if ok is not None:
        ok.click()
    else:
        d.reject()


QTimer.singleShot(320, step2)
win.fallback_settings()

chk("弹窗成功打开并走完", res.get("err") is None and res.get("dlg") is not None,
    res.get("err"))
chk("有 4 个勾选框（总开关 + 三个触发）",
    res.get("chk_texts") == ["启用自动降级（新建任务默认勾上）", "商品下架就换",
                             "抢不到也换", "余额买不起也换"], res.get("chk_texts"))
st = res.get("chk_state") or {}
chk("回显: 总开关=开", st.get("启用自动降级（新建任务默认勾上）") is True)
chk("回显: 下架就换=开", st.get("商品下架就换") is True)
chk("回显: 抢不到也换=开", st.get("抢不到也换") is True)
chk("回显: 买不起也换=开（配置里是 True）", st.get("余额买不起也换") is True)
_cb = (res.get("dlg").findChildren(QComboBox) if res.get("dlg") else [])
chk("门槛下拉有 3 档预设", len(_cb) == 1 and _cb[0].count() == 3,
    [_cb[0].itemText(i) for i in range(_cb[0].count())] if _cb else None)
chk("回显: 门槛选中「不低于原价 80%」",
    (res.get("combos") or [("", None)])[0][1] == 0.8, res.get("combos"))
for t in ("保存", "取消"):
    chk("按钮存在: %s" % t, t in (res.get("btns") or []), res.get("btns"))

joined = " | ".join(res.get("labels") or [])
chk("弹窗里讲清了挑替代品的规则",
    all(k in joined for k in ("挑最贵的", "有货", "列表顺序第一个")), joined[:120])
chk("弹窗里给了 110 换 108 的例子", "110" in joined and "108" in joined)
chk("弹窗里提醒了会花掉金币", "把金币花出去" in joined)
chk("弹窗里说明了最多降级一次", "最多降级一次" in joined)

# ---------------- 3. 保存 ----------------
print("\n== 3. 保存 ==")
saved = fakeM.saved[-1] if fakeM.saved else {}
chk("一次性写回 5 个参数",
    set(saved) == {"enabled", "on_gone", "on_soldout", "on_poor", "min_ratio"}, saved)
chk("勾掉的「抢不到也换」写成 False", saved.get("on_soldout") is False)
chk("门槛写成 0.5", saved.get("min_ratio") == 0.5, saved.get("min_ratio"))
chk("没动的项保持原样", saved.get("on_gone") is True and saved.get("on_poor") is True)
chk("弹窗已关闭", find_dlg() is None)
chk("同步了 03 的勾选框", win.chk_fb.isChecked() is True)
chk("按钮文案刷新为「开」", win.btn_fb.text() == "降级设置 · 开", win.btn_fb.text())
chk("日志留痕", any("[降级]" in x for x in fakeM.logs), fakeM.logs[-1:])

# ---------------- 4. 关掉总开关 ----------------
print("\n== 4. 关掉总开关 ==")
fakeM.saved.clear()
res2 = {}


def step_b():
    d = find_dlg()
    if d is None:
        res2["err"] = "第二次弹窗没弹出来"
        return
    res2["dlg"] = d
    chkbox(d, "启用自动降级（新建任务默认勾上）").setChecked(False)
    ok = btn(d, "保存")
    if ok is not None:
        ok.click()
    else:
        d.reject()


QTimer.singleShot(320, step_b)
win.fallback_settings()
chk("第二次弹窗正常", res2.get("err") is None, res2.get("err"))
chk("enabled 写成 False", fakeM.saved[-1].get("enabled") is False, fakeM.saved[-1])
chk("03 的勾选框跟着取消", win.chk_fb.isChecked() is False)
chk("按钮文案刷新为「关」", win.btn_fb.text() == "降级设置 · 关", win.btn_fb.text())

# ---------------- 5. 任务表格上的降级标记 ----------------
print("\n== 5. 任务表格显示降级 ==")


class TableWin(QWidget):
    def __init__(self):
        super().__init__()
        self.tbl_task = QTableWidget(0, 6)
        self.tbl_task.setColumnCount(6)
        self.lbl_task_summary = QLabel("")
        self._task_sig = None


TableWin._sync_task_table = G.MainWindow._sync_task_table
TableWin._task_detail = staticmethod(G.MainWindow._task_detail)
tw = TableWin()


def mk(cid, name, fell=False, orig=None):
    t = {"id": 1, "account_name": "账号1", "time": "10:00:00", "status": "成功",
         "detail": "第 1 次尝试成功", "attempts": 1,
         "prize": {"cId": cid, "cName": name, "cost": 108}}
    if fell:
        t["_fell_back"] = True
        t["_orig_prize"] = {"cId": 111, "cName": orig or "音箱", "cost": 120}
    return t


tw._sync_task_table([mk(902, "咖啡券")])
chk("没降级 -> 商品列就是商品名", tw.tbl_task.item(0, 2).text() == "咖啡券",
    tw.tbl_task.item(0, 2).text())

tw._task_sig = None
tw._sync_task_table([mk(902, "咖啡券", fell=True)])
chk("★ 降级后 -> 商品列带「降级·」前缀（前缀不会被省略号吃掉）",
    tw.tbl_task.item(0, 2).text() == "降级·咖啡券", tw.tbl_task.item(0, 2).text())
chk("★ 鼠标停上去能看到原配置",
    "原配置" in tw.tbl_task.item(0, 2).toolTip()
    and "音箱" in tw.tbl_task.item(0, 2).toolTip(),
    tw.tbl_task.item(0, 2).toolTip())
chk("降级用橙色标出来（不是普通蓝）",
    tw.tbl_task.item(0, 2).foreground().color().name().lower() == G.C_WARN.lower(),
    tw.tbl_task.item(0, 2).foreground().color().name())

tw._task_sig = None
tw._sync_task_table([mk(902, "咖啡券", fell=True)])
tw._sync_task_table([mk(902, "咖啡券", fell=True)])
chk("状态没变 -> 不重建表格（指纹里带了 _fell_back）", tw.tbl_task.item(0, 2).text()
    == "降级·咖啡券")

tw._task_sig = None
tw._sync_task_table([mk(902, "咖啡券", fell=True)])
chk("详情列补了一句「已降级换商品」（失败时也能看见）",
    "已降级换商品" in tw.tbl_task.item(0, 5).text(), tw.tbl_task.item(0, 5).text())

# ---------------- 6. 接线守卫 ----------------
print("\n== 6. 接线守卫（防止以后被改断） ==")
src = open(os.path.join(ROOT, "dewu_gui.py"), encoding="utf-8").read()
chk("03 里有「失效自动降级」勾选框", 'self.chk_fb = QCheckBox("失效自动降级")' in src)
chk("勾选框默认读全局策略", 'self.chk_fb.setChecked(bool(M.fb_cfg()["enabled"]))' in src)
chk("勾选框挂在了 03 那一行", "g.addWidget(self.chk_fb, 0, Qt.AlignBottom)" in src)
chk("有「降级设置」按钮并接线", 'self.btn_fb.clicked.connect(self.fallback_settings)' in src)
chk("add_task 会把勾选状态传下去", '"fallback": self.chk_fb.isChecked(),' in src)
chk("__init__ 里刷新按钮文案", "        self._refresh_fb_btn()\n" in src)
chk("表格给降级商品加前缀标记（不是后缀，后缀会被省略号吃掉）",
    'pname = "降级·" + pname' in src)
chk("表格用 C_WARN 标色", "QColor(C_WARN if t.get(\"_fell_back\") else C_ACC_DK)" in src)
chk("指纹里带了 _fell_back（否则表格不会刷新）",
    't.get("_fell_back"), t["prize"]["cName"],' in src)

G.M, G.QMessageBox = real_M, real_MB

print("\n" + "=" * 46)
print("通过 %d 项, 失败 %d 项" % (len(OK), len(BAD)))
if BAD:
    print("失败:")
    for b in BAD:
        print("  -", b)
sys.exit(1 if BAD else 0)
