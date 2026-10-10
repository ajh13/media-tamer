#!/usr/bin/env python3
"""xclick — fake mouse click via XTest using ctypes."""
import ctypes, ctypes.util, sys, time

Xlib = ctypes.cdll.LoadLibrary(ctypes.util.find_library('X11') or 'libX11.so.6')
Xtst = ctypes.cdll.LoadLibrary(ctypes.util.find_library('Xtst') or 'libXtst.so.6')

Xlib.XOpenDisplay.restype = ctypes.c_void_p
Xlib.XOpenDisplay.argtypes = [ctypes.c_char_p]
Xlib.XDefaultScreen.restype = ctypes.c_int
Xlib.XDefaultScreen.argtypes = [ctypes.c_void_p]
Xlib.XFlush.restype = ctypes.c_int
Xlib.XFlush.argtypes = [ctypes.c_void_p]
Xlib.XCloseDisplay.restype = ctypes.c_int
Xlib.XCloseDisplay.argtypes = [ctypes.c_void_p]

Xtst.XTestFakeMotionEvent.restype = ctypes.c_int
Xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
Xtst.XTestFakeButtonEvent.restype = ctypes.c_int
Xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

def click(x, y, display_name=None):
    d = Xlib.XOpenDisplay(display_name.encode() if display_name else None)
    if not d:
        print(f"cannot open display", file=sys.stderr); return False
    screen = Xlib.XDefaultScreen(d)
    Xtst.XTestFakeMotionEvent(d, screen, x, y, 0)
    Xlib.XFlush(d)
    time.sleep(0.05)
    Xtst.XTestFakeButtonEvent(d, 1, True, 0); Xlib.XFlush(d)
    time.sleep(0.05)
    Xtst.XTestFakeButtonEvent(d, 1, False, 0); Xlib.XFlush(d)
    Xlib.XCloseDisplay(d)
    return True

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("usage: xclick x y [display]", file=sys.stderr); sys.exit(1)
    sys.exit(0 if click(int(sys.argv[1]), int(sys.argv[2]), sys.argv[3] if len(sys.argv)>3 else None) else 1)
