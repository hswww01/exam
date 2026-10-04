# 亦学考试客户端

使用 C、Win32 API 和 WebView2 COM 接口编写，编译为 Windows x64 程序。没有 C++、.NET、Python 或 Node.js 运行依赖。

## 运行

打开 dist-static/YixueExam.exe。WebView2 加载器已静态链接，无需旁边附带 WebView2Loader.dll；电脑仍需要安装 WebView2 Runtime。

程序固定连接 https://cn.tqdream.com/exam/ ，默认全屏。电脑需要 Microsoft Edge WebView2 Evergreen Runtime；当前开发电脑已安装。如果换一台电脑提示缺少 Runtime，可从[微软官网](https://developer.microsoft.com/microsoft-edge/webview2/)下载。

家长后台请在普通浏览器访问 https://cn.tqdream.com/exam/admin 。客户端只有学生考试入口。

## 功能与退出

- 默认全屏，没有地址栏、标签页、右键菜单或开发者工具入口。
- 限制主窗口、子框架外部导航；阻止网页打开新窗口。
- 考试开始后自动全屏，并禁用客户端的“全屏 / 窗口”切换按钮。
- 考试期间隐藏原生工具栏、网页侧栏、顶栏、答题卡和标记按钮，只保留答题、保存状态、倒计时和交卷。
- 考试期间禁止返回首页、刷新、关闭和切换窗口模式。成功交卷后恢复；到时自动交卷沿用网站规则。
- 非考试期间：右上角“退出”或 Ctrl+Shift+Q。考试期间这两种退出方式均不可用，没有客户端应急退出快捷键。
- F11 可在非考试状态切换全屏，F5 或 Ctrl+R 通过客户端的重新连接确认。
- 离开和返回考试客户端会提醒，并记录本机时间；不采集屏幕、其他应用名称或其他应用内容。
- 考试窗口处于前台时，使用 WH_KEYBOARD_LL 屏蔽 Alt+Tab、Alt+Esc、Alt+F4、Windows 键、Ctrl+Esc、Ctrl+Shift+Esc 及浏览器导航快捷键。交卷或进程退出时移除钩子，不记录按键内容。
- 普通客户端无法拦截 Ctrl+Alt+Delete、安全桌面、系统弹窗或所有触控/多显示器切换途径，因此不承诺系统级彻底锁定。
- 如果安装键盘钩子失败，会明确弹窗提示限制没有启用。

本机日志不是防篡改审计，也不构成作弊证据。系统弹窗等操作也可能影响焦点。切换次数不自动扣分或交卷，暂不上传服务器。

## 数据位置

- WebView2独立浏览器配置：%LOCALAPPDATA%\YixueExamClient\BrowserData
- 焦点日志：%LOCALAPPDATA%\YixueExamClient\focus-YYYYMMDD.log

客户端和普通浏览器使用不同的 Cookie。客户端里开始的考试可在同一客户端继续，但普通浏览器的学生记录不会自动同步显示；家长后台可查看服务器上的所有答卷。更换电脑或删除配置目录会丢失客户端的浏览器身份，但不会删除服务器记录。

## 构建

在本机运行 build.cmd。当前脚本使用 E:\DevTools\VS2026 的 MSVC x64 编译环境。换开发电脑时需调整该路径。

使用 vcpkg 的 x64-windows-static 包，默认路径 E:\work\vcpkg\installed\x64-windows-static。可用 VCPKG_INSTALLED_DIR 环境变量覆盖路径，用 EXAM_BUILD_DIR 覆盖输出目录。

编译使用 /TC（C）、/MT（静态C运行时）、/W4，链接 WebView2LoaderStatic.lib。静态链接的是加载器，不包含浏览器内核。

编译成功不等于完成运行验证。本次没有启动完整模拟考试或执行客户端自动化测试。此程序未做代码签名。

## 第三方组件

WebView2 静态加载器来自 Microsoft WebView2 SDK，发行条款见随包 WebView2-LICENSE.txt。
