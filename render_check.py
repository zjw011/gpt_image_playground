# -*- coding: utf-8 -*-
"""离线渲染检查: 在多种屏幕/窗口尺寸下截图, 验证布局与滚动兜底"""
import os
import sys

os.environ.setdefault("DEWU_NO_BROWSER", "1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6.QtWidgets import QApplication, QTableWidgetItem  # noqa: E402
import dewu_gui as G  # noqa: E402

OUT = os.path.dirname(os.path.abspath(__file__))

app = QApplication(sys.argv)
app.setStyle("Fusion")
app.setStyleSheet(G.GLOBAL_QSS)
ic = G.app_icon()
if not ic.isNull():
    app.setWindowIcon(ic)

w = G.MainWindow()
w.show()
app.processEvents()

# 填入示例数据, 让截图更接近真实
for i in range(2):
    w.tbl_acct.insertRow(i)
    for c, v in enumerate([["222", "333"][i], "49", "正常", "10:30:58"]):
        w.tbl_acct.setItem(i, c, QTableWidgetItem(v))
NAMES = ["馒头 氨基酸控油祛痘洗面奶", "联名款限定马克杯 500ml", "机械键盘 87 键 客制化",
         "蓝牙耳机 半入耳式", "桌面收纳盒 亚克力", "纯棉短袖 T 恤 白色 L",
         "保温杯 316 不锈钢", "充电宝 20000mAh", "运动水壶 750ml",
         "帆布袋 加厚款", "手机支架 铝合金", "雨伞 全自动折叠"]
for i, n in enumerate(NAMES):
    w.tbl_prize.insertRow(i)
    for c, v in enumerate([str(i + 1), n, "50", "20", "可兑换"]):
        it = QTableWidgetItem(v)
        w.tbl_prize.setItem(i, c, it)
app.processEvents()
w._fit_acct_height(2)
app.processEvents()

CASES = [(1400, 940), (1280, 693), (1177, 637), (1092, 582), (1010, 566)]
for cw, ch in CASES:
    w.resize(cw, ch)
    app.processEvents()
    app.processEvents()
    w.grab().save(os.path.join(OUT, "render_%dx%d.png" % (cw, ch)))
    print("请求 %4dx%-4d -> 实际 %4dx%-4d  横滚动=%s 竖滚动=%s" % (
        cw, ch, w.size().width(), w.size().height(),
        "需要" if w.scroll.horizontalScrollBar().maximum() > 0 else "无",
        "需要" if w.scroll.verticalScrollBar().maximum() > 0 else "无",
    ))
    qs = [w.tbl_prize.height(), w.tbl_acct.height(),
          w.scroll.verticalScrollBar().maximum()]
    print("        商品表=%d 账号表=%d 竖滚动量=%d" % tuple(qs))

# 收起账号区后的笔记本形态
w.resize(1092, 582)
w._set_acct_collapsed(True, persist=False)
app.processEvents()
app.processEvents()
w.grab().save(os.path.join(OUT, "render_1092x582_collapsed.png"))
print("收起账号区 -> 竖滚动=%s 量=%d 商品表=%d" % (
    "需要" if w.scroll.verticalScrollBar().maximum() > 0 else "无",
    w.scroll.verticalScrollBar().maximum(), w.tbl_prize.height()))
print("done")
