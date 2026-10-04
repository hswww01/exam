#define UNICODE
#define _UNICODE
#define CINTERFACE
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <windowsx.h>
#include <shlobj.h>
#include <strsafe.h>
#include <winhttp.h>
#include <stdio.h>
#include <WebView2.h>

#define ID_HOME 101
#define ID_RELOAD 102
#define ID_EXIT 104
#define WM_CLIENT_STATE (WM_APP+1)
#define WM_WEB_ERROR (WM_APP+2)
static const WCHAR EXAM_URL[]=L"https://cn.tqdream.com/exam/";
static HWND window, statusLabel, homeButton, reloadButton, exitButton;
static ICoreWebView2Controller *controller;
static ICoreWebView2 *web;
static HFONT font;
static HHOOK examKeyboardHook;
static BOOL blockedKeys[256];
static BOOL fullscreen=TRUE, inExam=FALSE, closing=FALSE, foreground=TRUE, creating=FALSE, browserFailed=FALSE;
static RECT restored={100,100,1300,880};
static UINT dpi=96, departures=0;
static ULONGLONG awaySince=0, awayTotal=0;
static WCHAR userFolder[MAX_PATH], logPath[MAX_PATH], errorText[256];
static EventRegistrationToken navToken, frameToken, popupToken, messageToken, keyToken, completedToken, permissionToken, failureToken;
static int px(int v) { return MulDiv(v,(int)dpi,96); }

