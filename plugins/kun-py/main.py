"""
养鲲（Python 版）
==================
演示外部插件怎么在 Python 里做一个带存档的游戏。

和 JS 内建版的区别：
  - 内建插件用 ctx.storage，框架帮你管一个 JSON
  - 外部插件没有 storage 协议，但 init 会下发 dataDir，
    你在那个目录里想存什么格式都行（这里用 JSON）

命令名在框架里是全局唯一的，两个插件不能都注册 `kun`，
所以这个版本统一用 py 前缀。

协议：stdin 读一行 JSON，stdout 写一行 JSON。
调试信息写 stderr（会被收进插件日志）。
"""

import json
import os
import random
import sys
import time

# 核心在 init 里下发：数据目录、配置、等级号段
DATA_DIR = None
CONFIG = {}
BASE = 10

# 品种池：稀有度 → (权重, 成长系数, 名字列表)
SPECIES = {
    "普通": (60, 1.0, ["尘鲲", "土鲲", "沙鲲", "石鲲", "岩鲲", "菜虚鲲", "胖头鲲"]),
    "稀有": (28, 1.15, ["碧鲲", "蓝鲲", "橙鲲", "雪鲲", "虹鲲", "阳鲲", "靓鲲"]),
    "史诗": (10, 1.35, ["炎鲲", "冰鲲", "雷鲲", "铁头鲲", "钢背鲲", "剑鲲", "齿鲲", "铠鲲"]),
    "传说": (2, 1.6, ["帝鲲", "圣鲲", "灵鲲", "冥鲲", "玄鲲", "魔鲲", "鬼鲲", "妖鲲", "尸鲲"]),
}


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(level, text):
    send({"t": "log", "level": level, "msg": text})


# ---------------- 存档 ----------------

def store_path():
    """dataDir 是核心下发的插件专属目录，按机器人隔离"""
    if not DATA_DIR:
        return None
    return os.path.join(DATA_DIR, "players.json")


def load_all():
    p = store_path()
    if not p or not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log("warn", f"存档读取失败，按空档处理: {e}")
        return {}


def save_all(data):
    p = store_path()
    if not p:
        return
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)  # 原子替换，避免写一半崩了留个坏文件
    except Exception as e:
        log("error", f"存档写入失败: {e}")


def fresh(uid, name):
    return {
        "name": name or uid[:8],
        "species": "未孵化",
        "rarity": "—",
        "weight": 1.0,
        "points": 100,
        "eggs": 1,
        "lastSign": "",
        "bornAt": int(time.time() * 1000),
    }


def roll_species():
    pool = []
    for rarity, (w, _grow, names) in SPECIES.items():
        for _ in range(w):
            for n in names:
                pool.append((n, rarity))
    return random.choice(pool)


def grow_of(rarity):
    return SPECIES.get(rarity, (0, 1.0, []))[1]


def today():
    return time.strftime("%Y-%m-%d")


# ---------------- 命令 ----------------

def cmd_kun(uid, name, reply):
    data = load_all()
    p = data.get(uid)
    if not p:
        p = fresh(uid, name)
        data[uid] = p
        save_all(data)
    if p["species"] == "未孵化":
        reply(f"{p['name']} 还没有鲲，有 {p['eggs']} 颗蛋。发 /pyhatch 开局。\n节操 {p['points']}")
    else:
        reply(
            f"{p['name']} 的鲲\n"
            f"【{p['species']}】{p['rarity']} · {p['weight']:.1f} 千克\n"
            f"节操 {p['points']} · 蛋 {p['eggs']} 颗"
        )


def cmd_sign(uid, name, reply):
    data = load_all()
    p = data.setdefault(uid, fresh(uid, name))
    d = today()
    if p["lastSign"] == d:
        return reply("今天已经签过了，明天再来。")
    gain = random.randint(40, 80)
    p["points"] += gain
    p["lastSign"] = d
    extra = ""
    if random.random() < 0.35:
        p["eggs"] += 1
        extra = "\n还捡到一颗蛋。"
    save_all(data)
    reply(f"签到成功，节操 +{gain}{extra}\n当前节操 {p['points']}")


def cmd_hatch(uid, name, reply):
    data = load_all()
    p = data.setdefault(uid, fresh(uid, name))
    if p["eggs"] < 1:
        return reply("你没有蛋。发 /pybuy 买一颗，或者等签到捡。")
    sp, rarity = roll_species()
    p["eggs"] -= 1
    p["species"] = sp
    p["rarity"] = rarity
    p["weight"] = 1.0 if p["weight"] <= 1 else max(1.0, round(p["weight"] * 0.5, 1))
    save_all(data)
    reply(f"蛋裂开了——是【{sp}】！稀有度：{rarity}\n新鲲起步 {p['weight']:.1f} 千克。")


