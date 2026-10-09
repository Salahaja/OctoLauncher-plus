# StormLib, 32-bit (Win32)

The 32-bit Windows 7 build links `stormlib-node` against these instead of the
64-bit libraries the package ships in `node_modules/stormlib-node/lib`.

Built from [StormLib](https://github.com/ladislav-zezula/StormLib) commit
`9beaed5` (2023-02-02), the newest one whose `src/StormLib.h` is byte-identical
to the header stormlib-node 1.3.6 ships (unchanged from 8a16217 until 0d31856),
and the first with the `StormLib_vs22.sln` that stormlib-node's own build uses:

    msbuild StormLib_vs22.sln /t:StormLib;StormLib_dll
      /p:Configuration=ReleaseAS;BuildProjectReferences=false;Platform=Win32;
         WindowsTargetPlatformVersion=10.0.22621.0;PlatformToolset=v143

- `PlatformToolset=v143`: the project asks for `v141_xp`; v143 still targets
  Windows 7, which `scripts/check-win7.py` confirms.
- `src/DllMain.rc` includes MFC's `afxres.h`; without MFC installed, a local
  `afxres.h` that includes `<winres.h>` (and defines `IDC_STATIC`) does.

SHA-256:

```
c2c42640b14147b2da75bf54cd93fffa08db128cb8c29ba3982d59a5b32e41de *StormLib.dll
9cfed6b19924ec7d7e33c742f484046e5769a5cdca331cc809976d00d2ad3469 *StormLib.lib
42d389653f8468ce63d6eba7d784d0b76d03e432b9f3e3c643ed97c76eb2a891 *StormLibRAS.lib
```