static void logEvent(const WCHAR *event) {
    SYSTEMTIME t; WCHAR line[256]; char utf8[1024]; DWORD written;
    HANDLE f; int n;
    GetLocalTime(&t);
    StringCchPrintfW(line,256,L"%04u-%02u-%02u %02u:%02u:%02u %s\r\n",t.wYear,t.wMonth,t.wDay,t.wHour,t.wMinute,t.wSecond,event);
    n=WideCharToMultiByte(CP_UTF8,0,line,-1,utf8,sizeof(utf8),NULL,NULL);
    f=CreateFileW(logPath,FILE_APPEND_DATA,FILE_SHARE_READ,NULL,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
    if(f!=INVALID_HANDLE_VALUE) { if(n>1) WriteFile(f,utf8,(DWORD)n-1,&written,NULL); CloseHandle(f); }
}
/* Only filter shortcuts while this exam window (or its owned dialog) is foreground.
   Never log keystrokes; releasing the hook restores normal system input. */
static LRESULT CALLBACK examKeyboard(int code, WPARAM w, LPARAM l) {
    if(code==HC_ACTION) {
        KBDLLHOOKSTRUCT *k=(KBDLLHOOKSTRUCT*)l;
        DWORD key=k->vkCode;
        BOOL up=(w==WM_KEYUP || w==WM_SYSKEYUP);
        if(key<256 && up && blockedKeys[key]) {blockedKeys[key]=FALSE;return 1;}
        if(inExam && GetAncestor(GetForegroundWindow(),GA_ROOTOWNER)==window) {
            BOOL alt=(k->flags&LLKHF_ALTDOWN)!=0;
            BOOL ctrl=(GetAsyncKeyState(VK_CONTROL)&0x8000)!=0;
            BOOL shift=(GetAsyncKeyState(VK_SHIFT)&0x8000)!=0;
            BOOL block=key==VK_LWIN || key==VK_RWIN ||
                (alt&&(key==VK_TAB || key==VK_ESCAPE || key==VK_F4 || key==VK_SPACE || key==VK_LEFT || key==VK_RIGHT)) ||
                (ctrl&&(key==VK_ESCAPE || key==VK_TAB || key=='R' || key=='W' || key=='L' || key=='N' || key=='T' || key=='P' || key=='S' || key=='U')) ||
                (ctrl&&shift&&(key=='Q' || key=='I' || key=='J' || key=='C')) ||
                key==VK_F5 || key==VK_F11 || key==VK_F12 || key==VK_BROWSER_BACK || key==VK_BROWSER_FORWARD || key==VK_BROWSER_HOME || key==VK_BROWSER_REFRESH;
            if(block) {if(key<256)blockedKeys[key]=!up;return 1;}
        }
    }
    return CallNextHookEx(examKeyboardHook,code,w,l);
}
static void releaseExamKeyboard(void) {
    if(examKeyboardHook){UnhookWindowsHookEx(examKeyboardHook);examKeyboardHook=NULL;}
    ZeroMemory(blockedKeys,sizeof(blockedKeys));
}
static void status(void) {
    WCHAR text[320];
    if(errorText[0]) StringCchCopyW(text,320,errorText);
    else if(inExam) StringCchPrintfW(text,320,L"考试中 · 离开 %u 次 · 累计 %llu 秒（本次客户端会话）",departures,awayTotal/1000);
    else StringCchCopyW(text,320,L"亦学 · 学生考试客户端 | Ctrl+Shift+Q 退出");
    SetWindowTextW(statusLabel,text);
}
static void layout(void) {
    RECT r; int height=inExam?0:px(54), gap=px(8), bw=px(96), right;
    GetClientRect(window,&r); right=r.right-gap;
    {HWND children[]={statusLabel,homeButton,reloadButton,exitButton};UINT i;
     for(i=0;i<4;i++)ShowWindow(children[i],inExam?SW_HIDE:SW_SHOW);}
    MoveWindow(exitButton,right-bw,px(10),bw,px(32),TRUE); right-=bw+gap;
    MoveWindow(reloadButton,right-bw,px(10),bw,px(32),TRUE); right-=bw+gap;
    MoveWindow(homeButton,right-bw,px(10),bw,px(32),TRUE); right-=bw+gap;
    MoveWindow(statusLabel,px(16),px(17),max(px(100),right-px(20)),px(28),TRUE);
    r.top=height;
    if(controller) ICoreWebView2Controller_put_Bounds(controller,r);
}
static void setFullscreen(BOOL value) {
    MONITORINFO info={sizeof(info)};
    if(value) {
        if(!fullscreen) GetWindowRect(window,&restored);
        GetMonitorInfoW(MonitorFromWindow(window,MONITOR_DEFAULTTONEAREST),&info);
        SetWindowLongPtrW(window,GWL_STYLE,WS_POPUP|WS_CLIPCHILDREN);
        SetWindowPos(window,NULL,info.rcMonitor.left,info.rcMonitor.top,
            info.rcMonitor.right-info.rcMonitor.left,info.rcMonitor.bottom-info.rcMonitor.top,SWP_NOZORDER|SWP_FRAMECHANGED);
    } else {
        SetWindowLongPtrW(window,GWL_STYLE,WS_OVERLAPPEDWINDOW|WS_CLIPCHILDREN);
        SetWindowPos(window,NULL,restored.left,restored.top,restored.right-restored.left,restored.bottom-restored.top,SWP_NOZORDER|SWP_FRAMECHANGED);
    }
    fullscreen=value; layout();
}
static BOOL allowedUri(LPCWSTR uri) {
    URL_COMPONENTS u={sizeof(u)};
    u.dwSchemeLength=u.dwHostNameLength=u.dwUrlPathLength=u.dwExtraInfoLength=(DWORD)-1;
    if(!uri || !WinHttpCrackUrl(uri,0,0,&u)) return FALSE;
    if(u.nScheme!=INTERNET_SCHEME_HTTPS || u.nPort!=443 ||
       u.dwHostNameLength!=14 || _wcsnicmp(u.lpszHostName,L"cn.tqdream.com",14)!=0) return FALSE;
    return (u.dwUrlPathLength==6 && wcsncmp(u.lpszUrlPath,L"/exam/",6)==0) ||
           (u.dwUrlPathLength==15 && wcsncmp(u.lpszUrlPath,L"/exam/index.php",15)==0);
}
static void showError(LPCWSTR message,HRESULT hr) {
    StringCchPrintfW(errorText,256,L"%s（0x%08lX），可点“重新连接”。",message,(unsigned long)hr);
    status(); logEvent(L"browser_error");
}
static BOOL confirmLeave(LPCWSTR action) {
    WCHAR text[420];
    StringCchPrintfW(text,420,L"%s\r\n\r\n%s",action,inExam?L"正在考试。离开后倒计时仍继续，未同步的答案可能丢失。请先确认网页显示已保存。":L"考试记录保存在服务器，客户端的登录与草稿保留在本机。");
    return MessageBoxW(window,text,L"亦学考试客户端",MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2)==IDYES;
}

/* Static COM callbacks have process lifetime; WebView2 owns temporary references. */
#define COMMON(T,N) \
typedef struct { T iface; LONG refs; } N##Object; \
static HRESULT STDMETHODCALLTYPE N##Query(T *self,REFIID iid,void **out) { \
    if(!out)return E_POINTER; *out=NULL; \
    if(IsEqualIID(iid,&IID_IUnknown)||IsEqualIID(iid,&IID_##T)){*out=self;InterlockedIncrement(&((N##Object*)self)->refs);return S_OK;} return E_NOINTERFACE; } \
static ULONG STDMETHODCALLTYPE N##Add(T *self){return (ULONG)InterlockedIncrement(&((N##Object*)self)->refs);} \
static ULONG STDMETHODCALLTYPE N##Release(T *self){return (ULONG)InterlockedDecrement(&((N##Object*)self)->refs);}
#define OBJECT(T,N,F) static T##Vtbl N##Vtable={N##Query,N##Add,N##Release,F}; static N##Object N={{&N##Vtable},1}

COMMON(ICoreWebView2NavigationStartingEventHandler,Navigation)
static HRESULT STDMETHODCALLTYPE onNavigation(ICoreWebView2NavigationStartingEventHandler *self,ICoreWebView2 *sender,ICoreWebView2NavigationStartingEventArgs *args) {
    LPWSTR uri=NULL; (void)self;(void)sender;
    if(SUCCEEDED(ICoreWebView2NavigationStartingEventArgs_get_Uri(args,&uri))) {
        if(inExam || !allowedUri(uri)) { ICoreWebView2NavigationStartingEventArgs_put_Cancel(args,TRUE); SetWindowTextW(statusLabel,L"已阻止离开学生考试网站。"); }
        CoTaskMemFree(uri);
    } else ICoreWebView2NavigationStartingEventArgs_put_Cancel(args,TRUE);
    return S_OK;
}
OBJECT(ICoreWebView2NavigationStartingEventHandler,Navigation,onNavigation);

COMMON(ICoreWebView2NewWindowRequestedEventHandler,Popup)
static HRESULT STDMETHODCALLTYPE onPopup(ICoreWebView2NewWindowRequestedEventHandler *self,ICoreWebView2 *sender,ICoreWebView2NewWindowRequestedEventArgs *args) {
    (void)self;(void)sender;
    ICoreWebView2NewWindowRequestedEventArgs_put_Handled(args,TRUE);
    SetWindowTextW(statusLabel,L"考试客户端不打开其他窗口。");return S_OK;
}
OBJECT(ICoreWebView2NewWindowRequestedEventHandler,Popup,onPopup);

COMMON(ICoreWebView2PermissionRequestedEventHandler,Permission)
static HRESULT STDMETHODCALLTYPE onPermission(ICoreWebView2PermissionRequestedEventHandler *self,ICoreWebView2 *sender,ICoreWebView2PermissionRequestedEventArgs *args) {
    (void)self;(void)sender; return ICoreWebView2PermissionRequestedEventArgs_put_State(args,COREWEBVIEW2_PERMISSION_STATE_DENY);
}
OBJECT(ICoreWebView2PermissionRequestedEventHandler,Permission,onPermission);

COMMON(ICoreWebView2WebMessageReceivedEventHandler,Message)
static HRESULT STDMETHODCALLTYPE onMessage(ICoreWebView2WebMessageReceivedEventHandler *self,ICoreWebView2 *sender,ICoreWebView2WebMessageReceivedEventArgs *args) {
    LPWSTR source=NULL,message=NULL; (void)self;(void)sender;
    if(SUCCEEDED(ICoreWebView2WebMessageReceivedEventArgs_get_Source(args,&source)) && allowedUri(source) &&
       SUCCEEDED(ICoreWebView2WebMessageReceivedEventArgs_TryGetWebMessageAsString(args,&message))) {
        if(wcscmp(message,L"exam-active")==0) PostMessageW(window,WM_CLIENT_STATE,TRUE,0);
        else if(wcscmp(message,L"exam-idle")==0) PostMessageW(window,WM_CLIENT_STATE,FALSE,0);
    }
    CoTaskMemFree(source);CoTaskMemFree(message);return S_OK;
}
OBJECT(ICoreWebView2WebMessageReceivedEventHandler,Message,onMessage);

COMMON(ICoreWebView2AcceleratorKeyPressedEventHandler,Key)
static HRESULT STDMETHODCALLTYPE onKey(ICoreWebView2AcceleratorKeyPressedEventHandler *self,ICoreWebView2Controller *sender,ICoreWebView2AcceleratorKeyPressedEventArgs *args) {
    UINT key=0; COREWEBVIEW2_KEY_EVENT_KIND kind; BOOL ctrl,shift,alt,handled=FALSE;(void)self;(void)sender;
    ICoreWebView2AcceleratorKeyPressedEventArgs_get_KeyEventKind(args,&kind);
    if(kind!=COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind!=COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN)return S_OK;
    ICoreWebView2AcceleratorKeyPressedEventArgs_get_VirtualKey(args,&key);
    ctrl=(GetKeyState(VK_CONTROL)&0x8000)!=0;shift=(GetKeyState(VK_SHIFT)&0x8000)!=0;alt=(GetKeyState(VK_MENU)&0x8000)!=0;
    if(ctrl&&shift&&key=='Q') {if(!inExam)PostMessageW(window,WM_CLOSE,0,0);handled=TRUE;}
    else if(key==VK_F5 || (ctrl&&key=='R')) {PostMessageW(window,WM_COMMAND,ID_RELOAD,0);handled=TRUE;}
    else if(key==VK_F11) handled=TRUE;
    else if(key==VK_F12 || (alt&&(key==VK_LEFT||key==VK_RIGHT)) ||
            (ctrl&&(key=='L'||key=='N'||key=='T'||key=='P'||key=='S'||key=='U')) ||
            (ctrl&&shift&&(key=='I'||key=='J'||key=='C'))) handled=TRUE;
    if(handled) ICoreWebView2AcceleratorKeyPressedEventArgs_put_Handled(args,TRUE);
    return S_OK;
}
OBJECT(ICoreWebView2AcceleratorKeyPressedEventHandler,Key,onKey);

COMMON(ICoreWebView2NavigationCompletedEventHandler,Completed)
static HRESULT STDMETHODCALLTYPE onCompleted(ICoreWebView2NavigationCompletedEventHandler *self,ICoreWebView2 *sender,ICoreWebView2NavigationCompletedEventArgs *args) {
    BOOL success=FALSE;COREWEBVIEW2_WEB_ERROR_STATUS error;(void)self;(void)sender;
    ICoreWebView2NavigationCompletedEventArgs_get_IsSuccess(args,&success);
    if(success){errorText[0]=0;status();if(controller)ICoreWebView2Controller_MoveFocus(controller,COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);}
    else {ICoreWebView2NavigationCompletedEventArgs_get_WebErrorStatus(args,&error);showError(L"网页加载失败",(HRESULT)error);}
    return S_OK;
}
OBJECT(ICoreWebView2NavigationCompletedEventHandler,Completed,onCompleted);

COMMON(ICoreWebView2ProcessFailedEventHandler,Failed)
static HRESULT STDMETHODCALLTYPE onFailed(ICoreWebView2ProcessFailedEventHandler *self,ICoreWebView2 *sender,ICoreWebView2ProcessFailedEventArgs *args) {
    (void)self;(void)sender;(void)args;PostMessageW(window,WM_WEB_ERROR,0,0);return S_OK;
}
OBJECT(ICoreWebView2ProcessFailedEventHandler,Failed,onFailed);

COMMON(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,Controller)
static HRESULT STDMETHODCALLTYPE onController(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *self,HRESULT result,ICoreWebView2Controller *value) {
    ICoreWebView2Settings *settings=NULL; ICoreWebView2Settings3 *settings3=NULL; (void)self;
    creating=FALSE;
    if(closing)return S_OK;
    if(FAILED(result)||!value){showError(L"无法建立浏览器窗口",result);return S_OK;}
    controller=value;ICoreWebView2Controller_AddRef(controller);
    result=ICoreWebView2Controller_get_CoreWebView2(controller,&web);
    if(FAILED(result)||!web){showError(L"浏览器初始化失败",result);return S_OK;}
    if(SUCCEEDED(ICoreWebView2_get_Settings(web,&settings))){
        ICoreWebView2Settings_put_AreDevToolsEnabled(settings,FALSE);
        ICoreWebView2Settings_put_AreDefaultContextMenusEnabled(settings,FALSE);
        ICoreWebView2Settings_put_IsStatusBarEnabled(settings,FALSE);
        ICoreWebView2Settings_put_AreHostObjectsAllowed(settings,FALSE);
        ICoreWebView2Settings_put_IsWebMessageEnabled(settings,TRUE);
        if(SUCCEEDED(ICoreWebView2Settings_QueryInterface(settings,&IID_ICoreWebView2Settings3,(void**)&settings3))){
            ICoreWebView2Settings3_put_AreBrowserAcceleratorKeysEnabled(settings3,FALSE);
            ICoreWebView2Settings3_Release(settings3);
        }
        ICoreWebView2Settings_Release(settings);
    }
    ICoreWebView2_add_NavigationStarting(web,&Navigation.iface,&navToken);
    ICoreWebView2_add_FrameNavigationStarting(web,&Navigation.iface,&frameToken);
    ICoreWebView2_add_NewWindowRequested(web,&Popup.iface,&popupToken);
    ICoreWebView2_add_WebMessageReceived(web,&Message.iface,&messageToken);
    ICoreWebView2_add_NavigationCompleted(web,&Completed.iface,&completedToken);
    ICoreWebView2_add_PermissionRequested(web,&Permission.iface,&permissionToken);
    ICoreWebView2_add_ProcessFailed(web,&Failed.iface,&failureToken);
    ICoreWebView2Controller_add_AcceleratorKeyPressed(controller,&Key.iface,&keyToken);
    ICoreWebView2Controller_put_IsVisible(controller,TRUE);
    layout();
    result=ICoreWebView2_Navigate(web,EXAM_URL);if(FAILED(result))showError(L"无法打开考试网站",result);
    return S_OK;
}
OBJECT(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,Controller,onController);

COMMON(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,Environment)
static HRESULT STDMETHODCALLTYPE onEnvironment(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *self,HRESULT result,ICoreWebView2Environment *value) {
    (void)self;if(closing)return S_OK;
    if(FAILED(result)||!value){creating=FALSE;showError(L"WebView2 Runtime 未就绪",result);return S_OK;}
    result=ICoreWebView2Environment_CreateCoreWebView2Controller(value,window,&Controller.iface);
    if(FAILED(result)){creating=FALSE;showError(L"无法创建考试窗口",result);}
    return S_OK;
}
OBJECT(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,Environment,onEnvironment);

static void initBrowser(void) {
    HRESULT hr;
    if(creating)return;
    browserFailed=FALSE;
    if(web){ICoreWebView2_Release(web);web=NULL;}
    if(controller){ICoreWebView2Controller_Close(controller);ICoreWebView2Controller_Release(controller);controller=NULL;}
    errorText[0]=0;SetWindowTextW(statusLabel,L"正在连接考试网站…");
    creating=TRUE;
    hr=CreateCoreWebView2EnvironmentWithOptions(NULL,userFolder,NULL,&Environment.iface);
    if(FAILED(hr)){creating=FALSE;showError(L"请安装 Microsoft Edge WebView2 Runtime",hr);}
}
static LRESULT CALLBACK windowProc(HWND h,UINT message,WPARAM w,LPARAM l) {
    switch(message) {
    case WM_CREATE:
        window=h;dpi=GetDpiForWindow(h);
        font=CreateFontW(-px(14),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Microsoft YaHei UI");
        statusLabel=CreateWindowW(L"STATIC",L"正在启动…",WS_CHILD|WS_VISIBLE|SS_LEFT,0,0,0,0,h,NULL,NULL,NULL);
        homeButton=CreateWindowW(L"BUTTON",L"返回首页",WS_CHILD|WS_VISIBLE|WS_TABSTOP,0,0,0,0,h,(HMENU)ID_HOME,NULL,NULL);
        reloadButton=CreateWindowW(L"BUTTON",L"重新连接",WS_CHILD|WS_VISIBLE|WS_TABSTOP,0,0,0,0,h,(HMENU)ID_RELOAD,NULL,NULL);
        exitButton=CreateWindowW(L"BUTTON",L"退出",WS_CHILD|WS_VISIBLE|WS_TABSTOP,0,0,0,0,h,(HMENU)ID_EXIT,NULL,NULL);
        {HWND children[]={statusLabel,homeButton,reloadButton,exitButton};UINT i;for(i=0;i<4;i++)SendMessageW(children[i],WM_SETFONT,(WPARAM)font,TRUE);}
        return 0;
    case WM_SIZE: layout();return 0;
    case WM_DPICHANGED: dpi=HIWORD(w); if(fullscreen)setFullscreen(TRUE);else {RECT *r=(RECT*)l;SetWindowPos(h,NULL,r->left,r->top,r->right-r->left,r->bottom-r->top,SWP_NOZORDER);} layout();return 0;
    case WM_DISPLAYCHANGE:if(fullscreen)setFullscreen(TRUE);return 0;
    case WM_ACTIVATEAPP:
        foreground=(BOOL)w;
        if(inExam&&!closing){
            if(!foreground&&!awaySince){departures++;awaySince=GetTickCount64();logEvent(L"exam_focus_lost");}
            else if(foreground&&awaySince){awayTotal+=GetTickCount64()-awaySince;awaySince=0;logEvent(L"exam_focus_returned");status();SetWindowTextW(statusLabel,L"你刚刚离开了考试窗口，请保持在答卷页面（离开情况已记入本机日志）。");}
        }return 0;
    case WM_CLIENT_STATE:
        if((BOOL)w!=inExam){
            if(w){departures=0;awayTotal=0;awaySince=0;logEvent(L"exam_started");}
            else{if(awaySince){awayTotal+=GetTickCount64()-awaySince;awaySince=0;}logEvent(L"exam_page_left_or_submitted");}
            inExam=(BOOL)w;
            if(inExam) {
                examKeyboardHook=SetWindowsHookExW(WH_KEYBOARD_LL,examKeyboard,GetModuleHandleW(NULL),0);
                if(!examKeyboardHook) {logEvent(L"shortcut_filter_failed");MessageBoxW(window,L"快捷键限制未能启用。本次考试不能保证阻止切换应用。",L"考试客户端",MB_OK|MB_ICONERROR);}
                if(!fullscreen)setFullscreen(TRUE);
            } else releaseExamKeyboard();
            layout();status();
        }return 0;
    case WM_WEB_ERROR:browserFailed=TRUE;showError(L"浏览器进程异常，请重新连接",E_FAIL);return 0;
    case WM_COMMAND:
        switch(LOWORD(w)){
        case ID_HOME:if(web&&!inExam){ICoreWebView2_Navigate(web,EXAM_URL);}break;
        case ID_RELOAD:if(!inExam){if(web&&!browserFailed)ICoreWebView2_Reload(web);else initBrowser();}break;
        case ID_EXIT:PostMessageW(h,WM_CLOSE,0,0);break;
        }return 0;
    case WM_SYSCOMMAND:
        if(inExam && ((w&0xfff0)==SC_CLOSE || (w&0xfff0)==SC_MINIMIZE || (w&0xfff0)==SC_RESTORE || (w&0xfff0)==SC_MOVE || (w&0xfff0)==SC_SIZE))return 0;
        break;
    case WM_CLOSE:
        if(inExam)return 0;
        if(!confirmLeave(L"确定退出考试客户端吗？"))return 0;
        closing=TRUE;logEvent(L"client_closed");DestroyWindow(h);return 0;
    case WM_DESTROY:
        releaseExamKeyboard();
        if(controller){ICoreWebView2Controller_Close(controller);ICoreWebView2Controller_Release(controller);controller=NULL;}
        if(web){ICoreWebView2_Release(web);web=NULL;}if(font)DeleteObject(font);
        PostQuitMessage(0);return 0;
    }return DefWindowProcW(h,message,w,l);
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE previous,PWSTR command,int show) {
    WNDCLASSW wc={0}; MSG msg; PWSTR local=NULL; HRESULT hr; HANDLE mutex;
    (void)previous;(void)command;(void)show;
    mutex=CreateMutexW(NULL,TRUE,L"Local\\YixueExamClient");
    if(GetLastError()==ERROR_ALREADY_EXISTS){MessageBoxW(NULL,L"考试客户端已经打开。请切回现有窗口。",L"亦学",MB_OK);CloseHandle(mutex);return 0;}
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    hr=CoInitializeEx(NULL,COINIT_APARTMENTTHREADED);
    if(FAILED(hr)){CloseHandle(mutex);return 1;}
    if(FAILED(SHGetKnownFolderPath(&FOLDERID_LocalAppData,0,NULL,&local))){CoUninitialize();CloseHandle(mutex);return 1;}
    StringCchPrintfW(userFolder,MAX_PATH,L"%s\\YixueExamClient",local);CoTaskMemFree(local);CreateDirectoryW(userFolder,NULL);
    {SYSTEMTIME t;GetLocalTime(&t);StringCchPrintfW(logPath,MAX_PATH,L"%s\\focus-%04u%02u%02u.log",userFolder,t.wYear,t.wMonth,t.wDay);}
    StringCchCatW(userFolder,MAX_PATH,L"\\BrowserData");CreateDirectoryW(userFolder,NULL);
    wc.lpfnWndProc=windowProc;wc.hInstance=instance;wc.lpszClassName=L"YixueExamWindow";wc.hCursor=LoadCursor(NULL,IDC_ARROW);wc.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);wc.hIcon=LoadIcon(NULL,IDI_APPLICATION);
    RegisterClassW(&wc);
    window=CreateWindowExW(0,wc.lpszClassName,L"亦学 · 考试客户端",WS_POPUP|WS_CLIPCHILDREN,100,100,1200,800,NULL,NULL,instance,NULL);
    if(!window){CoUninitialize();CloseHandle(mutex);return 1;}
    setFullscreen(TRUE);ShowWindow(window,SW_SHOW);UpdateWindow(window);logEvent(L"client_started");initBrowser();
    while(GetMessageW(&msg,NULL,0,0)>0){
        if(!inExam && msg.message==WM_KEYDOWN && msg.wParam=='Q' && (GetKeyState(VK_CONTROL)&0x8000) && (GetKeyState(VK_SHIFT)&0x8000)){PostMessageW(window,WM_CLOSE,0,0);continue;}
        TranslateMessage(&msg);DispatchMessageW(&msg);
    }
    CoUninitialize();CloseHandle(mutex);return 0;
}
