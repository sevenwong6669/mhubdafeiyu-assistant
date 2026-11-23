using System;
using System.IO;
using System.Text;
using System.Windows.Forms;
using System.Drawing;
using System.Web.Script.Serialization;

public static class FishImeReceiver {
 [STAThread] public static void Main(string[] args) {
  Application.EnableVisualStyles();
  Application.SetCompatibleTextRenderingDefault(false);
  string root=AppDomain.CurrentDomain.BaseDirectory;
  var form=new Form {Text="大肥鱼 · 输入法接收测试", Width=560,Height=240,StartPosition=FormStartPosition.CenterScreen,TopMost=true};
  var label=new Label {Text="请在输入框内，按住豆包语音快捷键说话，松开后查看文字。",Left=15,Top=15,Width=510,Height=40};
  var box=new TextBox {Multiline=true,Left=15,Top=60,Width=510,Height=95,ImeMode=ImeMode.On,Font=new Font("Microsoft YaHei UI",14)};
  var note=new Label {Text="测试文字只在本机记录，不会自动发送。",Left=15,Top=165,Width=510,Height=30};
  form.Controls.AddRange(new Control[]{label,box,note});
  Action save=()=>File.WriteAllText(Path.Combine(root,"cache/ime-receiver-result.json"),new JavaScriptSerializer().Serialize(new {text=box.Text,at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),visible=form.Visible,handle=form.Handle.ToInt64()}),new UTF8Encoding(false));
  box.TextChanged+=(s,e)=>save();
  form.Shown+=(s,e)=>{form.Activate();box.Focus();save();};
  Application.Run(form);
 }
}
