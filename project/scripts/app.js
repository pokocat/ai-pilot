/* ============================================================
   军师 App · 交互逻辑
   ============================================================ */
const COLORS = [
  { key:'gold',  cn:'财 金', short:'财金', wm:'势', seal:'金', en:'CAI JIN · FORTUNE',  verdict:'聚财为势，谋定而动。',
    v:{'--accent':'#A07D2C','--accent-deep':'#6E5621','--accent-soft':'#F2EAD6','--accent-ink':'#43340F','--accent-bright':'#D8B25A','--accent-glow':'rgba(200,165,90,.30)'} },
  { key:'green', cn:'墨 绿', short:'墨绿', wm:'谋', seal:'绿', en:'MO LÜ · VERDANT',     verdict:'稳中求进，守正出奇。',
    v:{'--accent':'#1E5A43','--accent-deep':'#163F30','--accent-soft':'#E7EEE9','--accent-ink':'#0F2B20','--accent-bright':'#5FB389','--accent-glow':'rgba(99,160,130,.32)'} },
  { key:'red',   cn:'朱 砂', short:'朱砂', wm:'决', seal:'朱', en:'ZHU SHA · CINNABAR',  verdict:'当机立断，先发制人。',
    v:{'--accent':'#9E2B25','--accent-deep':'#6F1B17','--accent-soft':'#F3E2DF','--accent-ink':'#4A1310','--accent-bright':'#D98077','--accent-glow':'rgba(190,90,80,.30)'} },
  { key:'blue',  cn:'黛 蓝', short:'黛蓝', wm:'远', seal:'黛', en:'DAI LAN · AZURE',     verdict:'高瞻远瞩，运筹千里。',
    v:{'--accent':'#1F4E79','--accent-deep':'#143350','--accent-soft':'#E2EAF1','--accent-ink':'#122C44','--accent-bright':'#6E98C6','--accent-glow':'rgba(90,140,200,.30)'} },
  { key:'purple',cn:'绛 紫', short:'绛紫', wm:'局', seal:'绛', en:'JIANG ZI · AMETHYST', verdict:'格局为先，纳于无形。',
    v:{'--accent':'#5B3A6B','--accent-deep':'#3D2748','--accent-soft':'#ECE4F1','--accent-ink':'#2F1E38','--accent-bright':'#A07FB3','--accent-glow':'rgba(150,110,170,.30)'} },
  { key:'iron',  cn:'玄 铁', short:'玄铁', wm:'藏', seal:'玄', en:'XUAN TIE · GRAPHITE',  verdict:'大巧若拙，藏锋守拙。',
    v:{'--accent':'#33373D','--accent-deep':'#212429','--accent-soft':'#E8E9EB','--accent-ink':'#1B1D21','--accent-bright':'#8A9099','--accent-glow':'rgba(120,130,140,.28)'} },
];
const LS_COLOR = 'junshi.color', LS_ONBOARDED = 'junshi.onboarded', LS_PROFILE = 'junshi.profile', LS_LIB = 'junshi.library';
const root = document.documentElement;
let sel = 0;

function colorIndex(key){ const i = COLORS.findIndex(c=>c.key===key); return i<0?0:i; }
function applyColor(i){ Object.entries(COLORS[i].v).forEach(([k,val])=>root.style.setProperty(k,val)); }

/* —— 本命色浮层 —— */
function paintHero(i){
  const c = COLORS[i];
  setText('pk-wm', c.wm); setText('pk-seal', c.seal); setText('pk-cn', c.cn);
  setText('pk-en', c.en); setText('pk-verdict', c.verdict);
  setText('pk-idx', '本命色 0'+(i+1)+' / 06'); setText('pk-name', c.short);
  // 同步“我的”里的色板
  const sw = document.getElementById('me-color-sw'); if(sw) sw.style.background = c.v['--accent'];
  setText('me-color-name', c.short);
}
function selectColor(i){
  sel = i; applyColor(i); paintHero(i);
  document.querySelectorAll('.ob-disc').forEach((d,n)=>d.classList.toggle('on', n===i));
  document.querySelectorAll('.ob-discnames span').forEach((s,n)=>s.classList.toggle('on', n===i));
}
function setText(id,t){ const e=document.getElementById(id); if(e) e.textContent=t; }

function buildDiscs(){
  const discs = document.getElementById('pk-discs'), names = document.getElementById('pk-discnames');
  COLORS.forEach((c,i)=>{
    const d=document.createElement('div'); d.className='ob-disc'+(i===0?' on':'');
    d.innerHTML='<i style="background:'+c.v['--accent']+'"></i>'; d.onclick=()=>selectColor(i);
    discs.appendChild(d);
    const s=document.createElement('span'); s.className=i===0?'on':''; s.textContent=c.short; names.appendChild(s);
  });
}

