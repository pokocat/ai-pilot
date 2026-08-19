const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo } = require('../../services/nav');
const { baseData, backendEnvironmentData, syncTabBar, syncViewport } = require('../../services/page');
// 开发版环境角标：mock 时同时充当数据档案开关。
const mockProfile = require('../../services/mockProfile');
const { SUPPORTED_DOCUMENT_EXT, validateDocumentUpload } = require('../../utils/document-upload');

const PROCESS_STEPS = ['识别资料来源和文件类型', '去重并标记敏感信息', '按案卷目标生成分类结构', '输出待确认资料和问题清单'];
const CATEGORY_LABELS = { founder:'老板档案', company:'企业档案', finance:'财务经营', content:'内容IP', growth:'增长资料', customer:'客户问答', proof:'案例证明', unknown:'待识别' };

function categoryLabel(key) { return CATEGORY_LABELS[key] || key || '待识别'; }
function safeList(value) { return Array.isArray(value) ? value : []; }
function mb(bytes) { return Math.floor(Math.max(0, Number(bytes)||0) / 1024 / 1024); }
function fileStatus(status) {
  if (status === 'failed') return { statusLabel:'读不出', statusClass:'fs-bad' };
  if (status === 'parsing' || status === 'embedding') return { statusLabel:'在读', statusClass:'fs-run' };
  if (status === 'pending') return { statusLabel:'排队', statusClass:'fs-wait' };
  return { statusLabel:'已备好', statusClass:'fs-ok' };
}
function sourceState(label) {
  if (/已绑定|已接入/.test(label)) return 'ds-ok';
  if (/待上传/.test(label)) return 'ds-miss';
  return 'ds-warn';
}
function money(fen) { return `¥${(Number(fen || 0) / 100).toFixed(Number(fen || 0) % 100 ? 2 : 0)}`; }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
const HTML_LIKE = /<(?:!doctype|html|head|body|title|meta|style|script)\b/i;

function decodeEntity(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function cleanHtml(value) {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value);
  const title = titleMatch ? decodeEntity(titleMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(value);
  const body = bodyMatch ? bodyMatch[1] : value;
  const content = decodeEntity(body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|svg)>/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|main|h[1-6]|li|tr|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim());
  if (!title || !content || content.startsWith(title)) return content || title;
  return `${title}\n\n${content}`;
}

