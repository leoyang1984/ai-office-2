// A small official-slot contribution. The original DSH conversation UI is unchanged.
window.__ModuleLoader__.load({
  id: '@office/native-controls',
  factory(require) {
    const { createElement: h } = require('react');
    const inject = ['slots'];
    function Download({ sessionId, absolutePath }) {
      if (!sessionId || !absolutePath?.startsWith('/tenant/workspace/')) return null;
      return h('a', {
        href: '/dsh/office/download?' + new URLSearchParams({ sessionId, path: absolutePath }),
        download: '', title: '下载文件', 'aria-label': '下载文件',
        style: { padding: '4px 8px', color: 'inherit', fontSize: '13px', textDecoration: 'none' },
      }, '下载文件');
    }
    function Account() {
      return h('div', { style: { position: 'fixed', top: '8px', right: '52px', zIndex: 1000, display: 'flex', gap: '8px',
        fontSize: '12px', padding: '4px 8px', background: 'var(--surface-primary, white)', borderRadius: '6px' } },
      h('a', { href: '/?manage=1', style: { color: 'inherit' } }, '办公室账户'),
      h('button', { type: 'button', onClick: async () => {
        const result = await fetch('/api/v1/auth/logout', { method: 'POST' });
        if (result.ok || result.status === 401) location.replace('/');
      }, style: { cursor: 'pointer', fontSize: '12px' } }, '退出办公室'));
    }
    function apply(ctx) {
      ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
        name: 'sidebar.right.tab.document.actions', id: 'office-download', order: 20,
      }, Download));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'office-account' }, Account));
    }
    return { inject, apply };
  },
});
