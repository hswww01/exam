# 亦学 · 九年级考试练习（PHP 版）

## 正式使用入口

- 学生考试：https://cn.tqdream.com/exam/
- 教师后台：https://cn.tqdream.com/exam/admin
- 正式服务器：PHP 8.3.6 + Nginx 1.24 + MySQL 8.0.36。
- 应用目录：`/opt/yixue-exam`；独立数据库：`exam_practice`。

学生端只提供试卷、作答和已公布的复盘。后台需要教师密码；题库编辑、参考答案、AI 调用、人工评分和成绩公布均由服务端校验登录权限。

### 首次设置密码

1. 打开教师后台。
2. 从本机项目的 `.server-setup-code` 文件复制一次性设置码。
3. 输入设置码和自定教师密码（至少10个字符），确认后登录。

设置码只用于首次设置。服务器副本位于 `/opt/yixue-exam/.setup-code`，不在网站可访问目录内。后台登录有效期30分钟，刷新后需重新登录；令牌只保留在页面内存。交给学生使用前请退出后台。首次设置码和真实 API key 不应提交到版本库。

### 考试与阅卷流程

1. 学生在学生入口选择试卷并开考。倒计时不会因刷新、离开页面暂停；答案自动保存。
2. 交卷后显示“等待教师公布成绩”。此时学生接口不返回分数、答案、评分标准或评语。
3. 教师登录后台 → 答卷与成绩 → 打开答卷，使用 AI 阅卷或手工评分。
4. 所有主观题评分完成后点击“公布成绩与解析”。学生可在考试记录中查看。
5. 教师可撤回公布。已被学生阅读或保存的内容无法从其设备收回。

学生使用8位学号和自设密码登录，答卷按账号隔离，支持跨设备访问。教师后台可以查看全部答卷；历史浏览器身份答卷可在学生账号管理中分配归属。

## 试卷与范围

## AI 出题和后台任务

使用 OpenAI Responses API + Structured Outputs，默认模型 `gpt-6-luna`，推理强度 `medium`。原有 API 配置已迁移至服务器 `.env.local`；密钥不返回网页。

一键出题沿用模板的题型、分值、时长和文章关联题结构，生成后保存草稿，由教师审核发布。AI 阅卷只处理未评分的非空主观题；评分返回全部校验通过才写入，人工已评题不会被后台任务覆盖。

AI 请求由 `yixue-exam-worker.service` 独立处理。网页只提交任务和查询进度；关闭页面不会终止任务，重新登录会恢复正在进行的任务显示。出题、识别和阅卷统一使用 Flex（service_tier=flex），单次模型请求至少900秒超时，不自动降级到标准模式。任务失败不会自动重发付费请求；进程意外重启时将未完成任务标记失败，教师可手动重试。

阅卷会把题目、评分标准和学生答案发送给配置的 AI 服务，不发送考生称呼；请求使用 `store:false`。复杂推导、作文、开放性答案需要教师复核。迁移前 Python 版完成过3道出题、2道阅卷的真实模型小样本调用；这不能视为 PHP 版完整回归测试或评分准确率证明。本次 PHP 部署没有额外发起付费模型请求。

## 本机开发与预览

双击 `start.bat`（调用 `start-php.ps1`）启动本机 PHP 预览；`stop-php.ps1` 停止本机服务。旧的 `start.ps1` 和 `stop.ps1` 现为 PHP 脚本入口的兼容包装。

本机地址仍为 `http://127.0.0.1:8033/`，后台 `/admin`。本机未设置 MySQL 连接时，PHP 使用已有 `exam.db` 作为开发数据；**与正式服务器 MySQL 不同步**。正式考试请使用上面的服务器网址。本机首次设置码在 `.setup-code`，与服务器设置码不同。

Windows PHP运行时在 `.runtime/php`（PHP官方网站下载并核对SHA256），不加入系统 PATH；启动器也支持系统已安装的 `php.exe`。需要 PDO、pdo_mysql（正式服务器）、pdo_sqlite（本机）、curl、openssl。正式运行不依赖 Python、pip 或 Composer。

`app.py`、`ai_client.py`、`static/` 和 `tests/test_app.py` 保留为原 Python 原型参考；正式入口不使用它们，原 Python 测试不能代表 PHP 版本的验证情况。当前可部署页面位于 `public/`，PHP 后端位于 `php/`。

## 部署与维护