let pickerFirst=false;
function openPicker(first){
  pickerFirst=!!first;
  const o=document.getElementById('picker');
  document.getElementById('pk-close').classList.toggle('hide', !!first);
  const cs=document.getElementById('pk-step-color'), ps=document.getElementById('pk-step-profile');
  if(cs) cs.classList.add('on'); if(ps) ps.classList.remove('on');
  document.getElementById('pk-headline').textContent = first ? '入局之前，择一本命色' : '更换你的本命色';
  const cta=document.getElementById('pk-cta'); if(cta) cta.textContent = first ? '下一步 · 完善档案' : '确认更换';
  o.classList.remove('first');
  if(first){ o.classList.add('first'); } else { requestAnimationFrame(()=>o.classList.add('show')); }
}
function goProfile(){ document.getElementById('pk-step-color').classList.remove('on'); document.getElementById('pk-step-profile').classList.add('on'); }
function saveProfile(){ const sel={}; document.querySelectorAll('#pk-step-profile .pf-q').forEach(q=>{ const on=q.querySelector('.pf-opt.on'); if(on) sel[q.dataset.k]=on.textContent.trim(); }); localStorage.setItem(LS_PROFILE, JSON.stringify(sel)); applyProfile(); }
function applyProfile(){ const p=getProfile(); const sub=document.getElementById('greet-sub');
  if(sub){ sub.textContent = (p&&p.pain) ? ('今天，先把「'+p.pain+'」往前推一步。') : '今天有 3 条军师为你准备的洞察 · 随时可开口。'; }
  const c=document.getElementById('me-lib-count'); if(c) c.textContent=getLibrary().length+' 份成果';
}
function closePicker(){ document.getElementById('picker').classList.remove('show','first'); }
function confirmColor(){
  localStorage.setItem(LS_COLOR, COLORS[sel].key);
  localStorage.setItem(LS_ONBOARDED, '1');
  closePicker();
}

/* —— 屏幕导航 —— */
function go(screen){
  document.querySelectorAll('.app-screen').forEach(s=>s.classList.toggle('on', s.dataset.screen===screen));
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on', t.dataset.go===screen));
  const tb=document.getElementById('tabbar'); if(tb) tb.style.display = screen==='chat' ? 'none' : 'flex';
  const sb=document.querySelector('.statusbar'); if(sb) sb.classList.remove('on-dark');
  if(screen==='library'){ try{ renderLibrary(); }catch(_){} }
  if(screen==='sessions'){ try{ renderSessions(); buildAgentStrip(); }catch(_){} }
  const sc = document.querySelector('.app-screen[data-screen="'+screen+'"] .screen-scroll, .app-screen[data-screen="'+screen+'"] .chat-log');
  if(sc) sc.scrollTop = 0;
}

