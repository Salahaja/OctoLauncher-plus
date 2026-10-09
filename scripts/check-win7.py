"""Checks that every executable a build ships can load on Windows 7 SP1.

For each .exe/.dll/.node: the CPU architecture, the minimum Windows version its
header declares, and any imported DLL or function that only exists on Windows 8
or later. Usage: python scripts/check-win7.py <folder>"""
import os
import struct
import sys

MACHINE = {0x14c: "x86", 0x8664: "x64", 0xaa64: "arm64"}
# imports that fail to load on Windows 7 SP1 (all came with Windows 8 or later)
WIN8_FUNCS = {
    "GetSystemTimePreciseAsFileTime", "CreateFile2", "GetOverlappedResultEx",
    "WaitOnAddress", "WakeByAddressSingle", "WakeByAddressAll", "SetThreadDescription",
    "GetThreadDescription", "PrefetchVirtualMemory", "VirtualAlloc2", "MapViewOfFile3",
    "InitializeSynchronizationBarrier", "EnterSynchronizationBarrier", "GetCurrentPackageId",
    "SetDefaultDllDirectories", "AddDllDirectory", "GetProcessMitigationPolicy",
    "SetProcessMitigationPolicy", "CreateRemoteThreadEx_unused", "GetFirmwareType",
    "QueryUnbiasedInterruptTimePrecise", "GetSystemCpuSetInformation", "DiscardVirtualMemory",
    "OfferVirtualMemory", "SetProcessInformation", "GetProcessInformation",
    "SetThreadInformation", "CopyFile2", "CreateFileMappingFromApp", "LoadPackagedLibrary",
}
# KB2533623 (2011) backports Set/AddDllDirectory to Windows 7; it is in every
# patched SP1 install, so report those as a note, not a failure
KB2533623 = {"SetDefaultDllDirectories", "AddDllDirectory"}
WIN8_DLL_PREFIXES = ("api-ms-win-core-synch-l1-2", "api-ms-win-core-winrt", "api-ms-win-core-path",
                     "api-ms-win-core-file-l2-1-1", "bcryptprimitives", "api-ms-win-core-memory-l1-1-3",
                     "api-ms-win-core-processthreads-l1-1-3")
UCRT_PREFIX = "api-ms-win-crt-"


def parse(path):
    b = open(path, "rb").read()
    if b[:2] != b"MZ":
        return None
    pe = struct.unpack_from("<I", b, 0x3C)[0]
    if b[pe:pe + 4] != b"PE\0\0":
        return None
    machine, nsec = struct.unpack_from("<HH", b, pe + 4)
    opt_size = struct.unpack_from("<H", b, pe + 20)[0]
    opt = pe + 24
    magic = struct.unpack_from("<H", b, opt)[0]
    plus = magic == 0x20B
    os_ver = struct.unpack_from("<HH", b, opt + 40)
    sub_ver = struct.unpack_from("<HH", b, opt + 48)
    dd = opt + (112 if plus else 96)
    imp_rva = struct.unpack_from("<I", b, dd + 8)[0]
    secs = []
    for i in range(nsec):
        s = opt + opt_size + 40 * i
        vsize, va, rsize, raw = struct.unpack_from("<IIII", b, s + 8)
        secs.append((va, max(vsize, rsize), raw))

    def off(rva):
        for va, size, raw in secs:
            if va <= rva < va + size:
                return rva - va + raw
        return None

    def cstr(o):
        return b[o:b.index(b"\0", o)].decode("latin1")

    imports = {}
    o = off(imp_rva) if imp_rva else None
    while o is not None:
        oft, _, _, name_rva, ft = struct.unpack_from("<IIIII", b, o)
        if not name_rva:
            break
        dll = cstr(off(name_rva)).lower()
        funcs = []
        t = off(oft or ft)
        step, flag = (8, 1 << 63) if plus else (4, 1 << 31)
        while t is not None:
            v = struct.unpack_from("<Q" if plus else "<I", b, t)[0]
            if not v:
                break
            if not v & flag:
                h = off(v & 0x7FFFFFFF)
                if h is not None:
                    funcs.append(cstr(h + 2))
            t += step
        imports[dll] = funcs
        o += 20
    return MACHINE.get(machine, hex(machine)), os_ver, sub_ver, imports


def main(root):
    bad = 0
    for dirpath, _, files in os.walk(root):
        for f in sorted(files):
            if not f.lower().endswith((".exe", ".dll", ".node")):
                continue
            p = os.path.join(dirpath, f)
            info = parse(p)
            if not info:
                continue
            arch, osv, subv, imports = info
            problems, notes = [], []
            if subv > (6, 1):
                problems.append("header requires Windows %d.%d" % subv)
            for dll, funcs in imports.items():
                if dll.startswith(WIN8_DLL_PREFIXES):
                    problems.append("imports %s" % dll)
                if dll.startswith(UCRT_PREFIX):
                    notes.append("UCRT (KB2999226)")
                for fn in funcs:
                    if fn in KB2533623:
                        notes.append("%s (KB2533623)" % fn)
                    elif fn in WIN8_FUNCS:
                        problems.append("%s!%s" % (dll, fn))
            rel = os.path.relpath(p, root)
            if problems:
                bad += 1
            print("%-4s %-6s sub %d.%d  %-60s %s%s" % (
                "FAIL" if problems else "ok", arch, subv[0], subv[1], rel,
                "; ".join(sorted(set(problems))), ("  [needs " + ", ".join(sorted(set(notes))) + "]") if notes else ""))
    print("\n%d file(s) would not load on Windows 7 SP1" % bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
