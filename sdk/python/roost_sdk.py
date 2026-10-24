#!/usr/bin/env python3
"""
栖 Roost 外部插件 SDK（Python，单文件）
=====================================

不装包、不建虚拟环境，把这个文件拷到你的插件目录就能用：

    plugins/my-plugin/
    ├── plugin.json
    ├── roost_sdk.py     ← 这个文件
    └── main.py

main.py：

    from roost_sdk import Plugin

    p = Plugin(id='my-plugin', name='我的插件', version='1.0.0')

    @p.command('hello [名字]', desc='打个招呼')
    def hello(m):
        m.reply(f'你好，{m.args[0] if m.args else m.name}')

    if __name__ == '__main__':
        p.run()

协议本身很简单（NDJSON，一行一个 JSON），SDK 只是把它包成顺手的样子。
调试输出请用 stderr——stdout 只能写协议消息。
"""
from __future__ import annotations

import json
import sys
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


def _send(obj: Dict[str, Any]) -> None:
    """往 stdout 写一行 JSON。必须 flush，否则核心会一直等"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


@dataclass
class Msg:
    """收到的一条消息"""

    seq: int
    id: str = ""
    kind: str = ""
    group: str = ""
    user: str = ""
    name: str = ""
    content: str = ""
    command: str = ""
    args: List[str] = field(default_factory=list)
    is_command: bool = False
    mentioned: bool = False
    at: int = 0
    raw: Dict[str, Any] = field(default_factory=dict)

    def reply(self, text: str) -> None:
        """被动回复（可以连发多条，核心会合并/分段）"""
        _send({"t": "reply", "seq": self.seq, "text": str(text)})

    def reply_image(self, url: str) -> None:
        _send({"t": "reply", "seq": self.seq, "image": str(url)})

    def push(self, text: str) -> None:
        """主动推送（不带 msg_id，受每日额度限制）"""
        _send({"t": "push", "seq": self.seq, "text": str(text)})

    def log(self, level: str, text: str) -> None:
        _send({"t": "log", "level": level, "msg": str(text)})


class Plugin:
    """
    插件主体。装饰器注册命令和监听，run() 进主循环。
    """

    def __init__(
        self,
        id: str,
        name: Optional[str] = None,
        version: str = "0.0.0",
        config: Optional[Dict[str, Any]] = None,
        levels: Optional[List[str]] = None,
    ) -> None:
        self.id = id
        self.name = name or id
        self.version = version
        self.config = config or {}
        self.levels = levels or []
        self._commands: Dict[str, Dict[str, Any]] = {}
        self._menus: List[Dict[str, Any]] = []
        self._listeners: List[Callable[[Msg], Any]] = []

    # ---------------- 注册 ----------------

    def command(self, pattern: str, desc: str = "", alias: Optional[List[str]] = None):
        """@p.command('hello [名字]', desc='打个招呼')"""

        def deco(fn: Callable[[Msg], Any]):
            name = pattern.strip().split()[0]
            self._commands[name] = {"pattern": pattern, "desc": desc, "fn": fn}
            for a in alias or []:
                self._commands[a] = {"pattern": pattern, "desc": desc, "fn": fn}
            return fn

        return deco

    def on_message(self, fn: Callable[[Msg], Any]):
        """被动监听：返回 True 表示「这条我处理了」"""
        self._listeners.append(fn)
        return fn

    def menu(self, title: str, items: List[Dict[str, str]]) -> None:
        """往 /help 菜单里加一组"""
        self._menus.append({"title": title, "items": items})

    # ---------------- 运行 ----------------

    def run(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                self._log("warn", f"收到无法解析的行：{line[:120]}")
                continue

            t = obj.get("t")
            if t == "init":
                # 核心下发的运行信息（配置、机器人信息等）
                if isinstance(obj.get("config"), dict):
                    self.config.update(obj["config"])
                self._ready()
            elif t == "msg":
                self._handle(obj)
            elif t == "shutdown":
                break

    def _ready(self) -> None:
        _send(
            {
                "t": "ready",
                "id": self.id,
                "name": self.name,
                "version": self.version,
                "commands": [
                    {"name": k, "desc": v["desc"], "pattern": v["pattern"]}
                    for k, v in self._commands.items()
                ],
                "menus": self._menus,
                "levels": self.levels,
            }
        )

    def _handle(self, obj: Dict[str, Any]) -> None:
        seq = obj.get("seq", 0)
        raw = obj.get("msg") or {}
        m = Msg(
            seq=seq,
            id=raw.get("id", ""),
            kind=raw.get("kind", ""),
            group=raw.get("group", ""),
            user=raw.get("user", ""),
            name=raw.get("name", ""),
            content=raw.get("content", ""),
            command=raw.get("command", ""),
            args=raw.get("args") or [],
            is_command=bool(raw.get("isCommand")),
            mentioned=bool(raw.get("mentioned")),
            at=raw.get("at", 0),
            raw=raw,
        )

        try:
            handled = False
            if m.is_command and m.command in self._commands:
                self._commands[m.command]["fn"](m)
                handled = True
            else:
                for fn in self._listeners:
                    if fn(m) is True:
                        handled = True
                        break
            if handled:
                _send({"t": "handled", "seq": seq})
        except Exception:
            # 异常一定要回给核心，否则它只能等超时
            self._log("error", traceback.format_exc(limit=3))
            _send({"t": "error", "seq": seq, "msg": "插件处理消息时出错，详见日志"})

    def _log(self, level: str, text: str) -> None:
        _send({"t": "log", "level": level, "msg": str(text)})
