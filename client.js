/**
 * Browser half of the DSHCodeServerView bundle.
 *
 * Artifact contract: this file is the package's exported `./client` bundle, so
 * the Client module loader materializes it as a lazy CJS factory. The factory
 * resolves React through the injected `require` (the shell's frozen platform
 * module table — never a second React copy) and returns an ordinary Cordis
 * plugin whose `apply` registers everything.
 *
 * The feature: one right-Sidebar tab type, offered as a capsule on the
 * Sidebar's guide page, whose body frames a running code-server (VS Code Web)
 * instance. Registration follows the tab system's two stages — the type into
 * `ctx.sidebarRightTabs`, then the body and the chip title into the keyed
 * `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats under the
 * type's own id — so the panel is a native Sidebar page (docking, tab strip,
 * fullscreen, per-Session layout) rather than a floating overlay.
 *
 * The address, the optional auto-login, and the process state all come from the
 * Host half's config route: this half reads `/codeserver-view/config` (same
 * origin, no secret in it), frames either that address directly or the Host's
 * `/codeserver-view/login` page (which performs code-server's password login
 * inside the browser), and shows the supervisor's state while a managed
 * code-server starts, fails, or is restarted. The password itself never reaches
 * this bundle. A host without those routes, or an opener that passes
 * `{ params: { url } }`, falls back to framing a URL directly.
 *
 * @see packages/client/ui-sidebar-right/src/client/contract/slots.ts
 * @see packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/client.js
 */
