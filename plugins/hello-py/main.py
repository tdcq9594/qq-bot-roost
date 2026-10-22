"""
Python 插件示例
================
协议：stdin 读一行 JSON，stdout 写一行 JSON。就这么简单。

运行方式由 plugin.json 决定（runtime: python, entry: main.py），
核心会用 `python main.py` 启动这个文件，并保持长连接。

注意：
  - 只能用 print / sys.stdout 输出协议 JSON
  - 调试信息请写 sys.stderr（核心会当成插件日志收走）
"""

import json
import sys
import platform
import time

START = time.time()

# 核心在 init 里下发本插件的等级号段，这里存下来
BASE = 10


def send(obj):
    """往核心发一条协议消息"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(level, text):
    send({"t": "log", "level": level, "msg": text})


def on_init(payload):
    """核心启动时调用一次，必须回 ready"""
    global BASE
    BASE = payload.get("levels", {}).get("base", 10)

    send(
        {
            "t": "ready",
            # 想接收非命令消息就声明 listen（true = 全部消息）
            "listen": ["message"],
            "commands": [
                {"name": "hi", "pattern": "hi [名字]", "desc": "Python 插件打招呼"},
                {"name": "pyinfo", "desc": "显示 Python 运行时信息"},
                {
                    "name": "pyadmin",
                    "desc": "只有本插件管理员能用",
                    "pattern": "pyadmin",
                },
            ],
            "menus": [
                {
                    "title": "玩法",
                    "items": [
                        {"text": "py 你好", "desc": "不用加前缀，直接说也能触发"},
                    ],
                }
            ],
            # 本插件自定义的等级：BASE 是号段起点，数字越小权限越高
            "levels": [
                {"name": "管理员", "level": BASE},
                {"name": "普通玩家", "level": BASE + 2},
            ],
        }
    )


def on_msg(payload):
    """处理一条消息，必须回 handled"""
    seq = payload["seq"]
    msg = payload["msg"]
    content = (msg.get("content") or "").strip()
    command = msg.get("command") or ""
    args = msg.get("args") or []
    level = msg.get("level", 9999)
    name = msg.get("name") or msg.get("user", "")[:8]

    def reply(text):
        send({"t": "reply", "seq": seq, "text": text})

    if command == "hi":
        who = args[0] if args else name
        reply(f"你好，{who}！我是跑在 Python {platform.python_version()} 里的插件。")

    elif command == "pyinfo":
        up = int(time.time() - START)
        reply(
            f"Python {platform.python_version()}\n"
            f"系统: {platform.system()} {platform.release()}\n"
            f"已运行: {up} 秒\n"
            f"我的等级号段起点: {BASE}\n"
            f"你的等级: {level}"
        )

    elif command == "pyadmin":
        # 只有等级 <= BASE 的人能用（数字越小权限越高）
        if level <= BASE:
            reply("管理员命令执行成功。")
        else:
            reply(f"需要本插件管理员权限（等级 {BASE}），你当前是 {level}。")

    elif content in ("py 你好", "py你好"):
        # 被动触发：不用加前缀
        reply(f"收到！{name}，Python 插件在线。")

    # 无论处理与否，都要回 handled，否则核心会等到超时
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
