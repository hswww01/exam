@echo off
setlocal
cd /d "%~dp0"
call "E:\DevTools\VS2026\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b 1
if not defined VCPKG_INSTALLED_DIR set "VCPKG_INSTALLED_DIR=E:\work\vcpkg\installed\x64-windows-static"
if not exist "%VCPKG_INSTALLED_DIR%\lib\WebView2LoaderStatic.lib" (
  echo Missing WebView2 static package. Set VCPKG_INSTALLED_DIR.
  exit /b 1
)
if not defined EXAM_BUILD_DIR set "EXAM_BUILD_DIR=dist-static"
if not exist "%EXAM_BUILD_DIR%" mkdir "%EXAM_BUILD_DIR%"
cl /nologo /TC /utf-8 /W4 /O2 /MT /D_WIN32_WINNT=0x0A00 /I"%VCPKG_INSTALLED_DIR%\include" main.c /Fo"%EXAM_BUILD_DIR%\main.obj" /Fe"%EXAM_BUILD_DIR%\YixueExam.exe" /link /SUBSYSTEM:WINDOWS user32.lib gdi32.lib ole32.lib shell32.lib uuid.lib winhttp.lib advapi32.lib version.lib shlwapi.lib oleaut32.lib /LIBPATH:"%VCPKG_INSTALLED_DIR%\lib" WebView2LoaderStatic.lib
if errorlevel 1 exit /b 1
echo Built: %CD%\%EXAM_BUILD_DIR%\YixueExam.exe
