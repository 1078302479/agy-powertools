(() => {
  const version='2.12.1';
  const hookNames=globalThis.__agyNativeBindings?.names||{resolve:'sjc',segment:'Yyc',menu:'lHc'};
  if(globalThis.__agyNativeAdapter?.version===version&&globalThis.__agyNativeAdapter.active)return;
  globalThis.__agyNativeAdapter?.dispose?.();
  let disposed=false;
  const fiber = element => element?.[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
  function providers(element) {
    const result = [];
    for (let node = fiber(element); node; node = node.return) {
      if (node.tag === 10 && node.memoizedProps?.value !== undefined) result.push({ type: node.type, value: node.memoizedProps.value });
    }
    return result;
  }
  function service() {
    const entry = providers(pageSource()).find(p => typeof p.value?.forkConversation === 'function');
    if (!entry) throw new Error('Antigravity conversation service is unavailable');
    return entry.value;
  }
  function wrap(child, element) {
    return providers(element).reduce((tree, p) => B.createElement(p.type, { value: p.value }, tree), child);
  }
  const pageSource = () => document.querySelector('[aria-label="Message input"],[data-agy-original-aria-label="Message input"]') || document.querySelector('a[href="/customizations"]') || document.querySelector('#root')?.firstElementChild || document.body?.firstElementChild;
  const store = () => providers(pageSource()).map(p=>p.value?.store).find(s=>s?.getState&&s?.dispatch);
  const router = () => providers(pageSource()).map(p=>p.value).find(v=>typeof v?.navigate==='function'&&typeof v?.buildRouteTree==='function');
  const overview = () => providers(pageSource()).map(p=>p.value).find(v=>v?.cascadeId&&typeof v.togglePanel==='function'&&typeof v.setOverlayOpen==='function');
  function capabilities() {
    const p=providers(pageSource()),s=store()?.getState(),context=p.find(p=>p.value?.cascadeContext)?.value;
    const model=context?.cascadeContext?.state?.selectedModel;
    return {subscription:globalThis.__agyDashboard?.subscriptionIdentity(s?.userStatus?.userTier),plan:s?.userStatus?.userTier?.name||'',planId:s?.userStatus?.userTier?.id||'',models:s?.userStatus?.cascadeModelConfigData?.clientModelConfigs?.map(m=>({label:m.label,modelId:m.modelId}))||[],model:model?.label||'',contextOptions:model?.contextWindowOptions||[],
      contextSelectionEnabled:!!p.find(p=>p.value?.getCache&&p.value?.featureNames)?.value.get('contextWindowSelector')?.enabled};
  }
  function executionState(conversationId) {
    const context=providers(pageSource()).find(p=>p.value?.cascadeContext)?.value;
    const state=context?.cascadeContext?.state?.agentStateProvider?.getState?.();
    const turnStartStepIndex=state?.turns?.at(-1)?.startStepIndex;
    if(!conversationId||state?.conversationId!==conversationId||!Number.isInteger(turnStartStepIndex))return null;
    return {conversationId,status:state.status,turnStartStepIndex,terminationReason:state.executorMetadata?.terminationReason};
  }
  let originalSend,sendService,originalResolve,originalSegmentRender,stageSegmentRender;
  let contextLimit=256000,stageUpdatesEnabled=false,efficientIOEnabled=false,runtimeEnabled=true;
  const stageUpdateRule='During this task, communicate brief visible progress updates in the user-facing response alongside tool calls. Before the first substantial tool action, write one concise sentence explaining the immediate next action and its purpose. After a meaningful finding, change of direction, or a few execution steps, write one or two concise sentences stating the result and next action. These are intermediate updates, not final answers: continue executing the task after each update. Do not narrate every command. Do not put updates only in private thinking, tool summaries, task artifacts, or notify_user. Use the user language. Never invent progress or expose private reasoning.';
  const efficientIORule='Reduce unnecessary model round trips while respecting the task and platform permissions. Locate relevant files and symbols with available purpose-built search tools first; otherwise prefer rg when available, respect ignore rules, and use commands appropriate to the operating system. Batch already-known, independent searches and file reads in the same tool round when supported. Keep dependent operations sequential and honor any user-requested sequence. Read sufficient surrounding code once; read small relevant files whole and bounded regions of large files. Reuse unchanged information. Prefer focused edits that preserve unrelated work. Run the checks appropriate to the change and avoid redundant checks after they pass. Report meaningful milestones rather than narrating every command. Lead the final response with the result; keep detail proportional to the task and honor explicit requests for detailed explanations. Do not assume any fixed command allowlist or promised performance gain.';
  function configureRequest(base) {
    const config=tc(I.CascadeConfigSchema,base);
    if(contextLimit!==256000)config.checkpointConfig=Wb(I.CheckpointConfigSchema,{...config.checkpointConfig,maxTokenLimit:contextLimit,tokenThreshold:contextLimit});
    if(stageUpdatesEnabled){
      config.plannerConfig ||= Wb(I.CascadePlannerConfigSchema,{});
      config.plannerConfig.noToolExplanation=false;
      config.plannerConfig.noToolSummary=false;
    }
    if(stageUpdatesEnabled||efficientIOEnabled){
      config.plannerConfig ||= Wb(I.CascadePlannerConfigSchema,{});
      const prompts=config.plannerConfig.promptSectionCustomizationConfig||Wb(I.PromptSectionCustomizationConfigSchema,{});
      const names=['powertools_stage_updates','powertools_efficient_io'];
      prompts.appendPromptSections=[...(prompts.appendPromptSections||[]).filter(p=>!names.includes(p.title)),
        ...(stageUpdatesEnabled?[Wb(I.PromptSectionSchema,{title:names[0],content:stageUpdateRule})]:[]),
        ...(efficientIOEnabled?[Wb(I.PromptSectionSchema,{title:names[1],content:efficientIORule})]:[])];
      config.plannerConfig.promptSectionCustomizationConfig=prompts;
    }
    return config;
  }
  function installRequestOverrides(){
    if (!sendService) { sendService=service(); originalSend=sendService.sendUserCascadeMessage; }
    const enabled=runtimeEnabled&&(contextLimit!==256000||stageUpdatesEnabled||efficientIOEnabled);
    if(typeof globalThis[hookNames.resolve]==='function'){
      originalResolve ||= globalThis[hookNames.resolve];
      globalThis[hookNames.resolve]=enabled?function(...args){return configureRequest(originalResolve(...args));}:originalResolve;
    }
    if(originalSend)sendService.sendUserCascadeMessage=enabled?function(payload,...args){
      return originalSend.call(this,{...payload,cascadeConfig:configureRequest(Wb(I.CascadeConfigSchema,payload.cascadeConfig||{}))},...args);
    }:originalSend;
  }
  function setContextLimit(limit) {
    if (![256000,500000,1000000].includes(limit)) throw new Error('不支持的上下文上限');
    contextLimit=limit;installRequestOverrides();
  }
  function setEfficientIO(enabled){efficientIOEnabled=enabled===true;installRequestOverrides();}
  function setEnabled(enabled){runtimeEnabled=enabled!==false;setStageUpdates(stageUpdatesEnabled);}
  function setStageUpdates(enabled){
    stageUpdatesEnabled=enabled===true;installRequestOverrides();
    if(typeof globalThis[hookNames.segment]==='function'){
      originalSegmentRender ||= globalThis[hookNames.segment];
      stageSegmentRender ||= function(...args){
        const result=originalSegmentRender(...args);
        if(!runtimeEnabled||!stageUpdatesEnabled||result?.body?.type!=='collapsible')return result;
        const groups=result.body.content?.groups||[];
        const isUpdate=g=>g.type==='step'&&g.step?.step?.case==='plannerResponse'&&g.step.step.value?.response?.trim();
        const leading=result.leadingSteps||[],updates=leading.filter(isUpdate);
        if(!updates.length&&!groups.some(isUpdate))return result;
        // While running, retain native text/tool order without the outer fold.
        // On completion, move the leading updates into that fold as well.
        // The native tail contains the final answer and stays outside it.
        const active=result.body.isActive||args[0]?.isRunning&&args[0]?.isLastTurn&&args[0]?.segment?.isLatest;
        if(active)return{...result,body:{type:'inline',content:result.body.content}};
        return{...result,leadingSteps:leading.filter(g=>!isUpdate(g)),body:{...result.body,
          defaultExpanded:false,isActive:false,triggerVisible:true,
          content:{...result.body.content,groups:[...updates,...groups]}}};
      };
      globalThis[hookNames.segment]=runtimeEnabled&&stageUpdatesEnabled?stageSegmentRender:originalSegmentRender;
    }
  }
  function installPage(component) {
    const r=router(); if (!r || typeof VD!=='function') return false;
    const existing=r.routesById?.['/manager-layout/manager-landing-layout/powertools'];
    if (existing) {
      existing.update({component});
      if(location.pathname==='/powertools')void r.navigate({to:'/customizations',replace:true}).then(()=>r.navigate({to:'/powertools',replace:true}));
      return true;
    }
    const parent=r.routesById?.['/manager-layout/manager-landing-layout'];
    if (!parent) return false;
    const pending=parent.children.find(route=>route.options.path==='/powertools');
    if(pending)pending.update({component});else parent.addChildren([...parent.children,VD({getParentRoute:()=>parent,path:'/powertools',component})]);
    r.routeTree = null;
    r.update({routeTree:r.options.routeTree});
    if(location.pathname==='/powertools')void r.load();
    return true;
  }
  function userMessage(element) {
    for (let node = fiber(element); node; node = node.return) {
      const props = node.memoizedProps;
      if (props?.step?.items && props.metadata && props.cascadeId) return props;
    }
    return null;
  }
  function navigateTurn(turn) {
    const source=document.querySelector('[data-testid="user-input-step"],[data-testid="agent-response"]');
    const nav=providers(source).find(p=>typeof p.value?.jumpTo==='function'&&Array.isArray(p.value.turns))?.value;
    const index=nav?.turns.findIndex(item=>item.startStepIndex===turn.stepIndexStart)??-1;
    if(index>=0){nav.jumpTo(index);return true;}
    for(const element of document.querySelectorAll('[data-testid="user-input-step"]')){
      const message=userMessage(element);
      if(message&&HU(message.metadata)===turn.stepIndexStart){element.scrollIntoView({behavior:'smooth',block:'start'});return true;}
    }
    return false;
  }
  function replaceText(items, text) {
    let inserted = false;
    const result = items.flatMap(item => {
      if (item.chunk?.case !== 'text') return [item];
      if (inserted) return [];
      inserted = true;
      return [{ ...item, chunk: { case: 'text', value: text } }];
    });
    if (!inserted) result.unshift({ chunk: { case: 'text', value: text } });
    return result;
  }
  async function editAndResend(element, text) {
    if (!text.trim()) throw new Error('请输入消息');
    const message = userMessage(element);
    const context = providers(element).find(p => typeof p.value?.sendMessage === 'function' && p.value?.stepHandler)?.value;
    if (!message || !context?.stepHandler?.revertToIndex) throw new Error('当前消息不支持编辑');
    const stepIndex = HU(message.metadata);
    const items = replaceText(message.step.items, text);
    let reverted = false;
    try {
      // This option explicitly preserves workspace files.
      await context.stepHandler.revertToIndex(message.cascadeId, stepIndex - 1, { conversationOnly: true });
      reverted = true;
      await context.sendMessage({ type: 1, cascadeId: message.cascadeId, items, media: message.step.media || [], resend: 'edit',
        commentOverrides: { artifactComments: message.step.artifactComments || [], fileDiffComments: message.step.fileDiffComments || [], fileComments: message.step.fileComments || [] } });
      return { conversationId: message.cascadeId, replacedStepIndex: stepIndex };
    } catch (error) {
      if (reverted) {
        const box = context.inputBoxRef?.current;
        const editor = box?.lexicalRef?.current;
        if (editor && typeof IJ === 'function' && typeof LN === 'function') {
          editor.setEditorState(IJ(editor, LN(items)));
          box.setMediaAttachments?.(message.step.media || []);
        }
      }
      throw error;
    }
  }
  async function forkPoint(conversationId, stepIndex) {
    if (stepIndex === -1) return -1;
    const data = await service().getCascadeTrajectory({ cascadeId: conversationId });
    const steps = data.trajectory.steps;
    const next = steps.find(step => HU(step.metadata) > stepIndex && step.step?.case === 'userInput');
    return next ? HU(next.metadata) - 1 : -1;
  }
  async function fork(conversationId, stepIndex = -1) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(conversationId || '') || !Number.isInteger(stepIndex) || stepIndex < -1) throw new Error('Invalid fork point');
    stepIndex = await forkPoint(conversationId, stepIndex);
    const response = await service().forkConversation({ sourceCascadeId: conversationId, forkAtStepIndex: stepIndex, targetForkWorkspace: 1 });
    if (!response?.newCascadeId) throw new Error('Antigravity returned no forked conversation');
    return { conversationId: response.newCascadeId, projectId: response.newProjectId || '', forkedAtStepIndex: response.forkedAtStepIndex, warnings: response.warnings || [] };
  }
  globalThis.__agyNativeAdapter = { version,get active(){return !disposed;},get stageUpdates(){return runtimeEnabled&&stageUpdatesEnabled;},fiber, providers, service, wrap, store, router, overview, capabilities, executionState, setEnabled, setContextLimit, setStageUpdates, setEfficientIO, installPage, fork, forkPoint, userMessage, navigateTurn, replaceText, editAndResend,
    dispose(){disposed=true;if(sendService&&originalSend)sendService.sendUserCascadeMessage=originalSend;if(originalResolve)globalThis[hookNames.resolve]=originalResolve;if(originalSegmentRender&&globalThis[hookNames.segment]===stageSegmentRender)globalThis[hookNames.segment]=originalSegmentRender;} };
})();