function cleanMarkdown(value) {
  return value
    .replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm, '')
    .replace(/^\s*(```|~~~)[^\n]*$/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .trim();
}

function previewText(value, fileType) {
  const source = String(value || '').trim();
  if (!source) return '';
  const clean = fileType === 'html' || HTML_LIKE.test(source) ? cleanHtml(source) : fileType === 'md' ? cleanMarkdown(source) : source;
  return clean.slice(0, 1200).trim();
}

function previewHeight(text) {
  const lines = String(text || '').split(/\r?\n/).reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 22)), 0);
  return Math.min(220, Math.max(96, lines * 24 + 24));
}

Page({
  data: baseData({
    segment: 0,
    segments: ['家底','数据源'],
    stage: 'staging',
    stageTabs: [{key:'staging',label:'待整理',count:0},{key:'optimized',label:'已优化',count:0},{key:'confirmed',label:'知识库',count:0}],
    processSteps: PROCESS_STEPS,
    showLogin: false, loginReason: 'save', authed: false, loading: false, loadFailed: false, uploading: false, organizing: false, confirming: false, purchasing: '', refreshingForces: false,
    uploadText: '', uploadError: false, counts: { staging:0,optimized:0,confirmed:0 }, quotaText:'200/200MB', quotaDocs:'0 / 30',
    batches:[], optimizedItems:[], folders:[], sources:[], sourceStats:{bound:0,needed:0,total:0},
    confirmButton:'确认 0 份并写入知识库'
  }),
  onResize(event) { syncViewport(this, event && event.size); },
  onShow() {
    const state=store.snapshot();
    this.setData(Object.assign({themeClass:state.themeClass,colorKey:state.colorKey,isMock:state.mock,mockProfileLabel:state.mock?mockProfile.label():'',authed:state.authed,segment:state.authed?this.data.segment:0},backendEnvironmentData()));
    syncTabBar(this,3);
    this.load();
  },
  /** MOCK 角标即档案开关：切「经营中 / 空态」后重取本页数据。 */
  switchMockProfile(){if(!this.data.isMock)return;mockProfile.switchProfile(()=>{this.setData({mockProfileLabel:mockProfile.label()});this.load();});},
  requireLogin(reason) { if(store.isAuthed()) return true; this.setData({showLogin:true,loginReason:reason||'upload'}); return false; },
  closeLogin(){this.setData({showLogin:false});}, loggedIn(){this.setData({showLogin:false,authed:true});this.load();},
  switchSegment(event){this.setData({segment:Number(event.currentTarget.dataset.index)});},
  // 能力中心与方案存档已迁出本页（能力开通发生在军师推荐现场，方案归锦囊作品页）。
  // openSkuPurchase / waitSkuApplied / money 留下——深度整理的 SKU_REQUIRED 分支仍依赖。
  setStage(event){if(!this.data.confirming)this.setData({stage:event.currentTarget.dataset.stage});},
  togglePreview(event){
    const index=Number(event.currentTarget.dataset.index);
    const items=this.data.optimizedItems.slice();
    const item=items[index];
    if(!item||!item.previewText)return;
    items[index]=Object.assign({},item,{previewOpen:!item.previewOpen});
    this.setData({optimizedItems:items});
  },
  retry(){this.setData({loadFailed:false});this.load();},
  askLogin(){this.requireLogin('history');},
  async load(){
    if(!store.isAuthed())return;
    this.setData({loading:true});
    const [p,d,s]=await Promise.allSettled([api.knowledgePipeline(),api.dataSources(),api.skus()]);
    // 管道或数据源**任一**没回来就提示可重试（原先要求两条都挂）：只挂管道时页面会说
    // 「还没放资料进来」，把读失败说成空态。
    this.setData({loadFailed:p.status!=='fulfilled'||d.status!=='fulfilled'});
    const pipe=p.status==='fulfilled'?(p.value||{}):{};
    const counts=pipe.counts||{staging:0,optimized:0,confirmed:0};
    const quota=pipe.quota||{};
    const totalBytes=Number(quota.freeBytes)||200*1024*1024;
    const usedBytes=Number(quota.usedBytes)||0;
    const batches=safeList(pipe.batches).map((batch)=>{
      const files=safeList(batch.files).map((file)=>Object.assign({},file,fileStatus(file.status),{displayName:file.fileName||file.originalName||'待识别资料',meta:file.fileSize?`${Math.max(1,Math.round(Number(file.fileSize)/1024))}KB`:'等待解析'}));
      return Object.assign({},batch,{files,count:Number(batch.count)||files.length});
    });
    const optimizedItems=safeList(pipe.optimizedItems).map((item)=>{
      const label=categoryLabel(item.category);
      const preview=previewText(item.preview,item.fileType);
      return Object.assign({},item,{char:label.slice(0,1),displayName:item.fileName||item.title||label,nameSourceLabel:item.nameSource==='original'?'源文件名':item.nameSource==='content'?'按正文标题识别 · 原文件名未保留':'原文件名未保留',summaryText:item.isDup?'与同名资料重复，已合并':`${label} · ${item.summary||'已完成归类'}`,categoryLabel:label,previewText:preview,previewHeight:previewHeight(preview),previewOpen:false});
    });
    const folders=safeList(pipe.folders).filter((item)=>!item.stage||item.stage==='confirmed');
    const data=d.status==='fulfilled'?(d.value||{}):{};
    const sources=safeList(data.sources).map((item)=>Object.assign({},item,{statusLabel:item.statusLabel||'去绑定',stateClass:sourceState(item.statusLabel||'')}));
    this._skus=s.status==='fulfilled'?safeList(s.value):[];
    this.setData({
      counts,
      stageTabs:[{key:'staging',label:'待整理',count:counts.staging||0},{key:'optimized',label:'已优化',count:counts.optimized||0},{key:'confirmed',label:'知识库',count:counts.confirmed||0}],
      batches,optimizedItems,folders,
      quotaText:`${mb(totalBytes-usedBytes)}/${mb(totalBytes)}MB`,quotaDocs:`${Number(quota.usedDocs)||0} / ${Number(quota.freeDocs)||30}`,
      sources,sourceStats:{bound:Number(data.bound)||0,needed:Number(data.needed)||0,total:Number(data.total)||sources.length},
      confirmButton:`确认 ${optimizedItems.length} 份并写入知识库`,loading:false
    });
  },
  chooseFiles(){ if(!this.requireLogin('upload')||this.data.uploading||this.data.confirming)return;
    wx.chooseMessageFile({
      count:9,type:'file',extension:SUPPORTED_DOCUMENT_EXT,
      success:(res)=>this.uploadFiles(res.tempFiles||[]),
      fail:(error)=>{if(!/cancel/i.test(String(error&&error.errMsg||'')))wx.showModal({title:'文件选择失败',content:'没能打开微信文件选择器，请稍后重试。',showCancel:false});}
    });
  },
  async uploadFiles(files){ if(!files.length||this.data.confirming)return;
    const accepted=[];const failures=[];
    files.forEach((file)=>{const checked=validateDocumentUpload(file);if(checked.ok)accepted.push(file);else failures.push(`${checked.name}：${checked.message}`);});
    if(!accepted.length){
      const summary=failures.length===1?'上传失败：请按提示处理后重试':`${failures.length} 份资料未能上传`;
      this.setData({uploading:false,uploadError:true,uploadText:summary});
      wx.showModal({title:'资料上传失败',content:failures.slice(0,3).join('\n'),showCancel:false});
      return;
    }
    this.setData({uploading:true,uploadError:false,uploadText:`正在上传 0/${accepted.length}`});
    let done=0;let batchId='';
    for(const file of accepted){
      try{
        const uploaded=await api.uploadKnowledge(file.path,{staged:true,batchId:batchId||undefined,originalName:file.name});
        batchId=uploaded.batchId||batchId;done+=1;
        this.setData({uploadText:`正在上传 ${done}/${accepted.length}`});
      }catch(error){
        failures.push(`${file.name||'这份资料'}：${error.message||'上传失败，请重试'}`);
      }
    }
    const failed=failures.length;
    this.setData({
      uploading:false,
      uploadError:failed>0,
      uploadText:failed?`已送达 ${done} 份，${failed} 份上传失败`:`已送达 ${done} 份，等待整理`
    });
    if(done)await this.load();
    if(failed)wx.showModal({title:done?'部分资料上传失败':'资料上传失败',content:failures.slice(0,3).join('\n'),showCancel:false});
  },
  async organize(event){if(this.data.organizing)return;const batchId=event.currentTarget.dataset.id;if(!batchId)return;this.setData({organizing:true});try{await api.organizeBatch(batchId);await this.load();wx.showToast({title:'资料已整理，等待确认',icon:'none'});}catch(error){store.handleApiError(error,{fallbackTitle:error.message||'整理失败'});}finally{this.setData({organizing:false});}},
  async deepOrganize(event){if(this.data.organizing)return;const batchId=event.currentTarget.dataset.id;if(!batchId)return;this.setData({organizing:true});try{await api.deepOrganize(batchId);await this.load();wx.showToast({title:'深度整理已完成',icon:'none'});}catch(error){const code=error.code||(error.data&&error.data.code);if(code==='SKU_REQUIRED')this.openSkuPurchase('deep-organize','深度资料整理',()=>this.deepOrganize({currentTarget:{dataset:{id:batchId}}}));else store.handleApiError(error,{fallbackTitle:error.message||'深度整理失败'});}finally{this.setData({organizing:false});}},
  deepFirst(){if(!this.requireLogin('upload'))return;const batch=this.data.batches[0];if(batch)this.deepOrganize({currentTarget:{dataset:{id:batch.id}}});else wx.showToast({title:'先上传资料到待整理区',icon:'none'});},
  confirmOptimized(){if(this.data.confirming||!this.data.optimizedItems.length)return;const noPreview=this.data.optimizedItems.filter((item)=>!item.preview).length;wx.showModal({title:'确认写入知识库',content:noPreview?`共 ${this.data.optimizedItems.length} 份，其中 ${noPreview} 份没有提取到可预览正文。仍要继续吗？`:`共 ${this.data.optimizedItems.length} 份。确认后将供战局、方案和对话引用。`,confirmText:noPreview?'仍然入库':'确认入库',success:async(result)=>{if(!result.confirm)return;this.setData({confirming:true});try{const ids=this.data.optimizedItems.map((item)=>item.id);const saved=await api.confirmKnowledge({ids});await this.load();await api.refreshForces().catch(()=>{});this.setData({stage:'confirmed'});wx.showToast({title:`${saved.count||ids.length} 份资料已入库`,icon:'none'});}catch(error){store.handleApiError(error,{fallbackTitle:error.message||'入库失败'});}finally{this.setData({confirming:false});}}});},
  removeFile(event){const id=event.currentTarget.dataset.id;const name=event.currentTarget.dataset.name||'这份资料';if(!id)return;wx.showModal({title:'删除这份资料',content:`删除「${name}」？删掉后可重新上传这一份。`,confirmText:'删除',success:async(result)=>{if(!result.confirm)return;try{await api.deleteKnowledge(id);await this.load();wx.showToast({title:'已删除',icon:'none'});}catch(error){store.handleApiError(error,{fallbackTitle:error.message||'删除失败'});}}});},
  // 刷新判断会让服务端重算三势并落库——与战局同一个 API，门禁口径必须一致（战局侧一直有门）。
  async refreshForces(){if(!this.requireLogin('execute')||this.data.refreshingForces)return;this.setData({refreshingForces:true});try{await api.refreshForces();wx.showToast({title:'已刷新战局判断',icon:'none'});}catch(error){store.handleApiError(error,{fallbackTitle:error.message||'刷新失败'});}finally{this.setData({refreshingForces:false});}},
  openKnowledge(){if(this.requireLogin('history'))navTo('/packages/work/knowledge/index');},
  async dataSourceAction(event){if(!this.requireLogin('execute'))return;const item=this.data.sources[Number(event.currentTarget.dataset.index)];if(!item)return;try{if(item.status==='unbound')await api.requestDataSourceAuth(item.key);else await api.uploadDataSource(item.key);await this.load();}catch(error){store.handleApiError(error,{fallbackTitle:error.message||'操作失败'});}},
  openSkuPurchase(key,title,after){
    if(!key||this.data.purchasing)return;
    const sku=safeList(this._skus).find((item)=>item.key===key);
    const price=money((sku&&sku.priceFen)||3900);
    wx.showModal({
      title:title||'开通能力',content:`单次购买 ${price}，支付后立即开通。`,confirmText:`支付 ${price}`,
      success:async(result)=>{
        if(!result.confirm)return;
        this.setData({purchasing:key});
        try{
          const order=await api.createSkuOrder(key,undefined,{source:'catalog'});
          const outTradeNo=order.orderId||order.outTradeNo;
          if(order.mock&&!order.appliedAt&&outTradeNo)await api.payMock(outTradeNo);
          else if(order.payParams||order.pay)await new Promise((resolve,reject)=>wx.requestPayment(Object.assign({},order.payParams||order.pay,{success:resolve,fail:reject})));
          const state=order.appliedAt?'applied':await this.waitSkuApplied(outTradeNo);
          if(state==='applied'){
            await store.loadMe().catch(()=>{});
            if(after)await after();
            wx.showToast({title:order.mock?'已开通（测试期模拟支付）':'已开通',icon:'none'});
          }else if(state==='failed'){
            wx.showToast({title:'订单未完成，请重新发起开通',icon:'none'});
          }else{
            wx.showToast({title:'支付结果待确认，权益到账后可继续操作',icon:'none'});
          }
        }catch(error){
          if(!/cancel/i.test(String(error.errMsg||error.message||'')))store.handleApiError(error,{fallbackTitle:error.message||'开通失败，请重试'});
        }finally{this.setData({purchasing:''});}
      }
    });
  },
  async waitSkuApplied(outTradeNo){
    if(!outTradeNo)return'pending';
    for(let index=0;index<5;index+=1){
      try{
        const status=await api.paymentStatus(outTradeNo);
        if(status.appliedAt||status.status==='applied')return'applied';
        if(['failed','closed','refunded'].includes(status.status))return'failed';
      }catch(_){/* 查询失败继续确认，最终按 pending 提示。 */}
      if(index<4)await wait(1200);
    }
    return'pending';
  },
});