/* —— 对话流式回复 —— */
const REPLIES = {
  '战略体检':{ t:'好的，王总。军师已结合你的业务现状与行业基准，为「云栖科技」<strong>产出一份战略诊断</strong>：',
    points:['定位清晰，但增长动能集中在单一客群，存在结构性风险','产品具备差异化，建议强化高毛利线的心智占位','竞争层面：头部正在向下挤压，需尽快建立护城河叙事'],
    acts:[['chart','查看竞品洞察'],['doc','导出诊断报告']] },
  '增长方案':{ t:'已为你<strong>产出一条可直接执行的增长路径</strong>：',
    points:['腰部客群复购集中，适合做会员/订阅制','用内容 + 自动化触达，降低获客与跟进成本','分层定价拉升客单，预计拉动经常性收入'],
    acts:[['flow','一键生成完整方案'],['doc','导出为提案']] },
  '融资准备':{ t:'进入融资节奏前，军师先帮你把<strong>故事与数据</strong>对齐。当前需要补强：',
    points:['期权池预留不足，建议扩充至 12%–15%','增长曲线需补充单位经济模型（UE）','建议先做一版一页纸 BP 测试投资人反馈'],
    acts:[['doc','起草融资 BP'],['chart','查看估值逻辑']] },
  'default':{ t:'收到。军师正在为你拆解这个问题，直接给你一个可执行的判断：',
    points:['先界定问题的本质与边界','再用数据验证关键假设','最后给出 1 个主方案 + 1 个备选'],
    acts:[['spark','展开分析'],['chat','继续追问']] },
};
function pushUser(text){
  const log=document.getElementById('chat-log');
  const m=document.createElement('div'); m.className='msg u'; m.textContent=text; log.appendChild(m);
  log.scrollTop=log.scrollHeight;
}
function pushAssistant(key, instant){
  const log=document.getElementById('chat-log');
  const r=REPLIES[key]||REPLIES.default;
  const wrap=document.createElement('div'); wrap.className='msg a';
  const body='<p>'+r.t+'</p><ul style="margin:10px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:7px">'+
      r.points.map(p=>'<li style="font-size:13px;line-height:1.5">'+p+'</li>').join('')+'</ul>'+
      '<div class="acts">'+r.acts.map(a=>'<a><i class="ic" data-ic="'+a[0]+'"></i>'+a[1]+'</a>').join('')+'</div>';
  wrap.innerHTML='<div class="who"><span class="d"><i class="ic" data-ic="spark"></i></span>'+agentName()+'</div>'+
    '<div class="bubble">'+(instant?body:'<div class="typing"><i></i><i></i><i></i></div>')+'</div>';
  log.appendChild(wrap); window.paintIcons&&window.paintIcons(wrap); log.scrollTop=log.scrollHeight;
  if(instant) return;
  setTimeout(()=>{
    const bubble=wrap.querySelector('.bubble');
    bubble.innerHTML=body; window.paintIcons&&window.paintIcons(bubble); log.scrollTop=log.scrollHeight;
  }, 900);
}
/* —— 结构化成果（顾问产出） —— */
const DELIVERABLES = {
  '战略体检':{ icon:'target', title:'战略诊断报告',
    sections:[
      {h:'现状判断', b:'结合你最关注的「{PAIN}」，你当前处在“营收在增长、利润与现金流承压”的阶段：业务跑得动，但增长更多靠投入堆出来，单位经济模型还没跑正。'},
      {h:'关键卡点', list:['增长高度依赖单一客群，结构性风险偏高','缺乏清晰的差异化与定价权，易陷入价格战','组织与现金流节奏未匹配增长速度'] },
      {h:'30 天行动建议', list:['锁定 1 个高价值客群做深，跑通可复制的获客路径','重定价：把价值点显性化，测试提价 5–10% 的接受度','建 13 周现金流滚动表，给增长设安全边界'] },
    ]},
  '增长方案':{ icon:'trend', title:'增长方案',
    sections:[
      {h:'切入点', b:'从经常性收入入手：你的腰部客群复购集中，具备做会员/订阅制的基础。'},
      {h:'三步路径', list:['设计分层会员权益，把高频需求打包成订阅','用内容 + 自动化触达提高复购，降低人工成本','分层定价拉升客单，释放价格弹性'] },
      {h:'预期效果', b:'若走通，预计 12 个月经常性收入占比提升至 25%+，现金流稳定性明显改善。'},
    ]},
  '融资准备':{ icon:'doc', title:'融资准备清单',
    sections:[
      {h:'故事与数据对齐', b:'投资人先买“为什么是你”。先把增长逻辑与单位经济（UE）讲清楚。'},
      {h:'需补强项', list:['期权池预留建议扩充至 12–15%','补充单位经济模型与同口径增长曲线','准备一页纸 BP，先测投资人反馈'] },
      {h:'下一步', b:'建议先由“融资参谋”起草一页纸 BP，再进入正式 BP 与财务模型。'},
    ]},
  '竞品洞察':{ icon:'chart', title:'竞品洞察',
    sections:[
      {h:'竞争格局', b:'结合你最关注的「{PAIN}」，当前赛道呈“头部挤压、腰部分化”格局，差异化是你最现实的突破口。'},
      {h:'对手动向', list:['头部在以价格与渠道下沉抢腰部客户','同梯队对手在补内容与服务，拉高获客门槛','长尾玩家在细分场景做深，值得警惕'] },
      {h:'机会窗口', list:['卡住一个对手覆盖不到的高价值细分','用服务深度建立转换成本，弱化价格战','6 个月内建立可叙述的差异化心智'] },
    ]},
  '商业模式画布':{ icon:'layers', title:'商业模式画布',
    sections:[
      {h:'价值主张', b:'围绕「{PAIN}」，你的核心价值应聚焦“可量化的结果”，而非功能罗列。'},
      {h:'收入与成本', list:['把高频价值打包为订阅，提升收入可预测性','分离一次性交付与持续服务的计价','压降获客与交付的边际成本'] },
      {h:'优化建议', b:'优先验证“订阅 + 增值”双层结构，跑通后再扩客群。'},
    ]},
  '组织优化建议':{ icon:'user', title:'组织优化建议',
    sections:[
      {h:'组织现状', b:'增长阶段最常见的问题是“关键岗位过载、决策集中在创始人”。'},
      {h:'关键瓶颈', list:['缺少能独立带结果的二号位/业务负责人','激励与目标未对齐，执行打折','期权与晋升通道不清晰，留人承压'] },
      {h:'调整建议', list:['先补 1 个能独当一面的关键岗','用 OKR 对齐目标与激励','明确期权池与晋升规则，稳住核心'] },
    ]},
  '营销内容':{ icon:'image', title:'营销内容方案',
    sections:[
      {h:'核心信息', b:'把战略翻译成一句客户能复述的话——围绕「{PAIN}」给出可被记住的价值点。'},
      {h:'内容方向', list:['客户证言 / 结果数据，建立可信度','场景化短视频，降低理解成本','创始人视角的观点内容，塑造品牌'] },
      {h:'执行清单', list:['1 组主视觉海报 + 3 条短视频脚本','2 周节奏排期','统一品牌语气与话术'] },
    ]},
  '经营分析':{ icon:'clock', title:'经营分析',
    sections:[
      {h:'经营现状', b:'结合「{PAIN}」，当前“增收不增利”的概率较高，需盯紧单位经济与现金转换。'},
      {h:'关键指标', list:['毛利率与同比趋势','现金转换周期（CCC）','人效与获客回收周期'] },
      {h:'改进建议', list:['建 13 周现金流滚动表','按客群/产品做盈利分层','砍掉拉低毛利的低质量增长'] },
    ]},
  '企业IP打造':{ icon:'crown', title:'企业 IP 打造方案',
    sections:[
      {h:'IP 定位', b:'围绕「{PAIN}」与你的行业身份，建议把创始人 IP 立为“懂经营的实战派”，让专业可被感知。'},
      {h:'人设与内容支柱', list:['3 个内容支柱：行业判断 / 实战复盘 / 价值观','统一的口头禅与视觉符号，强化记忆','固定更新节奏，先做深一个平台'] },
      {h:'启动动作', list:['拍一条“我是谁、我能帮你什么”的定调短片','整理 10 个高频问题做成系列内容','30 天内完成首批 8 条内容'] },
    ]},
  '企业宣传片':{ icon:'video', title:'企业宣传片脚本',
    sections:[
      {h:'核心叙事', b:'以“客户的改变”为主线，而非罗列业务——让观众在 60 秒里记住你解决了什么。'},
      {h:'分镜脚本', list:['0–10s 钩子：抛出客户最痛的问题','10–40s 转折：你的方法与真实案例','40–60s 收束：愿景 + 行动召唤'] },
      {h:'制作清单', list:['1 条 60s 主片 + 3 条 15s 切片','实拍 + 字幕板结合，控制成本','统一品牌色与片头片尾'] },
    ]},
  '海报设计':{ icon:'image', title:'海报方案',
    sections:[
      {h:'主视觉概念', b:'一张海报只讲一件事。围绕「{PAIN}」给出一个可被一眼读懂的核心信息。'},
      {h:'文案与版式', list:['主标题一句话直击价值','副文案补充信任状（数据/证言）','留白克制，信息分级清晰'] },
      {h:'产出规格', list:['朋友圈竖版 + 公众号头图','深色与浅色两版','预留品牌 LOGO 安全区'] },
    ]},
  '短视频策划':{ icon:'video', title:'短视频脚本',
    sections:[
      {h:'选题与钩子', b:'从“客户会转发给老板看”的角度选题；前 3 秒必须制造好奇或共鸣。'},
      {h:'脚本结构', list:['钩子：一句反常识或痛点','正文：3 个要点，节奏明快','结尾：一句记得住的总结 + 引导'] },
      {h:'拍摄提示', list:['口播 + 字幕，竖屏构图','一个观点一条，别贪多','固定开场与人设标识'] },
    ]},
  '营销文案':{ icon:'pen', title:'营销文案',
    sections:[
      {h:'核心卖点', b:'把「{PAIN}」翻译成客户能复述的一句话价值主张。'},
      {h:'多版文案', list:['朋友圈版：口语、有钩子','官网版：正式、讲信任','私域版：直接、给行动指令'] },
      {h:'使用场景', b:'按渠道选版本，保持主信息一致、表达随场景微调。'},
    ]},
};
function nowTime(){ const d=new Date(); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function fmtDate(ts){ const d=new Date(ts); return (d.getMonth()+1)+'月'+d.getDate()+'日 '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function getProfile(){ try{ return JSON.parse(localStorage.getItem(LS_PROFILE)||'null'); }catch(_){ return null; } }
function profileLabel(){ const p=getProfile(); return p&&p.industry ? ('云栖科技 · '+p.industry+(p.stage?' · '+p.stage:'')) : '云栖科技 · 已就绪'; }

/* 方案库 */
function getLibrary(){ try{ return JSON.parse(localStorage.getItem(LS_LIB)||'[]'); }catch(_){ return []; } }
function saveToLibrary(title,key){ const lib=getLibrary(); lib.unshift({title,key,at:Date.now()}); localStorage.setItem(LS_LIB, JSON.stringify(lib)); const c=document.getElementById('me-lib-count'); if(c) c.textContent=lib.length+' 份成果'; }
function renderLibrary(){
  const box=document.getElementById('lib-list'), empty=document.getElementById('lib-empty'); if(!box) return;
  const lib=getLibrary();
  if(!lib.length){ empty.style.display='block'; box.style.display='none'; return; }
  empty.style.display='none'; box.style.display='flex'; box.innerHTML='';
  lib.forEach(it=>{ const ic=DELIVERABLES[it.key]?DELIVERABLES[it.key].icon:'doc';
    const el=document.createElement('div'); el.className='lib-item';
    el.innerHTML='<span class="li-ic"><i class="ic" data-ic="'+ic+'"></i></span><div class="li-b"><div class="li-t">'+it.title+'</div><div class="li-m">'+fmtDate(it.at)+' · 已保存</div></div><span class="li-go"><i class="ic" data-ic="arrow"></i></span>';
    el.onclick=()=>sendToChat(it.key); box.appendChild(el); });
  window.paintIcons&&window.paintIcons(box);
}

/* Toast */
let toastT=null;
function toast(msg){ let t=document.getElementById('toast');
  if(!t){ t=document.createElement('div'); t.id='toast'; t.className='toast'; (document.querySelector('.screen')||document.body).appendChild(t); }
  t.innerHTML='<i class="ic" data-ic="check"></i>'+msg; window.paintIcons&&window.paintIcons(t);
  t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),1900);
}