def cmd_buy(uid, name, reply):
    price = int(CONFIG.get("买蛋价", 80))
    data = load_all()
    p = data.setdefault(uid, fresh(uid, name))
    if p["points"] < price:
        return reply(f"节操不够，还差 {price - p['points']}。发 /pysign 去赚。")
    p["points"] -= price
    p["eggs"] += 1
    save_all(data)
    reply(f"买到一颗蛋，现在有 {p['eggs']} 颗。发 /pyhatch 试试手气。")


def cmd_feed(uid, name, reply):
    price = int(CONFIG.get("喂食价", 20))
    data = load_all()
    p = data.setdefault(uid, fresh(uid, name))
    if p["species"] == "未孵化":
        return reply("还没有鲲。先发 /pyhatch 开局。")
    if p["points"] < price:
        return reply(f"节操不够，还差 {price - p['points']}。")
    add = (2 + random.random() * 4) * grow_of(p["rarity"])
    p["points"] -= price
    p["weight"] += add
    save_all(data)
    reply(f"喂了一顿，体重 +{add:.1f} 千克\n现在 {p['weight']:.1f} 千克，剩 {p['points']} 节操。")


def cmd_rank(uid, name, reply):
    data = load_all()
    rows = [v for v in data.values() if v.get("species") and v["species"] != "未孵化"]
    rows.sort(key=lambda x: x["weight"], reverse=True)
    if not rows:
        return reply("还没有人养鲲。发 /pykun 开局。")
    lines = [
        f"{i + 1}. {r['name']} · {r['species']} · {r['weight']:.1f} 千克"
        for i, r in enumerate(rows[:5])
    ]
    reply("鲲榜（Python 版）\n" + "\n".join(lines))


COMMANDS = {
    "pykun": cmd_kun,
    "pysign": cmd_sign,
    "pyhatch": cmd_hatch,
    "pybuy": cmd_buy,
    "pyfeed": cmd_feed,
    "pyrank": cmd_rank,
}


def on_init(payload):
    global DATA_DIR, CONFIG, BASE
    DATA_DIR = payload.get("dataDir")
    CONFIG = payload.get("config") or {}
    BASE = (payload.get("levels") or {}).get("base", 10)

    if not DATA_DIR:
        log("warn", "核心没有下发 dataDir，这个插件将无法存档")

    send(
        {
            "t": "ready",
            "listen": [],
            "commands": [
                {"name": "pykun", "desc": "看看我的鲲（Python 版）"},
                {"name": "pysign", "desc": "每日签到领节操"},
                {"name": "pyhatch", "desc": "孵一颗蛋"},
                {"name": "pybuy", "desc": f"花 {CONFIG.get('买蛋价', 80)} 节操买蛋"},
                {"name": "pyfeed", "desc": f"花 {CONFIG.get('喂食价', 20)} 节操喂食"},
                {"name": "pyrank", "desc": "体重排行前 5"},
            ],
            "menus": [
                {
                    "title": "Python 版养鲲",
                    "items": [
                        {"text": "pykun", "desc": "查看自己的鲲"},
                        {"text": "pysign", "desc": "每天一次，赚节操和蛋"},
                    ],
                }
            ],
            "levels": [{"name": "管理员", "level": BASE}],
        }
    )


def on_msg(payload):
    seq = payload["seq"]
    msg = payload.get("msg") or {}
    uid = msg.get("user") or ""
    name = msg.get("name") or uid[:8]
    command = (msg.get("command") or "").lower()

    def reply(text):
        send({"t": "reply", "seq": seq, "text": text})

    fn = COMMANDS.get(command)
    if fn:
        fn(uid, name, reply)

    # 无论处理与否都要回 handled，否则核心会等到超时
    send({"t": "handled", "seq": seq})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            log("warn", f"收到无法解析的输入: {line[:80]}")
            continue

        t = payload.get("t")
        try:
            if t == "init":
                on_init(payload)
            elif t == "msg":
                on_msg(payload)
            elif t == "shutdown":
                break
        except Exception as e:  # 单条出错不能拖垮进程
            log("error", f"处理 {t} 出错: {e}")
            if t == "msg" and "seq" in payload:
                send({"t": "handled", "seq": payload["seq"]})


if __name__ == "__main__":
    main()