window.__ModuleLoader__.load({
  id: 'DSHCodeServerView',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin's chrome. */
    const NS = 'DSHCodeServerView';
    /** Tab-type identity: unique in the tab system, and the keyed seat key. */
    const TAB_ID = 'DSHCodeServerView';
    /** Tab-kind discriminator that `openTab` names. */
    const KIND = 'code-server-view';
    /** code-server instance framed when the Host publishes no configuration. */
    const DEFAULT_URL = 'http://127.0.0.1:8080/';
    /** Host route publishing `{ url, autoLogin, hasPassword, supervisor }`. */
    const CONFIG_ROUTE = '/codeserver-view/config';
    /** Host route that logs the browser into code-server and forwards it there. */
    const LOGIN_ROUTE = '/codeserver-view/login';
    /** Host route that asks the supervisor to restart a managed code-server. */
    const RESTART_ROUTE = '/codeserver-view/restart';
    /** How often the panel re-reads the configuration while code-server starts. */
    const POLL_MS = 1500;

    /** Chinese copy. Keys are flat and dotted, matching the Client locale service. */
    const zh = {
      'type.label': 'VS Code',
      'guide.title': 'VS Code',
      'guide.description': '在右侧栏内嵌 code-server 的 VS Code 网页版',
      'frame.title': 'VS Code（code-server）',
      'status.connecting': '正在读取插件配置…',
      'status.starting': '正在启动 code-server…',
      'status.running': '运行中',
      'status.attached': '已接管现有实例',
      'status.exited': 'code-server 已退出',
      'status.error': 'code-server 启动失败',
      'status.stopped': '已停止',
      'status.idle': '未运行',
      'status.off': '未托管',
      'action.reload': '重新加载',
      'action.restart': '重启 code-server',
      'action.external': '在浏览器标签页中打开',
    };

    /** English copy. Keys are flat and dotted, matching the Client locale service. */
    const en = {
      'type.label': 'VS Code',
      'guide.title': 'VS Code',
      'guide.description': 'Embed a code-server (VS Code Web) instance in the right sidebar',
      'frame.title': 'VS Code (code-server)',
      'status.connecting': 'Reading the plugin configuration…',
      'status.starting': 'Starting code-server…',
      'status.running': 'Running',
      'status.attached': 'Attached to a running instance',
      'status.exited': 'code-server exited',
      'status.error': 'code-server failed to start',
      'status.stopped': 'Stopped',
      'status.idle': 'Not running',
      'status.off': 'Not managed',
      'action.reload': 'Reload',
      'action.restart': 'Restart code-server',
      'action.external': 'Open in a browser tab',
    };

    /**
     * The address an opener asked for through the tab's navigation parameters.
     * A page type opened from the guide carries none, so the configuration (or
     * the built-in default) applies instead.
     * @param params - the opener's navigation parameters, when it gave any.
     * @returns the requested absolute URL, or undefined when none was given.
     */
    function parameterUrl(params) {
      const requested = params !== null && typeof params === 'object' && typeof params.url === 'string'
        ? params.url.trim()
        : '';
      return requested.length > 0 ? requested : undefined;
    }

    /**
     * Resolve what the frame loads and what the toolbar names.
     *
     * The address shown is always the configured code-server address; the frame
     * may instead load the Host's login route, which ends up at that same
     * address already authenticated.
     * @param config - the Host configuration, or undefined when unavailable.
     * @param override - an opener's explicit URL, which wins over everything.
     * @returns the frame source and the address to display.
     */
    function frameTarget(config, override) {
      if (override !== undefined) return { src: override, address: override };
      const address = typeof config?.url === 'string' && config.url.length > 0 ? config.url : DEFAULT_URL;
      const logIn = config?.hasPassword === true && config.autoLogin !== false;
      return { src: logIn ? LOGIN_ROUTE : address, address };
    }

    /**
     * Read the Host's published configuration once.
     * @param settle - receives the parsed configuration, or null when the Host
     * does not answer (a page served without the plugin's routes, or offline).
     * @returns a disposer that stops the update after the body unmounted.
     */
    function readConfig(settle) {
      let live = true;
      const finish = (value) => { if (live) settle(value); };
      if (typeof fetch !== 'function') {
        finish(null);
        return () => { live = false; };
      }
      try {
        fetch(CONFIG_ROUTE, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : null))
          .then((value) => { finish(value ?? null); })
          .catch(() => { finish(null); });
      } catch {
        finish(null);
      }
      return () => { live = false; };
    }

    /**
     * Ask the Host to restart a managed code-server.
     * @param done - called after the Host answered, whatever the outcome.
     * @returns nothing.
     */
    function requestRestart(done) {
      if (typeof fetch !== 'function') {
        done();
        return;
      }
      try {
        fetch(RESTART_ROUTE, { method: 'POST', credentials: 'same-origin' })
          .then(() => { done(); })
          .catch(() => { done(); });
      } catch {
        done();
      }
    }

    /**
     * Original code-brackets glyph, drawn by this plugin (no trademarked artwork).
     * @param props - `size` in pixels, plus optional `style` and `className`.
     * @returns the SVG element.
     */
    function CodeServerIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        'aria-hidden': true,
        focusable: false,
        className: props?.className,
        style: props?.style,
      },
        h('path', {
          d: 'M9.2 6.4 4.8 12l4.4 5.6',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M14.8 6.4 19.2 12l-4.4 5.6',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 12, cy: 12, r: 1.7, fill: 'currentColor' }),
      );
    }

    /* Host theme tokens only: a renamed token degrades appearance, never rendering. */
    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      frame: {
        display: 'flex',
        flex: '1 1 auto',
        width: '100%',
        minHeight: 0,
        border: 0,
        background: 'var(--dsw-alias-bg-base)',
      },
      notice: {
        display: 'flex',
        flex: '1 1 auto',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        minHeight: 0,
        padding: 24,
        textAlign: 'center',
        color: 'var(--dsw-alias-label-tertiary)',
        font: 'var(--dsw-font-xs-13)',
      },
      noticeTitle: {
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 500,
      },
      noticeDetail: {
        maxWidth: '100%',
        overflowWrap: 'anywhere',
        font: 'var(--dsw-font-xxxs-11)',
      },
      bar: {
        display: 'flex',
        flex: '0 0 auto',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 8px',
        borderTop: '0.5px solid var(--dsw-alias-border-l3)',
        font: 'var(--dsw-font-xxxs-11)',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      barLabel: {
        flex: '1 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      barState: {
        flex: '0 0 auto',
        padding: '0 6px',
        lineHeight: '16px',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-interactive-bg-hover)',
      },
      barButton: {
        flex: '0 0 auto',
        height: 22,
        padding: '0 8px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'transparent',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        font: 'inherit',
        cursor: 'pointer',
      },
      titleIcon: {
        flex: '0 0 auto',
        marginRight: 4,
      },
    };

    /**
     * The tab body: the framed code-server instance, its supervision state, and
     * its local controls.
     *
     * The Host configuration is read once per mount and re-read while a managed
     * code-server is still starting, so the pane never frames a port that is not
     * listening yet. A tab opened with an explicit URL skips the read entirely.
     * The frame is keyed by a revision so Reload remounts it — a code-server
     * workbench that lost its websocket is not recovered by `src` assignment,
     * and a login route must run again rather than be reloaded from cache.
     * @param props - the seat's tab information hook and the plugin's `t`.
     * @returns the panel element.
     */
    function CodeServerBody(props) {
      const { useTabInfo, t } = props;
      const { tab } = useTabInfo();
      const override = parameterUrl(tab.navigation && tab.navigation.params);
      const [config, setConfig] = React.useState(undefined);
      const [revision, setRevision] = React.useState(0);

      const read = React.useCallback(() => {
        if (override !== undefined) return undefined;
        return readConfig(setConfig);
      }, [override]);

      React.useEffect(read, [read]);

      const supervisor = config?.supervisor;
      const managed = supervisor?.mode === 'managed';
      const starting = supervisor?.state === 'starting' || supervisor?.state === 'idle';

      // While code-server comes up, keep asking the Host for its state.
      React.useEffect(() => {
        if (override !== undefined || !starting || typeof setInterval !== 'function') return undefined;
        const timer = setInterval(() => { readConfig(setConfig); }, POLL_MS);
        return () => { clearInterval(timer); };
      }, [override, starting]);

      const loading = override === undefined && config === undefined;
      const broken = !loading && managed && (supervisor?.state === 'exited' || supervisor?.state === 'error');
      const waiting = loading || (!broken && override === undefined && starting);
      const target = waiting || broken ? undefined : frameTarget(config ?? undefined, override);
      const stateKey = loading ? 'status.connecting' : `status.${supervisor?.state ?? 'running'}`;

      const restart = () => {
        setConfig(undefined);
        requestRestart(() => { readConfig(setConfig); });
      };

      return h('div', { style: styles.root },
        waiting
          ? h('div', { style: styles.notice },
            h('div', { style: styles.noticeTitle }, loading ? t('status.connecting') : t('status.starting')),
            supervisor?.message === undefined ? null : h('div', { style: styles.noticeDetail }, supervisor.message))
          : broken
            ? h('div', { style: styles.notice },
              h('div', { style: styles.noticeTitle }, t(stateKey)),
              h('div', { style: styles.noticeDetail }, supervisor?.message ?? target?.address ?? ''),
              h('button', { type: 'button', style: styles.barButton, title: t('action.restart'), onClick: restart },
                t('action.restart')))
            : h('iframe', {
              key: `${target.src}#${revision}`,
              src: target.src,
              title: t('frame.title'),
              allow: 'clipboard-read; clipboard-write; fullscreen',
              style: styles.frame,
            }),
        h('div', { style: styles.bar },
          h('span', { style: styles.barLabel, title: target?.address ?? supervisor?.root ?? '' },
            target?.address ?? supervisor?.root ?? t('status.connecting')),
          supervisor?.mode === 'off' ? null : h('span', { style: styles.barState, title: supervisor?.message ?? '' }, t(stateKey)),
          broken ? null : h('button', {
            type: 'button',
            style: styles.barButton,
            title: t('action.reload'),
            onClick: () => { setRevision((value) => value + 1); },
          }, t('action.reload')),
          managed ? h('button', {
            type: 'button',
            style: styles.barButton,
            title: t('action.restart'),
            onClick: restart,
          }, t('action.restart')) : null,
          h('button', {
            type: 'button',
            style: styles.barButton,
            title: t('action.external'),
            onClick: () => { window.open(target?.address ?? DEFAULT_URL, '_blank', 'noopener,noreferrer'); },
          }, t('action.external')),
        ),
      );
    }

    /**
     * The tab chip: the glyph before the title captured when the tab opened.
     * @param props - the seat's tab information hook.
     * @returns the chip contents.
     */
    function CodeServerTitle(props) {
      const { tab } = props.useTabInfo();
      return h(React.Fragment, null,
        h(CodeServerIcon, { size: 16, style: styles.titleIcon }),
        tab.title,
      );
    }

    return {
      name: 'DSHCodeServerView',
      // Client service names, not packages: activation waits for each service.
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'DSHCodeServerView: copy');

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          // Each open is independent content: several folders, several windows.
          multiple: true,
          // An outside implementation never outranks a product type.
          priority: 'extension',
          title: () => t('type.label'),
          guide: [{
            id: 'new',
            order: 50,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: CodeServerIcon,
          }],
        }), 'DSHCodeServerView: tab type');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
        }, CodeServerBody)), 'DSHCodeServerView: body');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
          locale: NS,
        }, CodeServerTitle)), 'DSHCodeServerView: title');
      },
    };
  },
});
