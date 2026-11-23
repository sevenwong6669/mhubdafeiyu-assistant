param([Parameter(Mandatory=$true)][int]$ParentId)
$ErrorActionPreference='Stop'
trap { [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'game-panel.error.log'),($_.Exception.ToString()+[Environment]::NewLine+$_.InvocationInfo.PositionMessage),(New-Object Text.UTF8Encoding($false)));exit 1 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$utf8=New-Object Text.UTF8Encoding($false)
$inbox=Join-Path $PSScriptRoot 'interaction-inbox'
$statePath=Join-Path $PSScriptRoot 'playtime-state.json'
$script:lastState=$null;$script:seenActive=$false;$script:autoClose=$false;$script:savedPreview=$false
$script:raiseUntil=0L;$script:lastPanelStatus=0L
$started=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
function Send-PanelEvent($kind,$value=0) {
 $at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$id=[Guid]::NewGuid().ToString()
 $name=('{0:D13}-000000-{1}.json' -f $at,$id)
 $tmp=Join-Path $inbox ($name+'.tmp')
 [IO.File]::WriteAllText($tmp,(@{id=$id;at=$at;kind=$kind;value=$value}|ConvertTo-Json -Compress),$utf8)
 [IO.File]::Move($tmp,(Join-Path $inbox $name))
}

$script:localeReverse=@{};$script:localeWords=$null;$script:localeReadAt=0
function T([string]$Text) {
 try {
  $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if($now-$script:localeReadAt -gt 500){
   $script:localeReadAt=$now;$app=Join-Path (Split-Path $PSScriptRoot -Parent) 'mhub-community-assistant'
   $prefPath=Join-Path $app 'state/ui-preferences.json';$locale='zh-CN'
   if(Test-Path -LiteralPath $prefPath){$locale=([IO.File]::ReadAllText($prefPath)|ConvertFrom-Json).locale}
   if($locale -notin @('zh-CN','ru','en','fr','it')){$locale='zh-CN'}
   $script:localeWords=([IO.File]::ReadAllText((Join-Path $app ('panel/i18n/'+$locale+'.json')))|ConvertFrom-Json)
  }
  if($script:localeReverse.Count -eq 0){foreach($l in @('en','ru','fr','it')){$table=([IO.File]::ReadAllText((Join-Path $app ('panel/i18n/'+$l+'.json')))|ConvertFrom-Json);foreach($prop in $table.PSObject.Properties){if($prop.Value){$script:localeReverse[[string]$prop.Value]=$prop.Name}}}}
  $source=$Text;if($script:localeReverse.ContainsKey($Text)){$source=$script:localeReverse[$Text]}
  $translated=$script:localeWords.PSObject.Properties[$source].Value
  if($translated){return [string]$translated}
 } catch {}
 return $Text
}