function renderReport(key, instant){
  const log=document.getElementById('chat-log'); const d=DELIVERABLES[key]; if(!d){ pushAssistant('default', instant); return; }
  const pain=(getProfile()&&getProfile().pain)||'增长与盈利';
  const wrap=document.createElement('div'); wrap.className='msg a';
  wrap.innerHTML='<div class="who"><span class="d"><i class="ic" data-ic="spark"></i></span>'+agentName()+'</div>'+
    '<div class="report"><div class="rh"><span class="ic-wrap"><i class="ic" data-ic="'+d.icon+'"></i></span>'+
    '<span class="tt"><span class="t">'+d.title+'</span><span class="m">'+profileLabel()+'</span></span>'+
    (instant?'<span class="m" style="font-size:11px;color:var(--ink-3)">已生成</span>':'<span class="gen"><span class="spin"></span>产出中</span>')+'</div>'+
    '<div class="rb">'+(instant?'':'<div class="skl h"></div><div class="skl w90"></div><div class="skl w70"></div><div class="skl w50"></div>')+'</div></div>';
  log.appendChild(wrap); window.paintIcons&&window.paintIcons(wrap); log.scrollTop=log.scrollHeight;
  const report=wrap.querySelector('.report'), rb=wrap.querySelector('.rb');
  function finish(){
    const foot=document.createElement('div'); foot.className='foot';
    foot.innerHTML='<i class="ic" data-ic="shield"></i><span>本成果基于行业基准与你提供的信息生成，供决策参考；重大决策请结合专业意见。</span>';
    report.appendChild(foot);
    const acts=document.createElement('div'); acts.className='acts';
    acts.innerHTML='<a class="primary" data-save><i class="ic" data-ic="layers"></i>存入方案库</a><a class="ghost"><i class="ic" data-ic="doc"></i>导出</a>';
    report.appendChild(acts); window.paintIcons&&window.paintIcons(report);
    acts.querySelector('[data-save]').onclick=function(){ saveToLibrary(d.title,key); this.classList.remove('primary'); this.classList.add('saved'); this.innerHTML='<i class="ic" data-ic="check"></i>已存入方案库'; window.paintIcons&&window.paintIcons(this); toast('已存入方案库'); };
    acts.querySelector('.ghost').onclick=()=>toast('正在生成 PDF…');
    log.scrollTop=log.scrollHeight;
  }
  if(instant){ d.sections.forEach((s,i)=>{ const sec=document.createElement('div'); sec.className='rsec';
      let inner='<div class="sh"><span class="no">'+(i+1)+'</span>'+s.h+'</div>';
      if(s.b) inner+='<div class="sb">'+s.b.replace('{PAIN}',pain)+'</div>';
      if(s.list) inner+='<ul>'+s.list.map(x=>'<li>'+x+'</li>').join('')+'</ul>';
      sec.innerHTML=inner; rb.appendChild(sec); }); finish(); return; }
  let idx=0;
  function step(){
    if(idx===0) rb.innerHTML='';
    if(idx<d.sections.length){
      const s=d.sections[idx]; const sec=document.createElement('div'); sec.className='rsec reveal';
      let inner='<div class="sh"><span class="no">'+(idx+1)+'</span>'+s.h+'</div>';
      if(s.b) inner+='<div class="sb">'+s.b.replace('{PAIN}',pain)+'</div>';
      if(s.list) inner+='<ul>'+s.list.map(x=>'<li>'+x+'</li>').join('')+'</ul>';
      sec.innerHTML=inner; rb.appendChild(sec); log.scrollTop=log.scrollHeight; idx++; setTimeout(step,640);
    } else {
      const gen=report.querySelector('.gen'); if(gen) gen.outerHTML='<span class="m" style="font-size:11px;color:var(--ink-3)">'+nowTime()+' 生成</span>';
      finish(); learnNote();
    }
  }
  setTimeout(step,950);
}

