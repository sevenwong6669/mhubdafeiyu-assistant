/* Presentation only. Drawings live in the Porcelain glyph atlas. */
(() => {
  const root = document.documentElement;
  const viewIcons = {control:'dashboard', overview:'dashboard', library:'library', devices:'device', activity:'diagnostics'};
  const tabIcons = {
    home:'dashboard', bindings:'keys', phone:'call', live2d:'pet', states:'lamp', speaker:'screen',
    voice:'microphone', tts:'headset', balance:'balance', audio:'headset', captions:'subtitles',
    notices:'alert', devices:'device', wallpaper:'appearance', shortcuts:'keys'
  };
  const actions = {
    refresh:'rotate', devices:'rotate', learn:'rotate', 'devices-refresh':'rotate', 'control-audio-refresh':'rotate',
    'plugin-restart':'power', 'control-preview':'play', 'control-audio-test':'play', 'tts-preview':'play',
    'control-save':'check', 'control-reset':'cancel', 'tts-save':'check', 'tts-reset':'cancel',
    'learning-save':'check', 'learning-reset':'cancel', 'control-balance-toggle':'balance'
  };
  const commands = {
    'voice-start':'microphone', 'voice-restart':'rotate', 'voice-interrupt':'cancel', 'voice-stop':'cancel',
    'sync-start':'power', 'sync-stop':'cancel', 'sync-devices-refresh':'rotate', 'device-default-theme':'screen',
    'screen-animation':'screen', 'screen-text':'subtitles', 'screen-pages':'screen', 'screen-page-next':'arrow',
    'balance-refresh':'rotate', 'subtitle-preview':'play', 'audio-test':'play', 'audio-apply':'check',
    'game-start':'play', 'game-toggle':'play', 'game-replay':'rotate', 'game-stop':'cancel',
    'task-light-stop':'cancel', 'phone-dial':'call', 'phone-demo':'call', 'phone-accept':'call',
    'phone-reject':'cancel', 'phone-hangup':'cancel', 'phone-mute':'microphone'
  };
  const shortcutIcons = {'keyboard-normal.png':'keys','voice-normal.png':'call','play-metal.svg':'play','mouse-normal.png':'mouse'};
  const symbols = {'◉':'mouse','▤':'keys','∩':'headset','◫':'speaker','⌁':'dock','◇':'device'};
  const states = {IDLE:'dial', BUSY:'work', ATTENTION:'alert'};
  let scheduled = false;

  function paint(target, name) {
    if (!target || !name) return;
    let mark = target.querySelector(':scope > .porcelain-glyph');
    if (!mark) {
      mark = document.createElement('span');
      mark.className = 'porcelain-glyph';
      mark.setAttribute('aria-hidden','true');
      target.prepend(mark);
    }
    if (mark.dataset.porcelainGlyph !== name) mark.dataset.porcelainGlyph = name;
  }

  function decorate() {
    if (root.dataset.theme !== 'porcelain') return;
    document.querySelectorAll('.sidebar nav a[data-view]').forEach(link => {
      // Keep the fallback character for the other themes without leaving an
      // anonymous layout item between the new icon and the accessible label.
      for (const node of [...link.childNodes]) {
        if (node.nodeType !== 3 || !node.textContent.trim()) continue;
        const symbol = document.createElement('span');
        symbol.className = 'porcelain-nav-symbol';
        symbol.setAttribute('aria-hidden','true');
        symbol.textContent = node.textContent;
        node.replaceWith(symbol);
      }
      paint(link, tabIcons[link.dataset.panelTab] ?? viewIcons[link.dataset.view]);
    });
    document.querySelectorAll('.control-tabs button[data-tab],.control-subtabs button[data-tab]').forEach(button => {
      paint(button, tabIcons[button.dataset.tab]);
    });
    document.querySelectorAll('button[data-action]').forEach(button => {
      paint(button, button.dataset.action === 'control-run' ? commands[button.dataset.command] : actions[button.dataset.action]);
    });
    paint(document.querySelector('.appearance-open'), 'appearance');
    document.querySelectorAll('.device-symbol,.device-pill i').forEach(holder => {
      paint(holder, symbols[holder.textContent.trim()] ?? 'device');
    });
    document.querySelectorAll('.task-light-card').forEach(card => {
      paint(card.querySelector('h3 i'), states[card.dataset.lightState]);
    });
    document.querySelectorAll('[data-shortcut-symbol]').forEach(holder => paint(holder, shortcutIcons[holder.dataset.shortcutSymbol]));
    document.querySelectorAll('.overview-language-entry').forEach(entry => paint(entry, 'globe'));
    document.querySelectorAll('.language-arrow').forEach(arrow => paint(arrow, 'arrow'));
    document.querySelectorAll('.language-check').forEach(check => paint(check, 'check'));
  }

  function schedule() {
    if (scheduled || root.dataset.theme !== 'porcelain') return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      decorate();
    });
  }
  const observer = new MutationObserver(schedule);
  observer.observe(root, {attributes:true, attributeFilter:['data-theme']});
  observer.observe(document.querySelector('#content'), {childList:true, subtree:true});
  schedule();
})();
