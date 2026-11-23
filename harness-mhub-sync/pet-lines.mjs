// Native BreezeBlue dreamy voice. Keep filenames stable for offline playback.
const line=(file,text)=>({file,text});
export const PET_POOLS={
  hello:[
    line('touch-hello-1.wav','咦，怎么突然摸我呀？'),
    line('touch-hello-2.wav','哼，先说好，只准摸一下。'),
    line('touch-hello-3.wav','我才没有在等你摸呢。'),
    line('touch-hello-4.wav','手还挺暖的嘛，勉强让你摸一下。'),
  ],
  tease:[
    line('touch-tease-1.wav','又来？你是不是特别喜欢大肥鱼呀？'),
    line('touch-tease-2.wav','摸就摸嘛，不许把头发弄乱。'),
    line('touch-tease-3.wav','别偷偷笑，我可是看见了哦。'),
    line('touch-tease-4.wav','你这么闲，是工作都做完了吗？'),
  ],
  soft:[
    line('pet.wav','嘿嘿，好舒服呀。'),
    line('again.wav','嗯，再摸摸我嘛，好不好？'),
    line('touch-soft-1.wav','嗯，就这里，再轻一点点嘛。'),
    line('touch-soft-2.wav','好吧，好吧，这次不跟你计较。'),
  ],
  shy:[
    line('touch-shy-1.wav','你怎么还摸上瘾了呀，真拿你没办法。'),
    line('touch-shy-2.wav','脸热是因为房间太暖，才不是害羞。'),
    line('touch-shy-3.wav','只许你摸哦，这句话不准告诉别人。'),
    line('touch-shy-4.wav','再这样，我可要偷偷开心了。'),
  ],
  work:[
    line('touch-work-1.wav','哎呀，别摸了别摸了，快去工作吧。'),
    line('touch-work-2.wav','好啦，摸摸先欠着，事情还等着你呢。'),
    line('touch-work-3.wav','你去忙，我就在这里陪着，跑不掉的。'),
    line('touch-work-4.wav','认真工作十分钟，再奖励你摸一下。'),
  ],
  sulk:[
    line('touch-sulk-1.wav','怎么还在摸？哼，不理你了。'),
    line('touch-sulk-2.wav','我都说最后一下啦，你怎么不听呀。'),
    line('touch-sulk-3.wav','我要转过去啦，真的不理你了哦。'),
    line('touch-sulk-4.wav','再摸也没用，我可是很有原则的。'),
  ],
  peek:[
    line('touch-peek-1.wav','我只是在看你工作，才不是舍不得你。'),
    line('touch-peek-2.wav','好吧，再一下，真的真的最后一下。'),
    line('touch-peek-3.wav','还没走呀？那你陪我待一小会儿。'),
    line('touch-peek-4.wav','被你发现啦，我刚才是装作不理你的。'),
  ],
  reunion:[
    line('touch-return-1.wav','哼，又回来啦？这次可不许摸个没完。'),
    line('touch-return-2.wav','忙完了吗？那就勉强让你摸一下吧。'),
  ],
  busy:[
    line('busy.wav','收到啦，等我忙完这一下。'),
    line('touch-busy-1.wav','我正在认真想事情呢，摸一下就好哦。'),
    line('touch-busy-2.wav','知道你在啦，等我忙完，再陪你好不好？'),
  ],
};
export const PET_LINES=Object.values(PET_POOLS).flat();
export const PET_VOICE_FILES=new Set(PET_LINES.map(x=>x.file));