function respond(text, instant){
  if(DELIVERABLES[text]) renderReport(text, instant);
  else pushAssistant(REPLIES[text]?text:'default', instant);
}
/* —— 会话 / 顾问隔离 / 可回溯 —— */
const AGENTS={
  general:{name:'军师',role:'通用商业军师',icon:'spark',
    greet:'王总好，我是你的 AI 商业军师。说说你的处境，或直接要一个成果，我来产出。',
    mem:'已了解你的<b>企业档案</b>与历史会话', learn:'持续学习中', chips:[['target','战略体检'],['trend','增长方案'],['shield','融资准备']]},
  strat:{name:'战略诊断官',role:'定位 · 卡点 · SWOT',icon:'target',
    greet:'我是战略诊断官。把你最近的纠结讲给我，我直接产出一份战略诊断。',
    mem:'记得你最关注<b>「增长乏力」</b>，已沉淀 2 次诊断', learn:'记忆已更新', chips:[['target','战略体检']]},
  growth:{name:'增长操盘手',role:'获客 · 转化 · 复购 · 定价',icon:'trend',
    greet:'我是增长操盘手。告诉我你的增长目标，我给你可执行的路径。',
    mem:'已学习你的<b>客群结构与定价</b>', learn:'记忆已更新', chips:[['trend','增长方案']]},
  intel:{name:'竞争情报官',role:'对手 · 赛道 · 机会窗口',icon:'chart',
    greet:'我是竞争情报官。说说你盯的对手或赛道，我帮你看清局势。',
    mem:'持续追踪你的 <b>3 个对手</b>', learn:'情报已更新', chips:[['chart','竞品洞察']]},
  fund:{name:'融资参谋',role:'BP · 估值 · 投资人问答',icon:'doc',
    greet:'我是融资参谋。把你的融资节奏讲给我，我帮你把故事和数据对齐。',
    mem:'记得你的<b>轮次与期权结构</b>', learn:'记忆已更新', chips:[['doc','融资准备']]},
  model:{name:'商业模式设计师',role:'画布 · 盈利模型 · 定价',icon:'layers',
    greet:'我是商业模式设计师。讲讲你怎么赚钱，我帮你把模式与定价结构理清。',
    mem:'已掌握你的<b>收入与成本结构</b>', learn:'记忆已更新', chips:[['layers','商业模式画布']]},
  org:{name:'组织人效顾问',role:'架构 · 股权 · 激励 · 人效',icon:'user',
    greet:'我是组织人效顾问。说说你的团队现状，我给出组织与激励的优化建议。',
    mem:'了解你的<b>团队规模与关键岗</b>', learn:'记忆已更新', chips:[['user','组织优化建议']]},
  brand:{name:'品牌营销官',role:'海报 · 短视频 · 文案',icon:'image',
    greet:'我是品牌营销官。告诉我要推什么，我把战略翻译成对外内容。',
    mem:'已熟悉你的<b>品牌语气与客群</b>', learn:'记忆已更新', chips:[['image','营销内容']]},
  ops:{name:'经营参谋',role:'经营测算 · 预算 · 复盘',icon:'clock',
    greet:'我是经营参谋。把你的经营数据口径讲给我，我帮你测算与复盘。',
    mem:'已对齐你的<b>经营指标口径</b>', learn:'记忆已更新', chips:[['clock','经营分析']]},
  ip:{name:'企业IP打造官',role:'定位 · 人设 · 内容支柱',icon:'crown',
    greet:'我是企业 IP 打造官。告诉我你想立的形象，我帮你把创始人/企业 IP 立起来。',
    mem:'已熟悉你的<b>行业身份与风格</b>', learn:'记忆已更新', chips:[['crown','企业IP打造']]},
  promo:{name:'企业宣传片导演',role:'叙事 · 分镜 · 制作',icon:'video',
    greet:'我是宣传片导演。说说你想传达什么，我给你一条可拍的宣传片脚本。',
    mem:'记得你的<b>品牌调性与卖点</b>', learn:'记忆已更新', chips:[['video','企业宣传片']]},
  poster:{name:'海报设计师',role:'主视觉 · 版式 · 物料',icon:'image',
    greet:'我是海报设计师。告诉我要推的主题，我给你一版主视觉与文案。',
    mem:'已掌握你的<b>品牌色与版式偏好</b>', learn:'记忆已更新', chips:[['image','海报设计']]},
  shortvideo:{name:'短视频策划',role:'选题 · 钩子 · 脚本',icon:'video',
    greet:'我是短视频策划。给我一个主题，我把它写成有钩子的脚本。',
    mem:'了解你的<b>客群与平台</b>', learn:'记忆已更新', chips:[['video','短视频策划']]},
  copy:{name:'商业文案官',role:'卖点 · 多版 · 场景',icon:'pen',
    greet:'我是商业文案官。说说要写什么，我给你多版可直接用的文案。',
    mem:'已熟悉你的<b>语气与卖点</b>', learn:'记忆已更新', chips:[['pen','营销文案']]},
};
const AGENT_ORDER=['general','strat','growth','intel','fund','model','org','brand','ops'];
const KEY2AGENT={'战略体检':'strat','增长方案':'growth','融资准备':'fund','竞品洞察':'intel','商业模式画布':'model','组织优化建议':'org','营销内容':'brand','经营分析':'ops','企业IP打造':'ip','企业宣传片':'promo','海报设计':'poster','短视频策划':'shortvideo','营销文案':'copy'};
function agentForKey(text){ return KEY2AGENT[text]||'general'; }
function agentName(){ return (AGENTS[activeSession&&activeSession.agent]||AGENTS.general).name; }

