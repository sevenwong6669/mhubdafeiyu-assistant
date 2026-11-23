window.__ModuleLoader__.load({
  id: 'dsh-mhub-community-v11',
  factory: require => {
    const React = require('react');
    function Panel() {
      return React.createElement('iframe', { title: '迈从大肥鱼插件', src: '/api/mhub-community/panel',
        style: { width: '100%', height: 'min(1500px, 82vh)', minHeight: '650px', border: 0, borderRadius: '18px', background: '#f5f6f2' } });
    }
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'mhub-community', order: 18, label: () => '迈从大肥鱼插件' }, Panel));
    }
    return { name: 'mhub-community-panel', inject: ['slots'], apply };
  },
});