- Nginx 只暴露 `public/index.php` 路由及白名单页面资源。代码、数据库配置、设置码均在站点根目录之外。
- Nginx 片段：`deploy/nginx-location.conf`；服务器安装到 `/etc/nginx/snippets/yixue-exam.conf`，在现有 HTTPS server 中引入。修改前配置备份保存在服务器 `/root/nginx-default-before-exam-*`。
- MySQL 连接由 `/etc/environment` 的 `MYSQL_HOST`、`MYSQL_USER`、`MYSQL_PASS` 读取；项目配置 `MYSQL_DATABASE=exam_practice`。可在项目 `.env.local` 覆盖连接值以改用应用专用账号。
- 新安装先准备独立数据库，再运行 `php php/install.php`；仅初始化缺失结构和种子卷，不覆盖后台编辑后的数据。
- 数据迁移入口 `php php/import.php <导出文件>`，一次性导入标记防止重复；目标已有考试记录时拒绝导入。
- 后台任务由 `deploy/yixue-exam-worker.service` 托管并开机启动。服务状态：`systemctl status yixue-exam-worker.service`；日志：`journalctl -u yixue-exam-worker.service`。
- 更新代码后重启 worker；正式网站 PHP-FPM 按服务器配置加载新代码。重启 worker 会中断正在进行的 AI 任务，因此应先等队列空闲。
- 支持定时任务替代常驻服务：`php /opt/yixue-exam/php/worker.php --once`，它会处理队列直到为空再退出。进程锁避免同一安装目录的多个 worker 重复执行。
- 备份应包括 MySQL 的 `exam_practice`、应用源码和私有配置。真实 key、数据库密码和设置码不应写进日志或聊天。

## 本次部署记录

2026-10-04：完成 PHP/MySQL 部署；服务器导入5套试卷、144题；迁移时本机没有真实考试记录。Nginx配置检查通过并已加载，后台队列服务为运行状态。浏览器已展示学生首页及独立教师密码设置页。教师密码由用户自行设置；未代设密码，也未执行完整业务回归或新增自动化测试。

## 纸质答卷图片阅卷

教师后台 → 上传图片阅卷 → 选择对应试卷、考生称呼 → 建立答卷 → 上传照片并调整页序 → 开始识别 → 对照照片逐题核对（可保存核对草稿）→ 确认答案并进入阅卷 → 点击 AI 阅卷或手动评分。

支持 JPG/PNG/WebP，每份最多12页，单张原文件最多20MB；客户端压缩为长边不超过2800像素的 JPEG，保留上传后的图片供教师复核。暂不支持 PDF/HEIC。识别失败可保留照片手动重试，不自动重复付费调用。无法可靠识别的内容和漏题会提示核对，不能直接视为错题；图形和复杂公式需要人工复核。

纸质答卷及图片仅教师后台可见，记录在 MySQL 的 paper_scans、scan_pages 中，与在线考试一起在教师考试记录中评分。没有关联学生浏览器的纸质记录不会自动出现在学生端。备份数据库包含图片数据，请预留容量。

## Windows 考试客户端

C + Win32 + WebView2 客户端已编译在 client/dist-static/YixueExam.exe；WebView2 加载器静态链接，不需要 WebView2Loader.dll，电脑仍需安装 WebView2 Runtime。可分发 client/YixueExam-Windows-x64-static.zip。完整功能、退出方法、本机焦点日志及构建说明见 client/README.md。

默认全屏，固定连接服务器学生入口，限制外部导航、新窗口及开发者工具。网页开考状态会通知本机客户端；考试期间离开窗口会提示并记录本机事件。Ctrl+Shift+Q 或右上角“退出”可正常退出，退出前会确认。它不修改 Windows 系统策略，不能阻止系统层面的应用切换。

本次完成 C 编译和运行包打包，未执行客户端运行测试；图片识别、Flex 调用未追加真实付费样本实测。


## 学生账号

学生入口支持自助注册：8位数字学号、学生姓名、自设密码（至少8字节，最多72字节）。学号以文本存储并唯一；注册只用于本考试系统，不核验官方学籍。登录会话有效期7天，使用 HttpOnly、SameSite=Strict Cookie，在 HTTPS 上启用 Secure。密码仅保存单向哈希，登录令牌只保存哈希。

答卷通过账号的内部所有权标识关联，学生换设备登录仍能访问自己的记录。学生可修改密码；修改密码会撤销已有登录。考试未结束前不允许退出或切换账号。教师后台“学生账号”支持修改姓名和班级、重置密码、停用账号，以及将尚未归属的历史答卷或纸质答卷分配给学生；不自动按姓名认领。

更新时先运行 php php/install.php 创建 students 和 student_sessions 表，再部署新的 API 和前端。旧答卷不会被删除。学生密码不是北京市教育统一认证平台密码；本版本不接入该平台。
