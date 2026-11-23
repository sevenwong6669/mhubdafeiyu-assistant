# 迈从大肥鱼插件 · Harness 版

请先读 AGENT-INSTALL.md 与安装与使用.md。推荐接入 DeepSeek Harness，复用用户选择的宿主账户、任务与对话来源；不需要原版大肥鱼、AuraBot、鱼搭子或外部 Live2D 插件。

新安装使用 Install.ps1 -LinkHarness；需要语音和桌宠时增加 -PrepareVoice -PrepareDesktop。官方 M HUB、Node.js、Python 仍是运行条件，独立 API 模式仅作为可选兼容入口。不会自动更换用户的账户或模型。

角色模型、Cubism Core、唤醒权重、账号、API Key、聊天、录音、私有配音、设备备份和运行状态不随包分发。完整桌宠未配置模型时明确提示；兼容内置动画角色仍保留。默认不接管设备、不录音、不陪看、不开启 QQ，也不添加登录启动项。

顶层的 mhub_light_sync_api.mjs 和 mhub_runtime_access.mjs 提供设备联动、余额灯带和壁纸依赖的运行接口，请随包保留。ace75_control.py、k20gt_control.py、k20gt_probe.py、magdock_control.py、mhub_ace75_gif.mjs 为手动设备诊断脚本。