const LS_SESSIONS='junshi.sessions';
let activeSession=null;
function getSessions(){ try{ return JSON.parse(localStorage.getItem(LS_SESSIONS)||'[]'); }catch(_){ return []; } }
function saveSessions(a){ localStorage.setItem(LS_SESSIONS, JSON.stringify(a)); }
function persistActive(){ if(!activeSession) return; const all=getSessions(); const i=all.findIndex(s=>s.id===activeSession.id); activeSession.updatedAt=Date.now(); if(i>=0) all[i]=activeSession; else all.unshift(activeSession); saveSessions(all); }
function recordMsg(m){ if(!activeSession) return; activeSession.messages.push(m); if(m.role==='user' && (!activeSession.title||activeSession.title==='新对话')) activeSession.title=m.text.slice(0,18); persistActive(); }
/* 新建会话仅在内存中创建；首次发消息后才落库，避免空会话堆积 */
function newSession(agentKey){ activeSession={id:'s'+Date.now(),agent:agentKey||'general',title:'新对话',messages:[],createdAt:Date.now(),updatedAt:Date.now()}; return activeSession; }
function continueAgent(agentKey){ const all=getSessions(); const s=all.filter(x=>x.agent===agentKey).sort((a,b)=>b.updatedAt-a.updatedAt)[0]; return s||newSession(agentKey); }

