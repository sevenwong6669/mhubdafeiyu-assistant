# 迈从大肥鱼插件

> 给迈从 M HUB 外设 + DeepSeek Harness 做设备联动与桌面陪伴的开源插件。

> **本项目为非官方第三方工具。** 与迈从（MCHOSE）及其关联公司、以及"大肥鱼"角色权利人均无隶属、合作、授权或背书关系。"迈从""MCHOSE"等名称与标识归其权利人所有。本项目通过客户端在本机暴露的接口与其交互，这些接口并非公开发布的稳定 API，可能随时变更或失效。使用本项目的风险由使用者自行承担。

## 这是什么

- 键盘/音箱/鼠标联动：灯光、板载、K20 GT 屏幕字幕、余额灯带、鼠标宏，全部要你自己在面板里开。
- 社区分享检索：按设备和游戏搜索 M HUB 社区配置，在面板里先看兼容性和槽位预览，确认后通过已配置的 QQ 或语音流程导入设备。
- 语音聊天与桌宠：可选组件，识别、音色、模型都可以换成自己的。
- 不做什么：不自动接管设备、不录音、不发 QQ、不加开机启动项、不替换你的账号或模型。

## 前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| Windows | x64 | 仅支持 Windows |
| Node.js | ≥ 22.15 | 安装器会校验 |
| Python | 3.11–3.13 x64 | 安装器会校验 |
| M HUB | 官方最新 | 需能从官网安装 |

## 快速开始

1. 从 [Releases](https://github.com/sevenwong6669/mhubdafeiyu-assistant/releases/latest) 下载完整发布 ZIP。附带的 .sha256 文件可用于校验下载。
2. 解压到一个长期目录。
3. 运行 `Install.ps1 -LinkHarness`；需要语音和桌宠时再加 `-PrepareVoice -PrepareDesktop`。
4. 打开面板按首次引导逐项开启功能。

卸载运行 `Uninstall.ps1`。脚本先等待设备联动释放控制、独立语音退出，再停止面板并解除已验证归属的宿主注册。用户设置和备份会保留。

如果卸载报告设备恢复未确认，请查看 `harness-mhub-sync/shutdown-pending.json` 和 `harness-mhub-sync/device-link-release.json`。在联动停止后亲自确认设备已恢复，再运行 `Uninstall.ps1 -ConfirmDeviceRestored` 继续卸载。

## 目录与文档

- `安装与使用.md` 完整安装说明；`AGENT-INSTALL.md` 给自动化助手看的集成说明。
- `docs/TESTING.md` 测试验收说明；`素材说明.md` 主题与素材来源；`旧版兼容说明.md` 兼容模式。
- 顶层 `mhub_light_sync_api.mjs`、`mhub_runtime_access.mjs` 是设备联动的运行接口，请随包保留；`ace75_control.py`、`k20gt_control.py`、`k20gt_probe.py`、`magdock_control.py`、`mhub_ace75_gif.mjs` 为手动设备诊断脚本。

## 已知限制

- Live2D 模型与 Cubism Core、API Key、音色、账号不随包分发，需自备。
- 面板端口固定 18782。
- 局域网访问默认关闭。开启后需登录，旧版免登录配置会自动沿用现有口令进入登录模式。面板使用明文 HTTP，请在可信网络内使用，远程访问请使用加密隧道。

## 许可证

自有代码按 [LICENSE](LICENSE)（MIT）发布；第三方素材条款见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。安全问题见 [SECURITY.md](SECURITY.md)。
