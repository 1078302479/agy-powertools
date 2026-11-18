(() => {
  const version = '2.12.3';
  if (globalThis.__agyPowertools?.version === version) return;
  globalThis.__agyPowertools?.dispose();
  if (!document.head || !document.body || !globalThis.ReactDOM?.createRoot || typeof HC !== 'function') {
    if (!globalThis.__agyPowertoolsPending) {
      globalThis.__agyPowertoolsPending = true;
      const retry = () => { delete globalThis.__agyPowertoolsPending; initialize(); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', retry, { once: true });
      else setTimeout(retry, 200);
    }
    return;
  }
  initialize();

  function initialize() {
    if (globalThis.__agyPowertools) return;
    if (!document.body || !globalThis.ReactDOM?.createRoot || typeof HC !== 'function') return;
    const R = globalThis.React;
    const h = R.createElement;
    const adapter = globalThis.__agyNativeAdapter;
    if (!adapter) return;
    const roots = new Map(), pending = new Map(), changedLabels = new Map();
    let sequence = 0, state = null, lastId = '', busy = false, disposed = false;
    let nativeRunFork = null, notify = null;
    const defaults = { enabled: true, compact: true, contextRing: true, timing: true, toolDetails: true, responseBranch: true, messageEdit: true, progress: true, keepTurnOutline:true, keepOverviewOpen:true, stageUpdates:true, efficientIO:false, language: 'zh-CN', contextLimit: 0 };
    let options = { ...defaults,...globalThis.__agyInitialSettings }, settingsLoaded = false;
    const t = text => globalThis.__agyI18n?.t(text, options.language) || text;
    const localizer = globalThis.__agyLocalization;
    const listeners = new Set(); let revision = 0, dashboard = null, account = null, estimates = [], lastConversation = null, lastAccountAt = 0, loadingDashboard = null, pageInstalled = false;
    const emit = () => { revision++; for (const listener of listeners) listener(); };
    let renderError='';
    const Boundary=R.Component?class extends R.Component{
      constructor(props){super(props);this.state={failed:false};}
      static getDerivedStateFromError(){return{failed:true};}
      componentDidCatch(error){renderError=error.message;}
      render(){return this.state.failed?(this.props.page?h('div',{role:'alert',className:'p-6 text-muted-foreground'},options.language==='en'?'Powertools needs an update':'Powertools 需要更新'):null):this.props.children;}
    }:null;
    const signalController = new AbortController();
    const densityStyle = document.createElement('style');
    densityStyle.dataset.agyDensityStyle = '';
    densityStyle.textContent = `
      html[data-agy-keep-outline] [data-testid="overview-panel-host"][style*="--overview-panel-reserve: 336px"],
      html[data-agy-keep-outline] [data-testid="overview-panel-host"][style*="--overview-panel-reserve:336px"]{--conversation-nav-reserve:3.5rem}
      html[data-agy-compact] [data-testid="agent-response"]{line-height:1.4}
      html[data-agy-compact] [data-testid="agent-response"] :is([data-markdown-root],p,li,pre,code,button,.text-base){line-height:1.4}
      html[data-agy-compact] [data-testid="agent-response"] :is(.text-sm,.text-compact){line-height:1.4}
      html[data-agy-compact] [data-testid="agent-response"] :is([data-testid="worked-for-collapsible"],[data-testid="agy-completion-tools-toggle"],[data-testid="tool-group-collapsible"],div.group.min-h-8){min-height:24px;padding-block:2px}
      html[data-agy-compact] [data-testid="agent-response"] [data-testid="cascade-system-message-toolbar"]{gap:4px}
      html[data-agy-compact] [data-testid="cascade-system-message-toolbar"]{line-height:1.4;gap:4px}
      html[data-agy-compact] [data-testid="cascade-system-message-toolbar"] :is([data-markdown-root],p,pre,code,button,.text-base){line-height:1.4}
      html[data-agy-compact] [data-testid="cascade-system-message-toolbar"] :is(p,ul,ol){margin-block:.35em}
      html[data-agy-compact] [data-testid="user-input-step"],html[data-agy-compact] [data-testid="user-input-step"] .text-base{line-height:1.4}
      /* Native markdown is a flex column. Keep one source of block spacing,
         including the host's important heading and divider margins. */
      html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root]{line-height:1.4;gap:0}
      html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] :is(p,ul,ol,blockquote){margin-block:0}
      html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] > :not(style) + :not(style){margin-block-start:8px}
      html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] :is(h1,h2,h3,h4,h5,h6){line-height:1.4}
      html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] li{margin-block:2px}
      html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] :is(li,blockquote) > :not(style) + :not(style){margin-block-start:6px}
      /* Important native utilities live in a cascade layer. An earlier host
         layer is required to override them, regardless of specificity. */
      @layer theme {
        html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] :is(h1,h2,h3,h4,h5,h6){margin-block:12px 0!important}
        html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] blockquote > :first-child{margin-block-start:0!important}
        html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] hr{margin-block:12px!important}
        html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] hr + :not(style){margin-block-start:0!important}
        html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] > :first-child,html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] > style + :not(style){margin-block-start:0!important}
        html[data-agy-compact] [data-testid="agent-response"] [data-markdown-root] > :last-child{margin-block-end:0!important}
      }
      html[data-agy-compact] [data-testid="user-input-step"]{padding-top:.75rem}
      html[data-agy-compact] [data-agy-powertools-root="completion"]{margin-block:.125rem}
      [data-testid="user-input-step"][data-agy-editing-target]{align-items:stretch!important}
      [data-testid="user-input-step"][data-agy-editing-target] > :not([data-agy-editor-slot]){display:none!important}
      [data-agy-editor-slot]{width:100%}
    `;
    document.head.append(densityStyle);
    const request = (method, payload) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(t('连接中断'))); }, method === 'pricing.refresh' ? 18000 : 10000);
      pending.set(id, { resolve, reject, timer });
      globalThis.__agyPowertoolsHost(JSON.stringify({ id, method, ...payload }));
    });
    globalThis.__agyPowertoolsReceive = (id, reply) => {
      const entry = pending.get(id); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(id);
      reply.error ? entry.reject(new Error(reply.error)) : entry.resolve(reply);
    };
    let settingsError = '';
    const applyOptions=()=>{if((!options.enabled||!options.messageEdit)&&adapter.pendingEdit)adapter.cancelEdit?.();adapter.setEnabled?.(options.enabled);adapter.setStageUpdates?.(options.stageUpdates);adapter.setEfficientIO?.(options.efficientIO);adapter.setContextLimit?.(options.contextLimit);};
    const changeSettings = async patch => {
      try { options = {...defaults,...await request('settings.set', { settings: patch })}; applyOptions();settingsError=''; mount(); }
      catch(error){settingsError=error.message;}
      emit();
    };
    let loadingAccount;
    function refreshAccount(){
      if(loadingAccount)return loadingAccount;
      lastAccountAt=Date.now();
      loadingAccount=adapter.service().retrieveUserQuotaSummary({}).then(reply=>{
        account=reply.response;emit();
        const groups=(account?.groups||[]).map(g=>({displayName:g.displayName,buckets:g.buckets.map(b=>({bucketId:b.bucketId,window:b.window,remainingFraction:b.remaining?.case==='remainingFraction'?b.remaining.value:null,resetTimeMs:b.resetTime?Number(b.resetTime.seconds)*1000:null}))}));
        return request('quota.observe',{groups});
      }).then(reply=>{estimates=reply.estimates;emit();}).finally(()=>{loadingAccount=null;});
      return loadingAccount;
    }
    const loadDashboard = force => {
      if (loadingDashboard) return loadingDashboard;
      loadingDashboard = Promise.all([request('dashboard', {force:!!force}),force?refreshAccount():null]).then(([data])=>{dashboard=data;emit();return data;}).finally(()=>{loadingDashboard=null;});
      return loadingDashboard;
    };
    const panels = globalThis.__agyPanels?.({ adapter, t, version, defaults, project:globalThis.__agyProject, state:()=>state||lastConversation, options:()=>options, account:()=>account,
      currentState:()=>state?.conversationId===currentId()?state:null,
      dashboard:()=>dashboard, estimates:()=>estimates, capabilities:()=>adapter.capabilities?.(), settingsError:()=>settingsError, change:changeSettings, request, loadDashboard,navigateTurn:turn=>adapter.navigateTurn?.(turn),
      subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}, revision:()=>revision });
    const currentId = () => location.pathname.match(/^\/c\/([a-zA-Z0-9_-]+)/)?.[1] || '';
    let overviewSnapshot=null, overviewNavigation=null, mountedConversationId='';
    const rememberOverview = event => {
      const link=event.target.closest?.('a[href^="/c/"]');
      if(!link||!options.enabled||!options.keepOverviewOpen)return;
      const nextId=link.getAttribute('href')?.match(/^\/c\/([a-zA-Z0-9_-]+)/)?.[1];
      const panel=adapter.overview?.();
      if(nextId&&nextId!==currentId()&&panel?.cascadeId===currentId()){
        // Capture before the native outside-click handler dismisses an overlay.
        // Preserve the pointerdown snapshot through the following click event.
        if(overviewNavigation?.id!==nextId)overviewNavigation={id:nextId,open:panel.isPanelVisible,at:Date.now()};
      }
    };
    document.addEventListener('pointerdown',rememberOverview,{capture:true,signal:signalController.signal});
    document.addEventListener('click',rememberOverview,{capture:true,signal:signalController.signal});
    const stopOverviewNavigation=adapter.router?.()?.subscribe?.('onBeforeNavigate',event=>{
      if(adapter.pendingEdit)adapter.cancelEdit?.({restoreDraft:false});
      if(!options.enabled||!options.keepOverviewOpen)return;
      const id=event.toLocation?.pathname?.match(/^\/c\/([a-zA-Z0-9_-]+)/)?.[1];
      const panel=adapter.overview?.();
      if(id&&panel&&panel.cascadeId!==id&&!(overviewNavigation?.id===id&&Date.now()-overviewNavigation.at<5000)){
        overviewNavigation={id,open:panel.isPanelVisible,at:Date.now()};
      }
    });
    function followOverview(){
      const id=currentId(),panel=adapter.overview?.();
      if(!id||panel?.cascadeId!==id)return;
      if(!options.enabled||!options.keepOverviewOpen){overviewNavigation=null;overviewSnapshot={id,open:panel.isPanelVisible};return;}
      if((overviewNavigation?.id===id||overviewSnapshot&&overviewSnapshot.id!==id)&&options.keepOverviewOpen){
        const carry=overviewNavigation?.id===id&&Date.now()-overviewNavigation.at<5000?overviewNavigation.open:overviewSnapshot?.open;
        overviewNavigation=null;
        if(carry&&!panel.isPanelVisible){
          if(panel.presentation==='dropdown')panel.setDropdownOpen(true);
          else if(panel.breakpoint==='small')panel.setOverlayOpen(true);
          else panel.togglePanel();
        }
      }
      overviewSnapshot={id,open:panel.isPanelVisible};
    }
    const tokens = n => n == null ? '-' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    const duration = ms => ms == null ? '-' : options.language==='en' ? ms>=60000?`${Math.floor(ms/60000)}m ${Math.floor(ms%60000/1000)}s`:`${Math.max(0,Math.round(ms/1000))}s` : ms >= 60000 ? `${Math.floor(ms / 60000)}分${Math.floor(ms % 60000 / 1000)}秒` : `${Math.max(0, Math.round(ms / 1000))}秒`;
    const completed = iso => `${options.language==='en'?'Completed at':'完成于'} ${new Date(iso).toLocaleString(options.language, { hour12: false })}`;
    const row = (label, value, key) => h('div', { key, className: 'flex items-center justify-between gap-3 px-2 py-1 text-compact tabular-nums' },
      h('span', { className: 'text-muted-foreground' }, t(label)), h('span', { className: 'text-foreground whitespace-nowrap' }, value));
    function CacheObservation({data}){
      const [now,setNow]=R.useState(Date.now);
      R.useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
      const cache=globalThis.__agyDashboard.cacheObservation(data.requests,now);
      if(!cache)return null;
      const seconds=Math.ceil((cache.remainingMs||0)/1000),value=cache.remainingMs>0?`≈ ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:options.language==='en'?'Unconfirmed':'待确认';
      const tip=options.language==='en'?`Five-minute observation window from the last request start, not a server expiry. Last request cache hits: ${cache.hitPercent}%.`:`按最近请求开始时间计算的五分钟观察窗口，不代表服务端实际到期。最近请求缓存命中 ${cache.hitPercent}%。`;
      return h('div',{title:tip,'data-testid':'agy-cache-observation','data-estimated':'true'},row(options.language==='en'?'Cache window':'缓存观察',value,'cache-window'));
    }
    const separator = key => h('div', { key, className: 'h-px bg-border my-2 -mx-1' });
    const contextPalette = {
      'Chat Messages': '#2563eb',
      'System Prompt': '#ea580c',
      'Tools': '#0d9488',
      'MCP Tools': '#64748b',
      'MCP tools': '#64748b',
      'Skills': '#78716c',
      'Subagents': '#6366f1',
      'Plugins': '#8b5cf6',
      'Rules': '#94a3b8',
      'Memories': '#a1a1aa',
      'Memory files': '#a1a1aa',
      'Unspecified': '#9ca3af',
      '输入上下文': '#2563eb'
    };
    const fallbackSwatches = ['#64748b', '#78716c', '#94a3b8', '#a1a1aa'];
    const contextCategoryName = (raw, en) => {
      const map = en
        ? { 'Chat Messages': 'Messages', 'System Prompt': 'System prompt', 'Tools': 'System tools', 'MCP Tools': 'MCP tools', 'MCP tools': 'MCP tools', 'Skills': 'Skills', 'Subagents': 'Subagents', 'Plugins': 'Plugins', 'Rules': 'Rules', 'Memories': 'Memory files', 'Memory files': 'Memory files', 'Unspecified': 'Other', '输入上下文': 'Input context', '剩余空间': 'Free space' }
        : { 'Chat Messages': '消息', 'System Prompt': '系统提示', 'Tools': '系统工具', 'MCP Tools': 'MCP 工具', 'MCP tools': 'MCP 工具', 'Skills': '技能', 'Subagents': '子智能体', 'Plugins': '插件', 'Rules': '规则', 'Memories': '记忆文件', 'Memory files': '记忆文件', 'Unspecified': '其他开销', '输入上下文': '输入上下文', '剩余空间': '剩余空间' };
      return map[raw] || (en ? raw : t(raw));
    };
    const categoryRank = label => {
      if (label === 'Chat Messages' || label === '输入上下文') return 0;
      if (label === 'System Prompt') return 1;
      if (label === 'Tools') return 2;
      if (label === '剩余空间') return 99;
      return 10;
    };

    function Ring({ percent }) {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 18 18', className: 'shrink-0 -rotate-90', 'aria-hidden': true },
        h('circle', { cx: 9, cy: 9, r: 6.5, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.2, strokeWidth: 2 }),
        h('circle', { cx: 9, cy: 9, r: 6.5, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeDasharray: 40.84,
          strokeDashoffset: 40.84 * (1 - Math.min(100, Math.max(0, percent || 0)) / 100) }));
    }

    function ContextDetails({ data }) {
      const cw = data.contextWindow, stats = data.telemetry, en = options.language === 'en';
      const categories = [...cw.categories].sort((a, b) => {
        const ra = categoryRank(a.label), rb = categoryRank(b.label);
        if (ra !== rb) return ra - rb;
        return (b.tokens || 0) - (a.tokens || 0);
      });
      const colorFor = (c, idx) => c.key === 'free' ? 'var(--secondary)' : (contextPalette[c.label] || fallbackSwatches[idx % fallbackSwatches.length]);
      const usedHeadline = cw.usedPercent == null
        ? tokens(cw.usedTokens)
        : (en ? `${cw.usedPercent}% used` : `已使用 ${cw.usedPercent}%`);
      const capacityRight = cw.maxTokens == null
        ? tokens(cw.usedTokens)
        : `${tokens(cw.usedTokens)} / ${tokens(cw.maxTokens)}`;
      const sectionTip = en
        ? 'Total usage comes from the latest model request; category shares follow client-side estimation.'
        : '总用量来自最近一次模型请求，各分类占比按客户端估算折算。';
      return h(R.Fragment, null,
        h('div', { className: 'flex flex-col px-2 pt-1.5 pb-1', 'data-testid': 'agy-context-breakdown' },
          h('div', { className: 'text-compact text-muted-foreground mb-1.5', title: sectionTip }, en ? 'Context' : '上下文窗口'),
          h('div', { className: 'flex items-baseline justify-between gap-3 mb-2 tabular-nums', title: sectionTip },
            h('span', { className: 'text-sm font-semibold text-foreground' }, usedHeadline),
            h('span', { className: 'text-compact text-muted-foreground whitespace-nowrap' }, capacityRight)),
          h('div', {
            style: { display: 'flex', height: 6, gap: 1, borderRadius: 9999, overflow: 'hidden', background: 'var(--secondary)', marginBottom: 10 },
            role: cw.usedPercent == null ? 'img' : 'meter',
            'aria-label': '上下文用量',
            'aria-valuenow': cw.usedPercent ?? undefined,
            'aria-valuemin': 0,
            'aria-valuemax': 100
          },
            categories.filter(c => c.key !== 'free' && (c.percent || 0) > 0).map((c, i) => h('span', {
              key: c.key,
              style: { width: `${Math.max(0.4, c.percent || 0)}%`, background: colorFor(c, i), height: '100%' }
            }))),
          h('div', { className: 'flex flex-col gap-0.5' },
            ...categories.map((c, i) => h('div', {
              key: c.key,
              className: 'flex items-center gap-2.5 py-1 text-compact tabular-nums'
            },
              h('span', {
                style: {
                  width: 10,
                  height: 10,
                  borderRadius: 2.5,
                  flexShrink: 0,
                  background: colorFor(c, i),
                  boxShadow: c.key === 'free' ? 'inset 0 0 0 1px var(--border)' : 'none'
                }
              }),
              h('span', { className: 'flex-1 min-w-0 truncate text-secondary-foreground' }, contextCategoryName(c.label, en)),
              h('span', { className: 'text-muted-foreground text-right whitespace-nowrap' }, tokens(c.tokens)),
              h('span', { className: 'text-foreground font-medium text-right whitespace-nowrap', style: { minWidth: '3.4em' } }, c.percent == null ? '-' : `${Number(c.percent).toFixed(1)}%`))))),
        separator('stats-separator'),
        h('div', { className: 'px-2 pt-1 pb-1 text-compact text-muted-foreground' }, t('会话统计')),
        row('轮次 / 步数', `${stats.turnCount} / ${stats.stepCount}`, 'turns'),
        row('累计 Token', tokens(stats.totalTokens), 'tokens'),
        row('平均速度', stats.tps == null ? tokens(null) : `${stats.tps} tok/s`, 'speed'),
        h('div',{title:t('峰值为单次请求的最高平均速度。')},row('峰值速度', stats.peakTps == null ? tokens(null) : `${stats.peakTps} tok/s`, 'peak')),
        row('最近速度', stats.latestTps == null ? tokens(null) : `${stats.latestTps} tok/s`, 'latest'),
        row('缓存命中', stats.cacheHitPercent == null ? tokens(null) : `${stats.cacheHitPercent}%`, 'cache'),
        h(CacheObservation,{data}),
        h(k0,{trigger:options.language==='en'?'More statistics':'更多统计',defaultExpanded:false},
          row('输入',tokens(stats.inputTokens),'input'),row('缓存读取',tokens(stats.cacheReadTokens),'cache-tokens'),row('输出',tokens(stats.outputTokens),'output'),
          row('思考 Token',tokens(stats.thinkingTokens),'thinking'),row('请求次数',String(stats.requestCount),'requests'),row('错误次数',String(stats.errorCount),'errors'),row('工具调用',String(stats.toolCount),'tool-count')),
        separator('time-separator'),
        row('模型用时', duration(stats.modelTimeMs), 'model'), row('工具用时', duration(stats.toolTimeMs), 'tools'),
        row('首 Token 延迟', duration(stats.avgTtftMs), 'ttft'));
    }

    function NativeEntry({ data }) {
      // Use the exact same providers, components, portals and motion as Antigravity.
      const fork = Mmc();
      const toast = um();
      R.useEffect(() => { nativeRunFork = fork.runFork; notify = toast; }, [fork.runFork, toast]);
      if (!data?.conversationId || !options.contextRing) return null;
      const cw = data.contextWindow;
      const ringText = cw.usedPercent == null
        ? ((cw.usedTokens || 0) > 0 ? tokens(cw.usedTokens) : '')
        : (cw.usedPercent > 0 ? `${cw.usedPercent}%` : '');
      return h(HC, { placement: 'top-end', disableMobileSheet: false },
        h(IC, { asChild: true }, h(Uy, {
          variant: 'ghost', size: ringText ? 'sm' : 'icon', type: 'button',
          'aria-label': t('上下文与会话统计'), 'data-testid': 'agy-context-ring-trigger',
          className: `${ringText ? 'gap-1.5 ' : ''}text-muted-foreground`,
          style: { color: cw.usedPercent >= 95 ? 'var(--error)' : cw.usedPercent >= 80 ? 'var(--warning)' : undefined }
        }, h(Ring, { percent: cw.usedPercent }), ringText ? h('span', { className: 'text-sm tabular-nums' }, ringText) : null)),
        h(JC, { className: '!w-80 max-h-[80vh] overflow-y-auto', 'data-testid': 'agy-context-popup', 'aria-label': t('上下文与会话统计'), role: 'dialog' }, h(ContextDetails, { data })));
    }

    function ToolDetails({ turn }) {
      return h('div', { className: 'flex flex-col pl-3', 'data-testid': 'agy-tool-details' }, ...turn.toolGroups.map(group =>
        h(k0, { key: group.groupKey, trigger: `${group.groupLabel} (${group.items.length})`, defaultExpanded: true },
          ...group.items.map(item => h(k0, { key: item.id, trigger: h('span', { className: 'truncate text-sm' }, item.itemLabel) },
            h('div', { className: 'px-2 py-1 text-sm text-muted-foreground' },
              h('pre', { className: 'whitespace-pre-wrap break-words rounded-md bg-secondary p-2 overflow-auto max-h-52' }, item.detailTitle),
              item.outputPreview && h('pre', { className: 'whitespace-pre-wrap break-words rounded-md bg-secondary p-2 overflow-auto max-h-52' }, item.outputPreview)))))));
    }

    function Completion({ turn, tooltipOnly, tooltipId }) {
      return h(R.Fragment, null,
        !tooltipOnly && (options.toolDetails && turn.toolCalls.length ? h(k0, {
          trigger: h('span', { className: 'text-sm text-muted-foreground', 'data-tooltip-id': tooltipId }, `${options.language==='en'?'Worked for':'用时'} ${duration(turn.durationMs)}`),
          defaultExpanded: false, dataTestId: 'agy-completion-tools-toggle'
        }, h(ToolDetails, { turn })) : h('span', { className: 'inline-flex items-center gap-1 text-sm text-muted-foreground tabular-nums px-2 py-1', tabIndex: 0, 'data-tooltip-id': tooltipId, 'data-testid': 'agy-completion-time' }, `${options.language==='en'?'Worked for':'用时'} ${duration(turn.durationMs)}`)),
        h(Sy, { id: tooltipId, place: 'right' }, completed(turn.completedAtIso)));
    }

    function ResponseActions({ turn, conversationId }) {
      return h(HC, { placement: 'top-end' },
        h(IC, { asChild: true }, h(Uy, { variant: 'ghost', size: 'icon', 'aria-label': t('回答操作'), 'data-testid': 'agy-response-actions' }, h(dq, { name: 'more_horiz', size: 16 }))),
        h(JC, { className: '!w-52', arrowNavigable: true },
          h(KC, { asChild: true }, h(GC, { icon: h(dq, { name: 'fork_left', size: 16 }), 'data-testid': 'agy-fork-response', onClick: () => { void branchAndNavigate(conversationId, turn.stepIndexEnd); } }, t('分支到新聊天')))));
    }

    function MessageEdit({ user }) {
      const message = adapter.userMessage(user);
      R.useEffect(() => () => { if (adapter.pendingEdit?.element === user) adapter.cancelEdit?.({ restoreDraft: false }); }, [user]);
      if (!message) return null;
      const viewOnly = adapter.providers(user).find(p => p.value?.stepHandler)?.value?.stepHandler?.isViewOnlyMode?.();
      if (viewOnly || message.status === I.CortexStepStatus.CLEARED) return null;
      return h(Uy, {
        variant: 'ghost', size: 'icon',
        tooltip: t('编辑消息'),
        'aria-label': t('编辑消息'),
        'data-testid': 'agy-edit-message',
        onClick: async event => {
          event.stopPropagation();
          try {
            await adapter.beginEdit(user, {
              label: options.language === 'en' ? 'Editing message (sending will regenerate from this turn)' : '正在编辑此条消息（发送后将从此处重新生成）',
              cancelLabel: t('取消')
            });
          } catch (failure) { notify?.({ title: t('消息发送失败'), message: failure.message, tag: 'agy-edit-error' }); }
        }
      }, h(dq, { name: 'edit', size: 16 }));
    }

    function renderRoot(key, parent, before, source, element, kind) {
      let entry = roots.get(key);
      if (!entry || !entry.mount.isConnected) {
        if (entry) { entry.root.unmount(); entry.mount.remove(); }
        const mount = document.createElement('span');
        mount.dataset.agyPowertoolsRoot = kind;
        mount.className = kind === 'outline' ? 'contents' : kind === 'completion' ? 'block' : ['management','progress'].includes(kind) ? 'block w-full' : 'inline-flex items-center shrink-0';
        parent.insertBefore(mount, before || null);
        entry = { root: ReactDOM.createRoot(mount), mount, source, kind };
        roots.set(key, entry);
      }
      const tree=adapter.wrap(element, source);
      entry.root.render(Boundary?h(Boundary,null,tree):tree);
    }

    function turnFor(response) {
      for (let f = adapter.fiber(response); f; f = f.return) {
        const steps = f.memoizedProps?.container?.steps;
        if (Array.isArray(steps)) {
          const input = steps.find(s => s.step?.case === 'userInput');
          if (input) return state?.turns.find(t => t.stepIndexStart === HU(input.metadata));
          const index = HU(steps.at(-1)?.metadata);
          const turn = state?.turns.find(t => t.stepIndexStart <= index && t.stepIndexEnd >= index);
          if (turn) return turn;
        }
      }
      return null;
    }

    function mount() {
      if (disposed) return;
      if(adapter.pendingEdit?.element&&adapter.pendingEdit.element.isConnected===false)adapter.cancelEdit?.({restoreDraft:true});
      if(mountedConversationId!==currentId()){if(adapter.pendingEdit&&adapter.pendingEdit.cascadeId!==currentId())adapter.cancelEdit?.({restoreDraft:false});mountedConversationId=currentId();emit();}
      document.documentElement.toggleAttribute('data-agy-compact', options.enabled&&options.compact);
      document.documentElement.toggleAttribute('data-agy-keep-outline', options.enabled&&options.keepTurnOutline);
      followOverview();
      localizer?.apply(options.enabled?options.language:'en',options.enabled);
      for (const [key, entry] of roots) if (!entry.mount.isConnected || !entry.source.isConnected || (entry.kind === 'completion' && !options.timing) || (entry.kind === 'response-actions' && !options.responseBranch) || (entry.kind === 'message-edit' && !options.messageEdit) || (entry.kind === 'progress' && !options.progress) || (entry.kind === 'outline' && !options.keepTurnOutline)) {
        entry.root.unmount(); entry.mount.remove(); roots.delete(key);
      }
      if (!options.timing) restoreLabels();
      if(!options.enabled){
        restoreLabels();
        for(const [key,entry]of roots)if(entry.kind!=='management'){entry.root.unmount();entry.mount.remove();roots.delete(key);}
      }
      const customizations = document.querySelector('a[href="/customizations"]');
      if (!pageInstalled && panels) pageInstalled = adapter.installPage(Boundary?()=>h(Boundary,{page:true},h(panels.Page)):panels.Page);
      if (customizations && panels) renderRoot(customizations, customizations.parentElement, customizations.nextSibling, customizations, h(panels.Sidebar), 'management');
      if(!options.enabled)return;
      const data = state?.conversationId === currentId() ? state : null;
      for (const model of document.querySelectorAll('[data-testid="model-selector-trigger"]')) {
        if (!model.closest('.surface-composer-card')) continue;
        let anchor = model;
        while (anchor.parentElement && getComputedStyle(anchor.parentElement).display !== 'flex') anchor = anchor.parentElement;
        renderRoot(model, anchor.parentElement, anchor.nextSibling, model, h(NativeEntry, { data, placement: 'composer' }), 'ring');
      }
      if (!data) return;
      const overview = document.querySelector('[data-testid="overview-panel"]');
      if (overview && panels && options.progress) renderRoot(overview,overview,null,overview,h(panels.Progress),'progress');
      const view = document.querySelector('[data-testid="conversation-view"]');
      const nativeOutline=view?.querySelector('[data-testid="conversation-navigator"]');
      if (overview && view && panels && options.keepTurnOutline && !nativeOutline && data.turns.length>1) renderRoot(view,view,null,view,h(panels.Outline),'outline');
      else if(view){const entry=roots.get(view);if(entry?.kind==='outline'){entry.root.unmount();entry.mount.remove();roots.delete(view);}}
      if (options.messageEdit) for (const user of document.querySelectorAll('[data-testid="user-input-step"]')) {
        const actions = user.querySelector('[data-testid="user-message-actions"]');
        if (actions) renderRoot(actions, actions, null, user, h(MessageEdit, { user }), 'message-edit');
      }
      for (const response of document.querySelectorAll('[data-testid="agent-response"]')) {
        const turn = turnFor(response);
        if (!turn) continue;
        if (options.responseBranch && turn.status !== 'running') {
          let scope = response.closest('[data-turn-content]');
          if (!scope) {
            for (let parent = response.parentElement; parent && parent.querySelectorAll('[data-testid="agent-response"]').length === 1; parent = parent.parentElement) {
              if ([...parent.querySelectorAll('button[aria-label="Copy"]')].some(button => !button.closest('[data-testid="user-input-step"]'))) { scope = parent; break; }
            }
          }
          const feedback = scope?.querySelector('[aria-label="Bad response"]') || scope?.querySelector('[aria-label="Good response"]') || [...(scope?.querySelectorAll('button[aria-label="Copy"]') || [])].find(button => !button.closest('[data-testid="user-input-step"]'));
          const actionRow = feedback?.parentElement;
          if (actionRow) renderRoot(actionRow, actionRow, null, response, h(ResponseActions, { turn, conversationId: data.conversationId }), 'response-actions');
        }
        if (!options.timing || !turn.completedAtIso || turn.durationMs == null || turn.status === 'running') continue;
        const tooltipId = `agy-completed-${data.conversationId}-${turn.turnNumber}`;
        const nativeWorked = response.querySelector('[data-testid="worked-for-collapsible"]');
        if (nativeWorked) {
          const label = [...nativeWorked.querySelectorAll('span')].find(el => /^Worked for|^用时 /.test(el.textContent));
          if (label) {
            if (!changedLabels.has(label)) changedLabels.set(label, { text: label.textContent, target: nativeWorked, tooltip: nativeWorked.getAttribute('data-tooltip-id') });
            const text = `${options.language==='en'?'Worked for':'用时'} ${duration(turn.durationMs)}`;
            if (label.textContent !== text) label.textContent = text;
            nativeWorked.setAttribute('data-tooltip-id', tooltipId);
            renderRoot(response, response, response.firstChild, response, h(Completion, { turn, tooltipOnly: true, tooltipId }), 'completion');
          }
        } else renderRoot(response, response, response.querySelector('[data-testid="planner-response-text"]')?.closest('[data-quotable]') === response ? response.children[1] : response.firstChild, response, h(Completion, { turn, tooltipId }), 'completion');
      }
    }

    function restoreLabels() {
      for (const [label, original] of changedLabels) {
        if (label.isConnected) label.textContent = original.text;
        if (original.target.isConnected) original.tooltip == null ? original.target.removeAttribute('data-tooltip-id') : original.target.setAttribute('data-tooltip-id', original.tooltip);
      }
      changedLabels.clear();
    }

    let activeForkDialogCleanup = null;
    function confirmPreSubagentFork(plan) {
      activeForkDialogCleanup?.();
      return new Promise(resolve => {
        const host = document.createElement('div');
        host.dataset.agyPowertoolsRoot = 'fork-dialog';
        document.body.append(host);
        const root = ReactDOM.createRoot(host);
        let settled = false;
        const finish = accepted => {
          if (settled) return;
          settled = true;
          window.removeEventListener('keydown', onKey, true);
          activeForkDialogCleanup = null;
          root.unmount();
          host.remove();
          resolve(accepted);
        };
        const onKey = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
        };
        window.addEventListener('keydown', onKey, true);
        activeForkDialogCleanup = () => finish(false);
        const en = options.language === 'en';
        const title = en ? 'Branch before subagent invocation?' : '从子智能体调用前创建分支？';
        const body = en
          ? `This conversation invoked a subagent in Turn ${plan.subagentTurnNumber}, and Antigravity does not yet support branching turns that include subagents. Would you like to branch from the end of Turn ${plan.turnNumber} instead?`
          : `当前会话在第 ${plan.subagentTurnNumber} 轮调用了子智能体，官方底层暂不支持包含子智能体的轮次直接分支。是否从子智能体之前的第 ${plan.turnNumber} 轮对话结束处创建分支？`;
        const previewLabel = plan.promptPreview
          ? (en ? `Up to Turn ${plan.turnNumber}: "${plan.promptPreview}"` : `截至第 ${plan.turnNumber} 轮提问：「${plan.promptPreview}」`)
          : '';
        const cancelText = en ? 'Cancel' : '取消';
        const confirmText = en ? `Branch from Turn ${plan.turnNumber}` : `从第 ${plan.turnNumber} 轮创建分支`;
        const dialogBody = h('div', { 'data-testid': 'agy-subagent-fork-dialog', className: 'flex flex-col gap-3' },
          h('p', { className: 'text-foreground opacity-80 leading-relaxed m-0' }, body),
          previewLabel && h('div', {
            className: 'rounded-lg border border-border bg-secondary px-3 py-2 text-compact text-secondary-foreground truncate',
            title: previewLabel
          }, previewLabel),
          h('div', { className: 'flex justify-end gap-3 pt-1' },
            h(Uy, { size: 'md', variant: 'secondary', type: 'button', 'data-testid': 'agy-subagent-fork-cancel', onClick: () => finish(false) }, cancelText),
            h(Uy, { size: 'md', variant: 'primary', type: 'button', 'data-autofocus': 'true', autoFocus: true, 'data-testid': 'agy-subagent-fork-confirm', onClick: () => finish(true) }, confirmText)));
        const modal = typeof Wz === 'function'
          ? h(Wz, {
              isOpen: true,
              positioning: 'fixed',
              onClose: () => finish(false),
              onSubmit: () => finish(true),
              title,
              className: 'max-w-md rounded-xl bg-background',
              innerContentClassName: 'px-1 -mx-1',
              scrollToBottomOnOpen: false
            }, dialogBody)
          : h('div', {
              style: { position: 'fixed', inset: 0, zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', padding: 16 },
              onMouseDown: event => { if (event.target === event.currentTarget) finish(false); }
            },
              h('div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: { width: '100%', maxWidth: 420, padding: 20, borderRadius: 12 }, className: 'border border-border bg-background text-foreground shadow-lg flex flex-col gap-3' },
                h('div', { className: 'font-medium text-lg text-foreground' }, title),
                dialogBody));
        const sourceEl = document.querySelector('[data-testid="conversation-view"],a[href="/customizations"]') || document.body.firstElementChild;
        const tree = sourceEl ? adapter.wrap(modal, sourceEl) : modal;
        root.render(Boundary ? h(Boundary, null, tree) : tree);
      });
    }

    async function executeResolvedFork(id, forkAtStepIndex) {
      let newId;
      if (nativeRunFork) {
        newId = await nativeRunFork(id, forkAtStepIndex, 1);
      } else {
        const result = await adapter.fork(id, forkAtStepIndex, { exact: true, autoRename: false });
        newId = result.conversationId;
        location.assign(`/c/${encodeURIComponent(newId)}`);
      }
      if (newId) void adapter.renameForkedConversation?.(id, newId, state?.conversationId === id ? state?.turns?.[0]?.promptTitle : '');
      return newId;
    }

    async function branchAndNavigate(id, stepIndex = -1) {
      try {
        if (!adapter.resolveForkPlan) {
          if (nativeRunFork) return await nativeRunFork(id, await adapter.forkPoint(id, stepIndex), 1);
          const result = await adapter.fork(id, stepIndex); location.assign(`/c/${encodeURIComponent(result.conversationId)}`); return result.conversationId;
        }
        const plan = await adapter.resolveForkPlan(id, stepIndex);
        if (plan.mode === 'direct') return await executeResolvedFork(id, plan.forkAtStepIndex);
        if (plan.mode === 'blocked-first-turn') {
          notify?.({
            title: options.language === 'en' ? 'Unable to branch conversation' : '无法创建会话分支',
            message: options.language === 'en'
              ? 'This conversation invoked a subagent in its first turn, so there is no earlier turn to branch from.'
              : '该会话在第 1 轮即调用了子智能体，之前没有可分支的历史对话轮次。',
            tag: 'agy-branch-error'
          });
          return null;
        }
        if (await confirmPreSubagentFork(plan)) {
          return await executeResolvedFork(id, plan.forkAtStepIndex);
        }
        return null;
      }
      catch (error) { notify?.({ title: options.language === 'en' ? 'Unable to branch conversation' : '无法创建会话分支', message: error.message, tag: 'agy-branch-error' }); }
    }
    const menuName=globalThis.__agyNativeBindings?.names.menu||'lHc';
    const originalMenu = globalThis[menuName];
    const extendedMenu = function (id, menuOptions) {
      const items = originalMenu(id, menuOptions);
      if (!options.enabled || !options.responseBranch || !id || menuOptions.isArchived || items.some(item => item.id === 'agy-native-fork')) return items;
      const entry = { id: 'agy-native-fork', label: t('分支会话'), icon: h(dq, { name: 'fork_left', size: 16, className: 'shrink-0 text-secondary-foreground' }), testId: 'agy-fork-session-menu-item', onClick: () => { void branchAndNavigate(id); } };
      const index = items.findIndex(item => item.id === 'split');
      return [...items.slice(0, index < 0 ? 3 : index), entry, ...items.slice(index < 0 ? 3 : index)];
    };
    if (typeof originalMenu === 'function') globalThis[menuName] = extendedMenu;
    document.addEventListener('contextmenu', event => {
      if(!options.enabled)return;
      const row = event.target.closest?.('.agy-sidebar-row');
      const link = row?.querySelector('a[href^="/c/"]');
      const button = row?.querySelector('button[aria-label="More options"]');
      if (link && button) {
        event.preventDefault(); event.stopPropagation();
        if (button.getAttribute('aria-expanded') !== 'true') button.click();
      }
    }, { capture: true, signal: signalController.signal });

    async function refresh() {
      if (busy || disposed) return;
      busy = true;
      const id = currentId();
      try {
        if (!settingsLoaded) { options = {...defaults,...await request('settings.get')}; settingsLoaded = true; applyOptions(); mount(); emit(); }
        if(!options.enabled)return;
        if (id !== lastId) { state = null; lastId = id; mount(); }
        if (Date.now() - lastAccountAt > 60000) void refreshAccount().catch(()=>{});
        if (!id) return;
        const reply = await request('state', { conversationId: id, execution: adapter.executionState?.(id) });
        if (id === currentId()) { state = reply; lastConversation=reply; if (reply.settings) options = {...defaults,...reply.settings}; mount(); emit(); }
      } catch { /* Keep the last confirmed data during a transient host reconnect. */ }
      finally { busy = false; }
    }
    let mountTimer;
    const observer = new MutationObserver(records => {
      if (records.every(record => record.target.closest?.('[data-agy-powertools-root],[data-agy-editor-slot],[data-testid="agy-edit-banner"],[data-testid="agy-context-popup"],.react-tooltip'))) return;
      clearTimeout(mountTimer); mountTimer = setTimeout(mount, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setInterval(refresh, 2000);
    globalThis.__agyPowertools = {
      version,
      get status() {
        const ringExpected=options.enabled&&options.contextRing&&state?.conversationId===currentId()&&document.querySelector('[data-testid="model-selector-trigger"]')?.closest('.surface-composer-card');
        const managementExpected=document.querySelector('a[href="/customizations"]');
        const healthy=!disposed&&!renderError&&(!ringExpected||document.querySelectorAll('[data-testid="agy-context-ring-trigger"]').length===1)&&(!managementExpected||!!document.querySelector('[data-testid="agy-management-trigger"]'));
        return {conversationId:state?.conversationId||'',mounted:[...roots.values()].filter(r=>r.kind==='ring'&&r.mount.isConnected).length,healthy,nativeComponents:true,error:renderError||undefined};
      },
      fork: adapter.fork,
      get settings() { return { ...options }; },
      get account() {return account;},
      get dashboard(){return dashboard;},
      dispose() {
        disposed = true; activeForkDialogCleanup?.(); signalController.abort(); stopOverviewNavigation?.(); observer.disconnect(); clearInterval(timer); clearTimeout(mountTimer);
        if (globalThis[menuName] === extendedMenu) globalThis[menuName] = originalMenu;
        for (const entry of roots.values()) { entry.root.unmount(); entry.mount.remove(); } roots.clear();
        restoreLabels(); localizer?.dispose(); panels?.dispose(); adapter.dispose?.(); densityStyle.remove(); document.documentElement.removeAttribute('data-agy-compact'); document.documentElement.removeAttribute('data-agy-keep-outline'); listeners.clear();
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('已断开')); } pending.clear();
        delete globalThis.__agyPowertools; delete globalThis.__agyPowertoolsReceive;
      }
    };
    mount(); void refresh();
  }
})();