function openSession(session, opts){
  opts=opts||{}; activeSession=session;
  const A=AGENTS[session.agent]||AGENTS.general;
  go('chat');
  document.getElementById('chat-agent-name').textContent=A.name;
  document.getElementById('chat-agent-role').textContent='· '+A.role;
  document.getElementById('chat-agent-av').innerHTML='<i class="ic" data-ic="'+A.icon+'"></i>';
  document.getElementById('chat-mem-text').innerHTML=A.mem;
  document.getElementById('chat-mem-learn').innerHTML='<span class="dot"></span>'+A.learn;
  const log=document.getElementById('chat-log'); log.innerHTML='';
  // 问候（不入库）+ chips
  const greet=document.createElement('div'); greet.className='msg a';
  greet.innerHTML='<div class="who"><span class="d"><i class="ic" data-ic="'+A.icon+'"></i></span>'+A.name+'</div>'+
    '<div class="bubble">'+A.greet+'<div class="acts">'+A.chips.map(c=>'<a data-jump="'+c[1]+'"><i class="ic" data-ic="'+c[0]+'"></i>'+c[1]+'</a>').join('')+'</div></div>';
  log.appendChild(greet);
  session.messages.forEach(m=>{ if(m.role==='user') pushUser(m.text); else if(m.role==='report') renderReport(m.key,true); else pushAssistant(m.key,true); });
  window.paintIcons&&window.paintIcons(log);
  document.querySelector('.app-screen[data-screen=chat] .chat-log').scrollTop=log.scrollHeight;
  if(opts.send) sendInSession(opts.send);
}
function sendInSession(text){
  pushUser(text); recordMsg({role:'user',text});
  if(DELIVERABLES[text]){ recordMsg({role:'report',key:text}); renderReport(text); }
  else { const k=REPLIES[text]?text:'default'; recordMsg({role:'assistant',key:k}); pushAssistant(k); }
}
function learnNote(){
  if(!activeSession || activeSession.agent==='general') return;
  const A=AGENTS[activeSession.agent]; const log=document.getElementById('chat-log');
  setTimeout(()=>{ const n=document.createElement('div'); n.className='mem-learned';
    n.innerHTML='<i class="ic" data-ic="spark"></i><span>记忆已更新：<b>'+A.name+'</b> 已从本次对话学到你的业务偏好，下次产出会更贴合。</span>';
    log.appendChild(n); window.paintIcons&&window.paintIcons(n); log.scrollTop=log.scrollHeight; }, 500);
}

function relTime(ts){ const s=(Date.now()-ts)/1000; if(s<60) return '刚刚'; if(s<3600) return Math.floor(s/60)+' 分钟前'; if(s<86400) return Math.floor(s/3600)+' 小时前'; const d=Math.floor(s/86400); return d===1?'昨天':d+' 天前'; }
function renderSessions(){
  const wrap=document.getElementById('sess-list'), empty=document.getElementById('sess-empty'); if(!wrap) return;
  const all=getSessions().sort((a,b)=>b.updatedAt-a.updatedAt);
  if(!all.length){ empty.style.display='block'; wrap.style.display='none'; return; }
  empty.style.display='none'; wrap.style.display='flex'; wrap.innerHTML='';
  all.forEach(s=>{ const A=AGENTS[s.agent]||AGENTS.general;
    const last=[...s.messages].reverse().find(m=>m.text||m.key);
    let snip='新对话'; if(last){ snip = last.text || (DELIVERABLES[last.key]?('已产出《'+DELIVERABLES[last.key].title+'》'):'已回复'); }
    const el=document.createElement('div'); el.className='sess-item';
    el.innerHTML='<span class="si-ic"><i class="ic" data-ic="'+A.icon+'"></i></span>'+
      '<div class="si-b"><div class="si-top"><span class="si-agent">'+A.name+'</span><span class="si-time">'+relTime(s.updatedAt)+'</span></div>'+
      '<div class="si-t">'+(s.title||'新对话')+'</div><div class="si-snip">'+snip+'</div></div>';
    el.onclick=()=>openSession(s); wrap.appendChild(el); });
  window.paintIcons&&window.paintIcons(wrap);
}
function buildAgentStrip(){
  const strip=document.getElementById('agent-strip'); if(!strip) return; strip.innerHTML='';
  AGENT_ORDER.forEach(k=>{ const A=AGENTS[k]; const el=document.createElement('div'); el.className='agent-chip'+(k==='general'?' general':'');
    el.innerHTML='<span class="ac-ic"><i class="ic" data-ic="'+A.icon+'"></i></span><span class="ac-n">'+A.name+'</span>';
    el.onclick=()=>openSession(newSession(k)); strip.appendChild(el); });
  window.paintIcons&&window.paintIcons(strip);
}
/* 新建会话浮层 */
function openAgentSheet(){
  const list=document.getElementById('sheet-list'); list.innerHTML='';
  AGENT_ORDER.forEach(k=>{ const A=AGENTS[k]; const row=document.createElement('div'); row.className='sheet-row'+(k==='general'?' general':'');
    row.innerHTML='<span class="sr-ic"><i class="ic" data-ic="'+A.icon+'"></i></span><div class="sr-b"><div class="sr-n">'+A.name+'</div><div class="sr-d">'+A.role+'</div></div><span class="sr-go"><i class="ic" data-ic="arrow"></i></span>';
    row.onclick=()=>{ closeAgentSheet(); openSession(newSession(k)); }; list.appendChild(row); });
  window.paintIcons&&window.paintIcons(list);
  document.getElementById('agent-sheet').classList.add('show');
}
function closeAgentSheet(){ document.getElementById('agent-sheet').classList.remove('show'); }

