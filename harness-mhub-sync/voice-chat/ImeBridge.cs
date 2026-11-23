using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Net.Http;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// A real editable surface for the installed IME. No private IME API, clipboard
// scraping, credential access, or injected shortcut is used. The mouse firmware
// supplies Alt+F13, which the IME receives as a physical keyboard report.
public sealed class FishImeBox : TextBox {
 public bool Composing;
 public long Edited;
 protected override void WndProc(ref Message m) {
  if(m.Msg==0x10D) Composing=true;
  base.WndProc(ref m);
  if(m.Msg==0x10E) { Composing=false; Edited=FishImeBridge.Now(); }
 }
}

public sealed class FishImeBridge : Form {
 delegate IntPtr HookProc(int code,IntPtr message,IntPtr data);
 [StructLayout(LayoutKind.Sequential)] struct KeyData {public uint key,scan,flags,time;public UIntPtr extra;}
 [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int type,HookProc callback,IntPtr module,uint thread);
 [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
 [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint thread,uint target,bool attach);
 [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr window);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
 readonly JavaScriptSerializer json=new JavaScriptSerializer();
 readonly string root=AppDomain.CurrentDomain.BaseDirectory;
 readonly FishImeBox box=new FishImeBox();
 readonly Label label=new Label();
 readonly HttpClient http=new HttpClient(new HttpClientHandler{UseProxy=false});
 readonly Timer timer=new Timer{Interval=50};
 readonly int parent;
 readonly int threshold;
 HookProc callback;
 IntPtr hook,previous;
 string token,lastError,lastEvent="ready";
 long down,released,lastSequence,lastParentCheck;
 bool held,holdPosted,sending,focusOk,restored,suppressChord;
 Task begun;
 int submitted;
 public static long Now(){return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();}
 void Save() {
  var value=new {ready=hook!=IntPtr.Zero,captureReady=hook!=IntPtr.Zero,parent=parent,pid=Process.GetCurrentProcess().Id,
   provider="doubao-ime",inputDevice="麦克风 (MCHOSE K20 GT)",button="rear-side / Alt+F13",captureActive=held,
   active=token!=null,composing=box.Composing,textLength=box.Text.Length,lastEvent=lastEvent,error=lastError,
   submitted=submitted,focusOk=focusOk,windowRestored=restored,
   receiverUi="transparent",opacity=Opacity,showInTaskbar=ShowInTaskbar,borderStyle=FormBorderStyle.ToString(),at=Now()};
  try {string file=Path.Combine(root,"ime-status.json");File.WriteAllText(file+".tmp",json.Serialize(value),new UTF8Encoding(false));
   if(File.Exists(file)) File.Replace(file+".tmp",file,null); else File.Move(file+".tmp",file);
  } catch(IOException) {}
 }
 async Task Post(string path,object value) {
  using(var content=new StringContent(json.Serialize(value),Encoding.UTF8,"application/json"))
  using(var response=await http.PostAsync("http://127.0.0.1:18780"+path,content)) {
   string body=await response.Content.ReadAsStringAsync();
   if(!response.IsSuccessStatusCode) throw new Exception(body);
  }
 }
 bool OwnForeground() {
  IntPtr foreground=GetForegroundWindow();if(foreground==Handle)return true;
  uint pid;GetWindowThreadProcessId(foreground,out pid);
  try {string name=Process.GetProcessById((int)pid).ProcessName;
   return name.Equals("ImeService",StringComparison.OrdinalIgnoreCase)||name.StartsWith("DoubaoIme",StringComparison.OrdinalIgnoreCase);
  } catch {return false;}
 }
 bool FocusForPhysicalPress() {
  // Windows may deny activation from a low-level hook before dispatching the
  // physical key. Share focus only for this activation and detach immediately;
  // no system preference, foreground timeout, or security setting is changed.
  uint pid;uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out pid);
  uint currentThread=GetCurrentThreadId();bool attached=false;
  try {
   if(foregroundThread!=0&&foregroundThread!=currentThread)attached=AttachThreadInput(currentThread,foregroundThread,true);
   Show();Activate();SetForegroundWindow(Handle);box.Focus();SetFocus(box.Handle);
   return GetForegroundWindow()==Handle;
  } finally {if(attached)AttachThreadInput(currentThread,foregroundThread,false);}
 }
 void Restore() {
  bool mayRestore=OwnForeground();Hide();
  restored=mayRestore&&previous!=IntPtr.Zero&&IsWindow(previous)&&SetForegroundWindow(previous);
 }
 void BeginTurn() {
  if(token==null||!OwnForeground())previous=GetForegroundWindow();
  down=Now();released=0;held=true;holdPosted=false;sending=false;restored=false;lastError=null;
  token=Guid.NewGuid().ToString("N");string ownToken=token;
  box.Clear();box.Composing=false;box.Edited=down;
  label.Text="听你说，松开后直接回复";
  Rectangle area=Screen.FromHandle(previous).WorkingArea;
  Location=new Point(area.Right-Width-18,area.Bottom-Height-18);
  focusOk=FocusForPhysicalPress();
  if(!focusOk) {token=null;held=false;lastError="无法取得输入焦点，请退出独占全屏后重试";lastEvent="focus-failed";Restore();Save();return;}
  lastSequence=Math.Max(Now(),lastSequence+1);
  begun=Post("/ptt/begin",new {token=ownToken,sequence=lastSequence});
  lastEvent="pressed";Save();
 }
 async Task CancelTurn(string reason) {
  if(token==null)return;
  string ownToken=token;Task start=begun;token=null;held=false;sending=false;
  lastError=reason;lastEvent="cancelled";Restore();box.Clear();Save();
  try {await start;await Post("/ptt/discard",new {token=ownToken});}catch{}
 }
 async Task Hold() {
  string ownToken=token;holdPosted=true;string failure=null;
  try {await begun;if(token==ownToken)await Post("/ptt/hold",new {token=ownToken});}
  catch(Exception ex){failure=ex.Message;}
  if(failure!=null&&token==ownToken)await CancelTurn(failure);
 }
 async Task Finish(bool tap) {
  string ownToken=token;if(ownToken==null||sending)return;
  string text=box.Text.Trim();Task start=begun;sending=true;
  Restore();lastEvent=tap?"tap":"submitting";Save();
  bool failed=false;
  try {
   await start;
   if(token!=ownToken)return;
   if(tap)await Post("/ptt/tap",new {token=ownToken});
   else {
    await Post("/ptt/text",new {token=ownToken,text=text,provider="doubao-ime",releasedAt=released});
    submitted++;
   }
   lastEvent=tap?"tap-complete":"submitted";lastError=null;
  } catch(Exception ex) {lastEvent="submit-failed";lastError=ex.Message;failed=true;}
  if(failed){try{await Post("/ptt/discard",new {token=ownToken});}catch{}}
  if(token==ownToken){token=null;held=false;sending=false;box.Clear();Save();}
 }
 async void Tick(object sender,EventArgs args) {
  long now=Now();
  if(now-lastParentCheck>1000) {
   lastParentCheck=now;
   try {if(Process.GetProcessById(parent).HasExited){Application.ExitThread();return;}}
   catch {Application.ExitThread();return;}
   Save();
  }
  if(token==null||sending)return;
  if(held&&!holdPosted&&now-down>=threshold)await Hold();
  if(token==null||sending)return;
  if(!OwnForeground()){await CancelTurn("输入期间切换了窗口，本次已取消");return;}
  if(now-down>65000){await CancelTurn("录音超过60秒，请松开后重新说话");return;}
  if(held||released==0)return;
  if(released-down<threshold){await Finish(true);return;}
  // The IME can revise live text after release. Never send its composition or
  // an empty/stale turn; wait for both a committed edit and a quiet interval.
  if(!box.Composing&&box.Text.Trim().Length>0&&now-released>=700&&now-box.Edited>=650)await Finish(false);
  else if(now-released>12000)await CancelTurn("豆包没有返回文字，请重新按住后侧键说话");
 }
 IntPtr KeyHook(int code,IntPtr message,IntPtr data) {
  if(code>=0) {
   KeyData key=(KeyData)Marshal.PtrToStructure(data,typeof(KeyData));
   int kind=message.ToInt32();
   // Only the dedicated physical F13 from the mouse is observed. No keyboard
   // text or ordinary keys are recorded, and the IME receives the original event.
   if(key.key==0x7C&&(key.flags&0x10)==0) {
    bool pressed=kind==0x100||kind==0x104;
    bool lifted=kind==0x101||kind==0x105;
    if(suppressChord){if(lifted)suppressChord=false;return new IntPtr(1);}
    if(pressed&&!held&&(key.flags&0x20)!=0) {
     // Do not overlap two client recognition sessions or let a failed focus
     // attempt dictate into the user's original application.
     if(token!=null){suppressChord=true;return new IntPtr(1);}
     BeginTurn();
     if(!focusOk){suppressChord=true;return new IntPtr(1);}
    }
    else if(lifted&&held){held=false;released=Now();lastEvent="released";Save();}
   }
  }
  return CallNextHookEx(hook,code,message,data);
 }
 FishImeBridge(int parentPid,int holdMs) {
  parent=parentPid;threshold=holdMs;Text="大肥鱼 · 豆包语音";ClientSize=new Size(370,100);
  // Keep a real, focusable input surface for TSF, but paint no pixels. Set all
  // styles before creating the HWND so there is no first-show border flash.
  FormBorderStyle=FormBorderStyle.None;Opacity=0;ShowInTaskbar=false;TopMost=true;StartPosition=FormStartPosition.Manual;
  label.SetBounds(12,8,346,22);label.Text="按住后侧键说话";
  box.SetBounds(12,34,346,54);box.Multiline=true;box.ImeMode=ImeMode.On;box.Font=new Font("Microsoft YaHei UI",11);
  box.TextChanged+=(s,e)=>{box.Edited=Now();Save();};
  Controls.AddRange(new Control[]{label,box});
  var handle=Handle;var editHandle=box.Handle;Hide();
  callback=KeyHook;hook=SetWindowsHookEx(13,callback,GetModuleHandle(null),0);
  if(hook==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  http.Timeout=TimeSpan.FromSeconds(15);timer.Tick+=Tick;timer.Start();Save();
  FormClosing+=async(s,e)=>{
   // Alt+F4 during dictation cancels that turn instead of killing the listener.
   if(e.CloseReason==CloseReason.UserClosing){e.Cancel=true;await CancelTurn("本次输入已取消");}
   else Application.ExitThread();
  };
 }
 protected override CreateParams CreateParams {
  get {var style=base.CreateParams;style.ExStyle|=0x80;return style;}
 }
 protected override void Dispose(bool disposing) {
  if(hook!=IntPtr.Zero){UnhookWindowsHookEx(hook);hook=IntPtr.Zero;Restore();Save();}
  if(disposing){timer.Dispose();http.Dispose();}
  base.Dispose(disposing);
 }
 [STAThread] public static void Main(string[] args) {
  Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
  int parentPid=0,hold=250;
  for(int i=0;i<args.Length-1;i++){if(args[i]=="--parent")parentPid=int.Parse(args[++i]);else if(args[i]=="--hold")hold=int.Parse(args[++i]);}
  if(parentPid<=0)return;
  bool created;using(var mutex=new System.Threading.Mutex(true,"Local\\DafeiyuDoubaoImeBridge",out created)) {
   if(!created)return;
   try {using(var app=new FishImeBridge(parentPid,hold)){Application.Run();}}
   catch(Exception ex){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"ime-bridge-error.log"),ex.ToString());}
  }
 }
}