$form=New-Object System.Windows.Forms.Form
$form.Text=(T '大肥鱼 · 颜色记忆小游戏')
$form.ClientSize=New-Object Drawing.Size(650,540)
$form.StartPosition='CenterScreen';$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.KeyPreview=$true
$form.ShowInTaskbar=$true;$form.WindowState='Normal'
$form.BackColor=[Drawing.Color]::FromArgb(22,27,43)
$form.Font=New-Object Drawing.Font('Microsoft YaHei UI',11)
function Add-Label($text,$x,$y,$w,$h,$size) {
 $l=New-Object Windows.Forms.Label;$l.Text=$text;$l.Location=New-Object Drawing.Point($x,$y);$l.Size=New-Object Drawing.Size($w,$h)
 $l.ForeColor=[Drawing.Color]::White;$l.Font=New-Object Drawing.Font('Microsoft YaHei UI',$size);$l.TextAlign='MiddleCenter';$form.Controls.Add($l);return $l
}
$roundLabel=Add-Label (T '大肥鱼陪你记颜色') 25 16 600 34 17
$phaseLabel=Add-Label (T '准备好啦，先看提示') 25 58 600 55 18
$progressLabel=Add-Label (T '直接点击色块，或在本窗口按 1～4') 25 116 600 30 10
$script:colors=@('#FF0000','#FFFF00','#0000FF','#00FF00')
$script:tiles=@()
for($i=0;$i -lt 4;$i++) {
 $button=New-Object Windows.Forms.Button;$button.Tag=$i;$button.Text=[string]($i+1)
 $button.Location=New-Object Drawing.Point((35+($i%2)*300),(158+[math]::Floor($i/2)*112));$button.Size=New-Object Drawing.Size(280,98)
 $button.Font=New-Object Drawing.Font('Microsoft YaHei UI',24,[Drawing.FontStyle]::Bold)
 $button.BackColor=[Drawing.ColorTranslator]::FromHtml($colors[$i]);$button.ForeColor=$(if($i -eq 2){[Drawing.Color]::White}else{[Drawing.Color]::FromArgb(15,25,38)})
 $button.FlatStyle='Flat';$button.FlatAppearance.BorderSize=1;$button.TabStop=$false
 $button.Add_Click({param($sender,$e) if($script:lastState.game.phase -in @('input','feedback','paused')) {Send-PanelEvent 'color' ([int]$sender.Tag)}})
 $form.Controls.Add($button);$script:tiles+=,$button
}
$hintLabel=Add-Label (T '先看音箱和数字键，记住出现的顺序') 25 390 600 54 13
$teach=New-Object Windows.Forms.CheckBox;$teach.Text=(T '需要帮助时，显示下一步答案');$teach.Checked=$false;$teach.ForeColor=[Drawing.Color]::White
$teach.Location=New-Object Drawing.Point(35,460);$teach.Size=New-Object Drawing.Size(285,28);$form.Controls.Add($teach)
$replay=New-Object Windows.Forms.Button;$replay.Text=(T 'R  重看这一轮');$replay.Location=New-Object Drawing.Point(335,455);$replay.Size=New-Object Drawing.Size(155,38)
$replay.Add_Click({Send-PanelEvent 'game-replay'});$form.Controls.Add($replay)
$replay.BackColor=[Drawing.Color]::FromArgb(225,233,245);$replay.ForeColor=[Drawing.Color]::FromArgb(20,30,45)
$leave=New-Object Windows.Forms.Button;$leave.Text=(T 'Esc  退出');$leave.Location=New-Object Drawing.Point(500,455);$leave.Size=New-Object Drawing.Size(115,38)
$leave.Add_Click({$form.Close()});$form.Controls.Add($leave)
$leave.BackColor=[Drawing.Color]::FromArgb(225,233,245);$leave.ForeColor=[Drawing.Color]::FromArgb(20,30,45)
$footer=Add-Label (T '看音箱和数字键记顺序；语音只提示数量、开始与结果') 25 502 600 24 9
$form.Add_KeyDown({param($sender,$e)
 if($e.Control -or $e.Alt){return}
 $key=[int]$e.KeyCode;$value=-1
 if($key -ge 49 -and $key -le 52){$value=$key-49}
 if($key -ge 97 -and $key -le 100){$value=$key-97}
 if($value -ge 0){if($script:lastState.game.phase -in @('input','feedback','paused')){Send-PanelEvent 'color' $value};$e.SuppressKeyPress=$true}
 if($e.KeyCode -eq 'R'){Send-PanelEvent 'game-replay';$e.SuppressKeyPress=$true}
 if($e.KeyCode -eq 'Escape'){$form.Close();$e.SuppressKeyPress=$true}
})
$form.Add_FormClosing({if(-not $script:autoClose){try{Send-PanelEvent 'game-stop'}catch{}}})
$form.Add_Shown({$form.TopMost=$true;$form.BringToFront();$form.Activate();$script:raiseUntil=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+2000})
$timer=New-Object Windows.Forms.Timer;$timer.Interval=180
$timer.Add_Tick({
 $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 if($script:raiseUntil -gt 0 -and $now -ge $script:raiseUntil){$form.TopMost=$false;$script:raiseUntil=0L}
 if(-not(Get-Process -Id $ParentId -ErrorAction SilentlyContinue)){$script:autoClose=$true;$form.Close();return}
 try{$data=[IO.File]::ReadAllText($statePath) | ConvertFrom-Json}catch{return}
 $g=$data.game;$script:lastState=$data
 if($now-$script:lastPanelStatus -gt 1000){
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot 'game-panel-status.json'),(@{pid=$PID;parent=$ParentId;visible=$form.Visible;phase=$g.phase;minimized=($form.WindowState -eq 'Minimized');focused=$form.ContainsFocus;observedAt=$now}|ConvertTo-Json -Compress),$utf8)
  $script:lastPanelStatus=$now
 }
 if(-not $g.active){if($script:seenActive -or [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$started -gt 8000){$script:autoClose=$true;$form.Close()};return}
 $script:seenActive=$true;$roundLabel.Text=((T '第 {0} / 3 轮 · 记住 {1} 个颜色') -f $g.round,$g.sequence.Count)
 $highlight=-1;$hintLabel.Text=(T '在游戏窗口按 R 重看，Esc 退出')
 $replay.Enabled=$g.phase -notin @('arming','intro','unavailable','celebration','round-win')
 switch($g.phase) {
  'arming' {$phaseLabel.Text=(T '准备中…')}
  'intro' {$phaseLabel.Text=(T '先看音箱和数字键，记住顺序');$hintLabel.Text=(T '听到“轮到你啦”后，再按顺序回答')}
  'round-intro' {$phaseLabel.Text=((T '这次记 {0} 个颜色') -f $g.sequence.Count);$hintLabel.Text=(T '提示说完后倒数，再开始演示')}
  'countdown' {$phaseLabel.Text=((T '准备　{0}') -f $g.countdown);$hintLabel.Text=(T '看好音箱屏幕和数字键')}
  'show' {$v=[int]$g.sequence[[int]$g.showIndex];$highlight=$v;$phaseLabel.Text=('{0} / {1}' -f ([int]$g.showIndex+1),$g.sequence.Count)}
  'gap' {$phaseLabel.Text=(T '记住刚才的数字和颜色')}
  {$_ -in @('input','feedback')} {
   $phaseLabel.Text=(T '轮到你啦，点击或按数字')
   if($teach.Checked){$v=[int]$g.sequence[[int]$g.position];$highlight=$v;$hintLabel.Text=((T '提示：下一步按 {0}') -f ($v+1))}
  }
  'round-win' {$phaseLabel.Text=(T '答对啦！你好厉害呀');$hintLabel.Text=$(if($g.round -eq 3){(T '三轮完成，马上回到大肥鱼陪伴')}else{(T '下一轮会多一个颜色')})}
  'celebration' {$roundLabel.Text=(T '大肥鱼的通关礼物');$phaseLabel.Text=(T '通关啦！抬头看桌面烟花');$hintLabel.Text=(T 'Piu——！真棒！');$replay.Enabled=$false}
  'lose' {$phaseLabel.Text=(T '没关系，我们再看这一轮');$hintLabel.Text=(T '还是刚才的顺序，不用从头开始')}
  'paused' {$phaseLabel.Text=(T '慢慢来，还可以继续作答')}
  'unavailable' {$phaseLabel.Text=(T '游戏输入未就绪，请重新打开游戏')}
 }
 $progressLabel.Text=$(if($g.phase -in @('input','feedback')){((T '已答 {0} / {1} · 在本窗口直接按 1～4') -f $g.position,$g.sequence.Count)}else{(T '看好顺序，轮到你后按 1～4')})
 for($i=0;$i -lt 4;$i++){$tiles[$i].FlatAppearance.BorderSize=$(if($i -eq $highlight){7}else{1});$tiles[$i].FlatAppearance.BorderColor=$(if($i -eq $highlight){[Drawing.Color]::White}else{[Drawing.Color]::FromArgb(70,80,100)})}
 $form.Text=(T $form.Text);foreach($c in $form.Controls){if($c.Text){$c.Text=(T $c.Text)}}
 if($g.phase -eq 'input' -and -not $script:savedPreview){
  try{$form.Refresh();$bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height);$form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)));$bitmap.Save((Join-Path $PSScriptRoot 'game-panel-preview.png'),[Drawing.Imaging.ImageFormat]::Png);$bitmap.Dispose();$script:savedPreview=$true}catch{}
 }
})
$timer.Start()
try{$null=$form.ShowDialog()}finally{$timer.Stop();$timer.Dispose();$form.Dispose()}
