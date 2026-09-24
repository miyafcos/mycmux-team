"""Read native window geometry for an isolated mycmux performance profile."""

from __future__ import annotations

import ctypes
import json
import sys
from ctypes import wintypes


user32 = ctypes.WinDLL("user32", use_last_error=True)
EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


class Rect(ctypes.Structure):
    _fields_ = [(name, ctypes.c_long) for name in ("left", "top", "right", "bottom")]


class Point(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


user32.EnumWindows.argtypes = [EnumProc, wintypes.LPARAM]
user32.EnumChildWindows.argtypes = [wintypes.HWND, EnumProc, wintypes.LPARAM]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(Rect)]
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(Rect)]
user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(Point)]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetDpiForWindow.argtypes = [wintypes.HWND]


def window_info(hwnd: int) -> dict[str, object]:
    rect = Rect()
    client = Rect()
    origin = Point()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    user32.GetClientRect(hwnd, ctypes.byref(client))
    user32.ClientToScreen(hwnd, ctypes.byref(origin))
    class_name = ctypes.create_unicode_buffer(256)
    title = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, class_name, len(class_name))
    user32.GetWindowTextW(hwnd, title, len(title))
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return {
        "hwnd": hwnd,
        "pid": pid.value,
        "class": class_name.value,
        "title": title.value,
        "visible": bool(user32.IsWindowVisible(hwnd)),
        "rect": [rect.left, rect.top, rect.right, rect.bottom],
        "clientOrigin": [origin.x, origin.y],
        "clientSize": [client.right - client.left, client.bottom - client.top],
        "dpi": user32.GetDpiForWindow(hwnd),
    }


def main() -> None:
    pid = int(sys.argv[1])
    windows: list[dict[str, object]] = []

    def inspect(hwnd: int, _unused: int) -> bool:
        info = window_info(hwnd)
        if info["pid"] != pid or not info["visible"]:
            return True
        children: list[dict[str, object]] = []

        def inspect_child(child: int, _child_unused: int) -> bool:
            child_info = window_info(child)
            rect = child_info["rect"]
            if rect[2] > rect[0] and rect[3] > rect[1]:
                children.append(child_info)
            return True

        callback = EnumProc(inspect_child)
        user32.EnumChildWindows(hwnd, callback, 0)
        info["children"] = children
        windows.append(info)
        return True

    callback = EnumProc(inspect)
    user32.EnumWindows(callback, 0)
    print(json.dumps(windows, ensure_ascii=True))


if __name__ == "__main__":
    main()