function sendToChat(text){
  const ak=agentForKey(text); const s=continueAgent(ak); openSession(s,{send:text});
}
/* 中间 Tab：直接开新会话（默认通用军师），参考主流 AI 应用 */
function startNewChat(agentKey){ openSession(newSession(agentKey||'general')); }
/* 进入某位顾问：打开 TA 自己的会话线程（续聊或新建），不串味 */
function openAgentChat(agentKey){ openSession(continueAgent(agentKey)); }

/* —— 启动 —— */
document.addEventListener('DOMContentLoaded', ()=>{
  buildDiscs();
  const saved = localStorage.getItem(LS_COLOR);
  const onboarded = localStorage.getItem(LS_ONBOARDED)==='1';
  const startIdx = saved ? colorIndex(saved) : 0;
  selectColor(startIdx);
  go('home');
  if(!onboarded){ openPicker(true); }

  // 首页对话框
  const homeInput=document.getElementById('home-input');
  const homeSend=()=>{ const v=homeInput.value.trim(); sendToChat(v||'帮我做一次战略体检'); homeInput.value=''; };
  document.getElementById('home-send').onclick=homeSend;
  homeInput.addEventListener('keydown',e=>{ if(e.key==='Enter') homeSend(); });
  document.querySelectorAll('.ask .chip, .home-ask .chip, .hero-ask .chip').forEach(c=>c.onclick=()=>sendToChat(c.dataset.q));
  document.querySelectorAll('[data-ask]').forEach(c=>c.onclick=()=>sendToChat(c.dataset.ask));
  document.querySelectorAll('[data-feed]').forEach(c=>c.onclick=()=>go('kb'));

  // 对话屏 composer
  const cInput=document.getElementById('chat-input');
  const cSend=()=>{ const v=cInput.value.trim(); if(!v)return; sendInSession(v); cInput.value=''; };
  document.getElementById('chat-send').onclick=cSend;
  cInput.addEventListener('keydown',e=>{ if(e.key==='Enter') cSend(); });
  // 会话列表：新建
  const sn=document.getElementById('sess-new-btn'); if(sn) sn.onclick=openAgentSheet;
  const sne=document.getElementById('sess-new-empty'); if(sne) sne.onclick=openAgentSheet;
  const ash=document.getElementById('agent-sheet'); if(ash) ash.onclick=e=>{ if(e.target===ash) closeAgentSheet(); };
  const ashc=document.getElementById('sheet-close'); if(ashc) ashc.onclick=closeAgentSheet;

  // tabs（中间「对话」= 直接开新会话）
  document.querySelectorAll('.tab[data-go]').forEach(t=>t.onclick=()=>{ if(t.dataset.go==='sessions') startNewChat(); else go(t.dataset.go); });
  document.querySelectorAll('[data-agent]').forEach(c=>c.onclick=()=>openAgentChat(c.dataset.agent));
  const chHist=document.getElementById('chat-hist'); if(chHist) chHist.onclick=()=>go('sessions');
  const chNew=document.getElementById('chat-new'); if(chNew) chNew.onclick=()=>startNewChat();
  // 浮层
  document.getElementById('pk-confirm').onclick=()=>{ if(pickerFirst) goProfile(); else confirmColor(); };
  document.getElementById('pk-skip').onclick=confirmColor;
  document.getElementById('pk-close').onclick=closePicker;
  const pfEnter=document.getElementById('pf-enter'); if(pfEnter) pfEnter.onclick=()=>{ saveProfile(); confirmColor(); };
  const pfSkip=document.getElementById('pf-skip'); if(pfSkip) pfSkip.onclick=confirmColor;
  document.querySelectorAll('#pk-step-profile .pf-q').forEach(q=>q.querySelectorAll('.pf-opt').forEach(o=>o.onclick=()=>{ q.querySelectorAll('.pf-opt').forEach(x=>x.classList.remove('on')); o.classList.add('on'); }));
  document.getElementById('me-color-row').onclick=()=>openPicker(false);
  const mlr=document.getElementById('me-lib-row'); if(mlr) mlr.onclick=()=>go('library');
  document.querySelectorAll('[data-rechoose]').forEach(b=>b.onclick=()=>openPicker(false));
  applyProfile();

  window.paintIcons&&window.paintIcons();

  // 每日一句话献策（按日期取一条，每天一换）
  (function(){
    const line=document.getElementById('say-line'), dateEl=document.getElementById('say-date');
    if(!line) return;
    const SAYINGS=[
      '先把自己<em>立于不败</em>，再等对手露出破绽。',
      '现金流不是结果，是你每个<em>决策的回声</em>。',
      '增长的尽头，是你能<em>服务好</em>的那群人。',
      '战略是<em>选择不做什么</em>，比做什么更难。',
      '没有<em>壁垒</em>的增长是负债；先有护城河，再谈规模。',
      '别在<em>非共识</em>里随大流，机会藏在少数人对的地方。',
      '组织的上限，往往是<em>创始人认知</em>的上限。',
      '做难而正确的事，<em>时间</em>会成为你的朋友。',
    ];
    const day=Math.floor(Date.now()/8.64e7);
    line.innerHTML=SAYINGS[day % SAYINGS.length];
    if(dateEl){ const d=new Date(); dateEl.textContent=(d.getMonth()+1)+'月'+d.getDate()+'日'; }
  })();
});
