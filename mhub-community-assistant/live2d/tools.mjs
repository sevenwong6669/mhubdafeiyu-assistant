// Original author-owned core tool schemas. Keep these in sync with core.mjs.
// Safe to register before activation; execution is delegated to InternalLive2d.
export const live2dToolDefinitions = Object.freeze([
  {
    "name": "live2d_motions",
    "description": "看自己现在有哪些动作、每个动作什么时候用。想做一个动作之前，先调这个看一眼，避免重复造。",
    "properties": {
      "含细节": {
        "type": "boolean",
        "description": "要不要连每条轨道一起列出来（想参考别人的写法时用），默认不用"
      }
    }
  },
  {
    "name": "live2d_dict",
    "description": "查身体的参数词典：某个关节叫什么、范围多少。造动作前想确认参数名或量程时用。不带关键词就返回分组概览。",
    "properties": {
      "关键词": {
        "type": "string",
        "description": "比如「手臂」「眉」「耳」「Angle」「胸」「胯」，也接受参数名如 Param36"
      }
    }
  },
  {
    "name": "live2d_make_motion",
    "description": "给自己造一个新动作（或覆盖已有动作）。动作 = 多条关节轨道在同一时间轴上同时跑，所以「抬手的同时扭腰低头」是一条动作能做出来的。造完 3 秒内自动生效，可直接用 <body:名字> 演出。做之前建议先调 live2d_dict 确认参数名。",
    "properties": {
      "名称": {
        "type": "string",
        "description": "动作名，2~6 个字，比如「踮脚」「抱拳」「甩头」"
      },
      "何时用": {
        "type": "string",
        "description": "什么情绪/场合该做这个动作。这句会被写进你的手册，你自己以后靠它想起来用"
      },
      "轨迹": {
        "type": "string",
        "description": "JSON。键是参数名（d.=身体角度/前后，p.=关节覆盖写，a.=表情叠加），值是 [[时间0~1, 数值], ...]。例：{\"d.AngleZ\":[[0,0],[0.3,12],[1,0]],\"p.Param36\":[[0,0],[0.2,1],[1,0]],\"a.EyeSmile\":[[0,0],[0.3,0.5],[1,0]]}"
      },
      "时长": {
        "type": "number",
        "description": "秒，0.4~20，日常动作 2~3 秒最自然"
      },
      "基底": {
        "type": "string",
        "description": "手型：举手（手在胸前）/ 竖手指 / 狗尾草；不需要就留空"
      },
      "表情": {
        "type": "string",
        "description": "可选，模型自带表情名（脸红、爱心眼…）。一般用 a.EyeSmile 之类自己画更自然"
      },
      "关键词": {
        "type": "string",
        "description": "可选，逗号分隔。她说话内容里出现这些词时，系统会自动配这个动作"
      }
    },
    "required": [
      "名称",
      "何时用",
      "轨迹"
    ]
  },
  {
    "name": "live2d_look",
    "description": "看或改自己现在的长相：大钢盆、黑框眼镜、单片眼镜、长短裙、体型、鞋子、尾巴。主人说「换个样子」「戴上眼镜」「穿短裙」「变小一点」「脱鞋」，或者你自己想换个装扮时用。改完会长久保持（重启也在），直到再改。体型分 默认/中/Q版 三档：默认是上半身特写，中是半身像，Q 版是小小一只完整站在画面里。鞋子和尾巴可以给中间值（比如脱到一半）。",
    "properties": {
      "项目": {
        "type": "string",
        "description": "大钢盆 / 黑框眼镜 / 单片眼镜 / 长短裙 / 体型 / 鞋子 / 尾巴。留空就只报当前长相"
      },
      "设置": {
        "type": "string",
        "description": "开关类写 开 或 关（长短裙写 长 或 短）；体型写 默认 / 中 / 小，也可以直接写 0~1 的小数；鞋子写 穿 / 脱（或 0~1 的小数表示脱了几分）；尾巴写 露 / 收（或 0~1 的小数）。留空表示切换当前状态"
      }
    }
  }
]);
