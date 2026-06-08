/* VEO Conductor — app clicable completa. Self-contained: define todo + monta App. */
const {useState,useEffect}=React;
const I={
 signal:()=> <svg width="17" height="11" viewBox="0 0 18 12"><g fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2.5" width="3" height="9.5" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>,
 wifi:()=> <svg width="16" height="11" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.4c2.6 0 5 1 6.8 2.7l1.4-1.5A11.4 11.4 0 0 0 8.5.4 11.4 11.4 0 0 0 .3 3.6L1.7 5A9.4 9.4 0 0 1 8.5 2.4Z"/><path d="M8.5 9.5 10.6 7.4A3 3 0 0 0 8.5 6.6 3 3 0 0 0 6.4 7.4Z"/></svg>,
 batt:()=> <svg width="24" height="12" viewBox="0 0 26 13"><rect x="0.5" y="0.5" width="22" height="12" rx="3.2" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="9" rx="2" fill="currentColor"/></svg>,
 back:()=> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>,
 x:()=> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>,
 star:(f)=> <svg width="14" height="14" viewBox="0 0 24 24" fill={f?'currentColor':'none'} stroke="currentColor" strokeWidth="1.6"><path d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17.8 6.7 19.2l1-5.8L3.5 9.2l5.9-.9z"/></svg>,
 shield:()=> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6z"/></svg>,
 pin:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>,
 navi:()=> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M3 11l18-8-8 18-2-8z"/></svg>,
 chat:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.7A8 8 0 1 1 21 12Z"/></svg>,
 power:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 3v9"/><path d="M6.5 7a8 8 0 1 0 11 0"/></svg>,
 doc:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>,
 car:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11M5 11h14v5H5z"/><circle cx="8" cy="16" r="1.4"/><circle cx="16" cy="16" r="1.4"/></svg>,
 bike:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-7h4l2 4M10 10l-1-3H7"/></svg>,
 cam:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.2"/></svg>,
 check:()=> <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10"/></svg>,
 chevR:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6"/></svg>,
 money:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9a2.5 2 0 0 1 5 0c0 2.5-5 1.5-5 4a2.5 2 0 0 0 5 0" strokeLinecap="round"/></svg>,
 flame:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 3c1 3 4 4 4 8a4 4 0 0 1-8 0c0-1.5.5-2.5 1-3 .3 1 1 1.5 1.5 1.5C11 8 10 6 12 3Z"/></svg>,
 gift:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M3 12h18M12 8v13M12 8S10 3 7.5 4.5 9 8 12 8s2.5-2 4.5-3.5S12 8 12 8Z"/></svg>,
 life:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M5 5l4 4M19 5l-4 4M5 19l4-4M19 19l-4-4"/></svg>,
 dest:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M5 3v18M5 4h11l-2 3 2 3H5"/></svg>,
 minus:()=> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14"/></svg>,
 plus:()=> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>,
 mail:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M4 7l8 6 8-6"/></svg>,
 phone:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M5 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L19 16l-1 3"/><path d="M16 21a13 13 0 0 1-13-13"/></svg>,
 home:()=> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>,
 reload:()=> <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 1 2.6 6.4M3 18v-4h4"/></svg>,
 alert:()=> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4" strokeLinecap="round"/><circle cx="12" cy="16.5" r="0.6" fill="currentColor"/></svg>,
};
const Bar=()=>(<div className="statusbar"><span className="mono">9:41</span><div className="right">{I.signal()}{I.wifi()}{I.batt()}</div></div>);
const NI=()=> <div className="nav-ind"/>;
const WM=({size=24})=>(<div style={{display:'flex',alignItems:'center',gap:9}}><span className="display" style={{fontSize:size,fontWeight:700}}>VEO</span><span style={{width:size*0.28,height:size*0.28,borderRadius:'50%',background:'var(--accent)',marginTop:size*0.08,boxShadow:'0 0 12px var(--route-glow)'}}/><span className="muted" style={{fontSize:size*0.42,fontWeight:600,marginTop:size*0.12,letterSpacing:'.04em'}}>Conductores</span></div>);
const Avatar=({size=44,label='KR'})=>(<div className="ph-img" style={{width:size,height:size,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',border:'1px solid var(--border)'}}><span className="mono" style={{fontSize:Math.max(8,size*0.18),color:'var(--ink-muted)'}}>{label}</span></div>);
const H=({t,onBack,onX,size=22,right})=>(<div className="pad" style={{paddingTop:54,paddingBottom:8,display:'flex',alignItems:'center',gap:12}}>{onBack&&<div className="iconbtn" onClick={onBack}>{I.back()}</div>}<h2 className="display" style={{fontSize:size,flex:1}}>{t}</h2>{right}{onX&&<div className="iconbtn" onClick={onX}>{I.x()}</div>}</div>);
const Pill=({tone,children})=>{const m={success:['rgba(57,191,137,.4)','var(--success)'],warn:['rgba(242,175,72,.4)','var(--warn)'],danger:['rgba(243,97,100,.4)','var(--danger)'],accent:['rgba(57,188,223,.4)','var(--accent)']}[tone]||['var(--border)','var(--ink-muted)'];return <span className="pill" style={{height:26,padding:'0 10px',fontSize:12,borderColor:m[0],color:m[1]}}><span className="dot" style={{background:m[1]}}/>{children}</span>;};
const Skel=({h=16,w='100%',r=10,mt=0})=> <div className="skl" style={{height:h,width:w,borderRadius:r,marginTop:mt}}/>;
const StateView=({icon,title,sub,cta,onCta})=>(<div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'0 40px',textAlign:'center'}}><div className="leadcircle" style={{width:60,height:60,borderRadius:18,marginBottom:18}}>{icon()}</div><div style={{fontWeight:700,fontSize:17}}>{title}</div><div className="subtle" style={{fontSize:13.5,marginTop:6,lineHeight:1.5}}>{sub}</div>{cta&&<button className="btn btn-surface btn-sm" style={{width:'auto',padding:'0 22px',marginTop:18}} onClick={onCta}>{I.reload()} {cta}</button>}</div>);

function MapView({mode='idle',carT=0.5,dim=false,heat=false}){
 const route="M 96 612 L 96 500 L 206 500 L 206 360 L 300 360 L 300 196";
 const pts=[[96,612],[96,500],[206,500],[206,360],[300,360],[300,196]];
 const cp=(()=>{const sl=[];let tot=0;for(let i=0;i<pts.length-1;i++){const l=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]);sl.push(l);tot+=l;}let d=carT*tot;for(let i=0;i<sl.length;i++){if(d<=sl[i]){const f=d/sl[i];return{x:pts[i][0]+(pts[i+1][0]-pts[i][0])*f,y:pts[i][1]+(pts[i+1][1]-pts[i][1])*f,ang:Math.atan2(pts[i+1][1]-pts[i][1],pts[i+1][0]-pts[i][0])};}d-=sl[i];}return{x:300,y:196,ang:0};})();
 const sr=mode==='route'||mode==='trip';
 return(<div className="map"><svg viewBox="0 0 390 844" preserveAspectRatio="xMidYMid slice">
  <g opacity="0.5">{Array.from({length:7}).map((_,r)=>Array.from({length:5}).map((_,c)=>{const x=c*92-30+((r%2)*16),y=r*120-40;return <rect key={r+'-'+c} x={x} y={y} width="74" height="92" rx="6" fill="#15202f"/>;}))}</g>
  <g stroke="#202b3c" strokeWidth="9" fill="none" opacity="0.9"><path d="M-20 140 H410"/><path d="M-20 360 H410"/><path d="M-20 500 H410"/><path d="M-20 700 H410"/><path d="M96 -20 V860"/><path d="M206 -20 V860"/><path d="M300 -20 V860"/></g>
  {heat&&<g>{[[120,300,70,'#39BF89'],[260,560,80,'#F2AF48'],[300,250,60,'#F36164']].map((h,k)=><circle key={k} cx={h[0]} cy={h[1]} r={h[2]} fill={h[3]} opacity="0.16"/>)}</g>}
  {sr&&<><path d={route} fill="none" stroke="var(--route-glow)" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round"/><path d={route} fill="none" stroke="var(--route)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/><circle cx="96" cy="612" r="9" fill="#121824" stroke="var(--accent)" strokeWidth="3.5"/><g><circle cx="300" cy="196" r="13" fill="var(--accent)"/><circle cx="300" cy="196" r="5" fill="#121824"/></g></>}
  {mode==='trip'&&<g transform={`translate(${cp.x} ${cp.y}) rotate(${cp.ang*180/Math.PI+90})`}><rect x="-13" y="-19" width="26" height="38" rx="9" fill="#121824" stroke="var(--accent)" strokeWidth="2.5"/><rect x="-7" y="-12" width="14" height="9" rx="2.5" fill="var(--accent)" opacity=".85"/></g>}
  {(mode==='idle'||mode==='avail')&&<><circle cx="195" cy="430" r="22" fill="var(--route-glow)"/><circle cx="195" cy="430" r="9" fill={mode==='avail'?'var(--success)':'var(--accent)'} stroke="#121824" strokeWidth="3"/></>}
 </svg>{dim&&<div style={{position:'absolute',inset:0,background:'rgba(13,20,32,.62)'}}/>}</div>);
}
const RegBar=({step})=>(<div className="pad" style={{marginTop:6}}><div style={{display:'flex',gap:6}}>{[1,2,3,4].map(n=><div key={n} style={{flex:1,height:5,borderRadius:99,background:n<=step?'var(--accent)':'var(--surface3)'}}/>)}</div><div className="subtle" style={{fontSize:12,marginTop:10}}>Paso {step} de 4</div></div>);

/* ===================== SCREENS ===================== */
const Splash=({go})=>(<div className="screen" style={{justifyContent:'space-between',background:"radial-gradient(90% 55% at 78% 14%, rgba(57,188,223,.16) 0%, transparent 55%), linear-gradient(180deg,#13202e 0%,#101725 45%,#121824 100%)"}} onClick={()=>go('login')}>
 <Bar/>
 <svg viewBox="0 0 390 844" style={{position:'absolute',inset:0,width:'100%',height:'100%',opacity:.55}}><path d="M-10 720 C 120 660, 90 470, 230 430 S 360 250, 330 120" fill="none" stroke="var(--route-glow)" strokeWidth="2.5" strokeDasharray="2 9" strokeLinecap="round"/><circle cx="330" cy="120" r="5" fill="var(--accent)"/></svg>
 <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',position:'relative'}}><WM size={32}/><p className="muted" style={{marginTop:14,fontSize:15}}>Maneja. Gana. Protegido.</p></div>
 <div className="pad" style={{paddingBottom:42,position:'relative',textAlign:'center'}}><div className="subtle" style={{fontSize:12}}>Toca para continuar</div></div><NI/></div>);

function Login({go,set}){
 const [phone,setPhone]=useState('');
 const fmt=v=>{const d=v.replace(/\D/g,'').slice(0,9);return d.replace(/(\d{3})(\d{0,3})(\d{0,3})/,(m,a,b,c)=>[a,b,c].filter(Boolean).join(' '));};
 const social=(name)=>{set({approved:true});go('home');};
 return(<div className="screen"><Bar/>
  <div className="pad scroll" style={{paddingTop:60,flex:1}}>
   <WM size={20}/>
   <h1 className="display" style={{fontSize:28,marginTop:24}}>Ingresa a VEO</h1>
   <p className="muted" style={{marginTop:8,fontSize:15}}>Tu cuenta de socio conductor.</p>
   <div className="card" style={{padding:16,marginTop:20,display:'flex',alignItems:'center',gap:14,cursor:'pointer'}} onClick={()=>social('faceid')}>
    <div style={{width:46,height:46,borderRadius:14,background:'var(--surface2)',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--accent)',flex:'none'}}>{I.shield()}</div>
    <div style={{flex:1}}><div style={{fontWeight:700,fontSize:15}}>Ingresar con Face ID</div><div className="subtle" style={{fontSize:12}}>Re-login rápido en este equipo</div></div>{I.chevR()}</div>
   <div style={{display:'flex',flexDirection:'column',gap:10,marginTop:14}}>
    <button className="btn btn-white btn-sm" onClick={()=>social('google')}><span style={{width:20,height:20,borderRadius:'50%',background:'#4285F4',color:'#fff',display:'inline-flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:12}}>G</span> Continuar con Google</button>
    <button className="btn btn-surface btn-sm" onClick={()=>social('fb')}><span style={{width:20,height:20,borderRadius:'50%',background:'#1877F2',color:'#fff',display:'inline-flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:13}}>f</span> Continuar con Facebook</button>
    <button className="btn btn-surface btn-sm" onClick={()=>go('email')}>{I.mail()} Continuar con correo</button>
   </div>
   <div style={{textAlign:'center',color:'var(--ink-subtle)',fontSize:12,margin:'18px 0',position:'relative'}}><span style={{background:'var(--bg)',padding:'0 12px',position:'relative',zIndex:1}}>o con tu número</span><div style={{position:'absolute',top:'50%',left:0,right:0,height:1,background:'var(--border)'}}/></div>
   <label className="fieldlabel">Número de celular</label>
   <div style={{display:'flex',gap:10}}><div className="field" style={{width:74,flex:'none',justifyContent:'center',fontWeight:600}}>+51</div><input className="field mono" style={{flex:1,fontSize:18}} inputMode="numeric" placeholder="987 654 321" value={phone} onChange={e=>setPhone(fmt(e.target.value))}/></div>
   <button className="btn btn-accent btn-lg" style={{marginTop:16}} disabled={phone.replace(/\D/g,'').length!==9} onClick={()=>go('otp')}>Enviar código</button>
  </div><NI/></div>);
}

function Email({go,set}){const [err,setErr]=useState(false);
 return(<div className="screen"><Bar/><H t="Correo" onBack={()=>go('login',true)}/>
  <div className="pad" style={{flex:1,marginTop:8}}>
   <div><label className="fieldlabel">Correo</label><input className="field" defaultValue="khalid@correo.com"/></div>
   <div style={{marginTop:14}}><label className="fieldlabel">Contraseña</label><input className="field" type="password" defaultValue="123456"/></div>
   {err&&<div style={{color:'var(--danger)',fontSize:13,marginTop:10,display:'flex',gap:7,alignItems:'center'}}>{I.alert()} Correo o contraseña incorrectos.</div>}
  </div>
  <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent btn-lg" onClick={()=>{set({approved:true});go('home');}}>Ingresar</button></div><NI/></div>);
}

function Otp({go}){const [otp,setOtp]=useState('4821');const [err]=useState(false);
 return(<div className="screen"><Bar/>
  <div className="pad" style={{paddingTop:60,flex:1}}>
   <div className="iconbtn" onClick={()=>go('login',true)} style={{marginBottom:22}}>{I.back()}</div>
   <h1 className="display" style={{fontSize:30}}>Código</h1>
   <p className="muted" style={{marginTop:8,fontSize:15}}>Te enviamos un código a <span className="mono">+51 ··· 321</span></p>
   <div style={{display:'flex',gap:9,marginTop:28}}>{Array.from({length:6}).map((_,k)=><div key={k} style={{flex:1,height:60,borderRadius:13,background:'var(--surface2)',border:'2px solid '+(otp.length===k?'var(--accent)':otp[k]?'var(--border-strong)':'var(--border)'),display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'var(--font-mono)',fontSize:24,fontWeight:600}}>{otp[k]||''}</div>)}</div>
   <div style={{display:'flex',gap:10,marginTop:18,flexWrap:'wrap'}}>{[1,2,3,4,5,6,7,8,9,0].map(n=><button key={n} className="btn btn-surface" style={{width:n===0?'100%':'30%',height:46}} onClick={()=>setOtp(o=>(o+n).slice(0,6))}>{n}</button>)}</div>
   <p className="subtle" style={{fontSize:12,marginTop:14}}>Reenviar en <span className="mono">0:30</span> · Cambiar número</p>
  </div>
  <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent btn-lg" disabled={otp.length<6} onClick={()=>go('rdata')}>Verificar</button></div><NI/></div>);
}

function RData({go}){const [dni,setDni]=useState('71234568');const [name,setName]=useState('Khalid Ríos Mendoza');
 const dniOk=/^\d{8}$/.test(dni); const nameOk=name.trim().split(/\s+/).length>=2; const ok=dniOk&&nameOk;
 return(<div className="screen"><Bar/><H t="Tus datos" onBack={()=>go('login',true)}/><RegBar step={1}/>
 <div className="pad scroll" style={{flex:1,marginTop:8}}>
  <p className="muted" style={{fontSize:14,marginBottom:18}}>Como aparecen en tu DNI.</p>
  <div style={{display:'flex',flexDirection:'column',gap:12}}>
   <div><label className="fieldlabel">Nombre completo</label><input className="field" value={name} onChange={e=>setName(e.target.value)} style={{borderColor:name&&!nameOk?'var(--danger)':'var(--border)'}}/>{name&&!nameOk&&<div style={{color:'var(--danger)',fontSize:12,marginTop:6}}>Ingresa nombre y apellido.</div>}</div>
   <div><label className="fieldlabel">DNI</label><input className="field mono" inputMode="numeric" value={dni} onChange={e=>setDni(e.target.value.replace(/\D/g,'').slice(0,8))} style={{borderColor:dni&&!dniOk?'var(--danger)':'var(--border)'}}/>{dni&&!dniOk&&<div style={{color:'var(--danger)',fontSize:12,marginTop:6}}>El DNI debe tener 8 dígitos.</div>}</div>
   <div><label className="fieldlabel">Fecha de nacimiento</label><input className="field mono" defaultValue="14/06/1991"/></div>
  </div>
 </div>
 <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent btn-lg" disabled={!ok} onClick={()=>go('rveh')}>Continuar</button></div><NI/></div>);
}

function RVeh({go}){const [t,setT]=useState('auto');const [placa,setPlaca]=useState('ABC-481');
 const placaOk=/^[A-Z]{3}-?\d{3}$/.test(placa.toUpperCase())||/^[A-Z]-?\d{4}$/.test(placa.toUpperCase());
 return(<div className="screen"><Bar/><H t="Tu vehículo" onBack={go.bind(null,'back')}/><RegBar step={2}/>
  <div className="pad scroll" style={{flex:1,marginTop:8}}>
   <p className="muted" style={{fontSize:14,marginBottom:16}}>Registra tu vehículo de trabajo.</p>
   <div className="seg" style={{marginBottom:16}}><button className={t==='auto'?'on':''} onClick={()=>setT('auto')}>{I.car()} Auto</button><button className={t==='moto'?'on':''} onClick={()=>setT('moto')}>{I.bike()} Moto</button></div>
   <div style={{display:'flex',flexDirection:'column',gap:12}}>
    <div><label className="fieldlabel">Placa</label><input className="field mono" style={{letterSpacing:'.1em',borderColor:placa&&!placaOk?'var(--danger)':'var(--border)'}} value={placa} onChange={e=>setPlaca(e.target.value.toUpperCase().slice(0,7))}/>{placa&&!placaOk&&<div style={{color:'var(--danger)',fontSize:12,marginTop:6}}>Formato de placa inválido (ej. ABC-481).</div>}</div>
    <div style={{display:'flex',gap:12}}><div style={{flex:2}}><label className="fieldlabel">Marca</label><input className="field" defaultValue="Toyota"/></div><div style={{flex:1}}><label className="fieldlabel">Año</label><input className="field mono" defaultValue="2019"/></div></div>
    <div><label className="fieldlabel">Modelo</label><input className="field" defaultValue="Yaris"/></div>
   </div>
  </div>
  <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent btn-lg" disabled={!placaOk} onClick={()=>go('rdoc')}>Continuar</button></div><NI/></div>);
}

const RDoc=({go,back})=>(<div className="screen"><Bar/><H t="Tus documentos" onBack={back}/><RegBar step={3}/>
 <div className="pad scroll" style={{flex:1,marginTop:8}}>
  <p className="muted" style={{fontSize:14,marginBottom:16}}>Sube los 3 documentos para operar.</p>
  <div style={{display:'flex',flexDirection:'column',gap:11}}>
   {[['Licencia de conducir',I.doc,'Vigente','success'],['SOAT',I.shield,'Subido','success'],['Tarjeta de propiedad',I.car,'Pendiente','warn']].map((d,k)=>(<div key={k} className="doc"><div className="leadcircle" style={{color:'var(--accent)'}}>{d[1]()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>{d[0]}</div><div className="subtle" style={{fontSize:12}}>{d[2]==='Pendiente'?'Toca para subir':'Documento cargado'}</div></div><Pill tone={d[3]}>{d[2]}</Pill></div>))}
  </div>
  <div style={{display:'flex',gap:9,alignItems:'center',color:'var(--ink-subtle)',fontSize:12,marginTop:16}}><span>{I.doc()}</span>Formatos: JPG o PDF, máx 8 MB.</div>
 </div>
 <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent btn-lg" onClick={()=>go('rkyc')}>Continuar</button></div><NI/></div>);

const RKyc=({go,back})=>(<div className="screen" style={{background:'#0d1420'}}><Bar/>
 <div className="ph-img" style={{position:'absolute',inset:0}}><span className="lbl" style={{left:'50%',top:14,bottom:'auto',transform:'translateX(-50%)'}}>cámara frontal</span></div>
 <div style={{position:'absolute',inset:0,background:'linear-gradient(180deg,rgba(13,20,32,.7),transparent 24%,transparent 56%,rgba(13,20,32,.95))'}}/>
 <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}><div style={{width:236,height:300,borderRadius:'50% 50% 48% 48%/55% 55% 45% 45%',border:'3px solid var(--accent)',boxShadow:'0 0 40px var(--route-glow)'}}/></div>
 <div className="pad" style={{position:'absolute',top:52,left:0,right:0,zIndex:5,display:'flex',alignItems:'center',gap:10}}><div className="iconbtn" onClick={back} style={{background:'var(--surface)'}}>{I.back()}</div><div style={{flex:1}}><RegBar step={4}/></div></div>
 <div style={{position:'absolute',left:0,right:0,bottom:0,padding:'0 22px 30px',zIndex:5}}>
  <div className="card" style={{padding:'14px 16px',marginBottom:16,textAlign:'center',background:'rgba(35,43,60,.9)'}}><div className="eyebrow" style={{color:'var(--ink-muted)',marginBottom:6}}>VERIFICACIÓN DE IDENTIDAD</div><div style={{fontWeight:700,fontSize:17}}>Sostén tu licencia junto a tu rostro</div></div>
  <div style={{display:'flex',alignItems:'center',gap:8,color:'var(--ink-subtle)',fontSize:12,marginBottom:14}}><span style={{color:'var(--success)'}}>{I.shield()}</span>Motor propio (ONNX). Tus datos no salen a terceros.</div>
  <button className="btn btn-accent btn-lg" onClick={()=>go('review')}>Tomar foto y enviar</button>
 </div><NI/></div>);

const Review=({reset})=>(<div className="screen"><Bar/>
 <div className="pad scroll" style={{paddingTop:70,flex:1,textAlign:'center'}}>
  <WM size={18}/>
  <div className="card" style={{width:140,height:140,borderRadius:24,margin:'30px auto 24px',display:'flex',alignItems:'center',justifyContent:'center',background:'radial-gradient(70% 70% at 50% 35%, rgba(57,188,223,.1), transparent), var(--surface)'}}><div style={{color:'var(--accent)',transform:'scale(2.4)'}}>{I.doc()}</div></div>
  <h1 className="display" style={{fontSize:28}}>Estamos revisando<br/>tus datos</h1>
  <p className="muted" style={{marginTop:10,fontSize:15}}>Te avisaremos cuando esté aprobado.</p>
  <div className="card" style={{marginTop:24,padding:'6px 18px',textAlign:'left'}}>{[['Datos personales',true],['Vehículo',true],['Documentos',true],['Verificación facial','rev']].map((r,k)=>(<div key={k} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 0',borderBottom:k<3?'1px solid var(--border)':'none'}}><span style={{width:26,height:26,borderRadius:'50%',background:r[1]===true?'var(--success)':'var(--surface2)',border:r[1]===true?'none':'2px solid var(--accent)',display:'flex',alignItems:'center',justifyContent:'center',color:r[1]===true?'#06231a':'var(--accent)'}}>{r[1]===true?I.check():''}</span><span style={{flex:1,fontSize:14,fontWeight:500}}>{r[0]}</span><span className="subtle" style={{fontSize:12}}>{r[1]===true?'Listo':'En revisión'}</span></div>))}</div>
 </div>
 <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent" onClick={()=>reset('home')}>Entendido · ver demo aprobada</button></div><NI/></div>);

/* ----- TURNO ----- */
function Gate({go,set,blocked}){
 return(<div className="screen"><Bar/>
  <div className="pad" style={{paddingTop:54,display:'flex',alignItems:'center',gap:12}}><div className="iconbtn" onClick={()=>go('home',true)}>{I.back()}</div><h2 className="display" style={{fontSize:20}}>Iniciar turno</h2></div>
  <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'0 30px',textAlign:'center'}}>
   <div className="radar" style={{width:110,height:110,borderRadius:'50%',background:'var(--surface2)',border:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--accent)',marginBottom:28}}><span style={{transform:'scale(1.6)'}}>{I.shield()}</span></div>
   <h2 className="display" style={{fontSize:24}}>Verificación de identidad</h2>
   <p className="muted" style={{marginTop:10,fontSize:14.5,lineHeight:1.5}}>Por seguridad, debes verificar tu rostro (prueba de vida) antes de iniciar el turno.</p>
   {blocked&&<div className="card" style={{marginTop:22,padding:14,display:'flex',gap:11,alignItems:'flex-start',textAlign:'left',background:'rgba(243,97,100,.1)',borderColor:'rgba(243,97,100,.4)'}}><span style={{color:'var(--danger)',marginTop:1}}>{I.shield()}</span><span style={{fontSize:13,lineHeight:1.45}}><b>Verificación bloqueada.</b> Por seguridad, intenta de nuevo en 1 hora o contacta a la central.</span></div>}
  </div>
  <div className="pad" style={{paddingBottom:32}}>
   {blocked?<button className="btn btn-surface btn-lg" disabled>Bloqueado · 59:32</button>:<button className="btn btn-accent btn-lg" onClick={()=>{set({shift:'available'});go('home',true);}}>Iniciar verificación</button>}
   {!blocked&&<div className="subtle" style={{textAlign:'center',fontSize:12,marginTop:12,cursor:'pointer'}} onClick={()=>go('blocked')}>Simular 3 fallos (demo)</div>}
  </div><NI/></div>);
}

const NavBar=({cur,go})=>(<div className="navbar">{[['home','Inicio',I.home],['earnings','Ganancias',I.money],['trips','Viajes',I.car],['account','Cuenta',I.shield]].map(t=>(<div key={t[0]} className={'t'+(cur===t[0]?' on':'')} onClick={()=>go(t[0],true)}>{t[2]()}<span>{t[1]}</span></div>))}</div>);

function Home({go,data,set}){
 const online=data.shift==='available';
 const [docBlock,setDocBlock]=useState(false);
 const [gps,setGps]=useState(false);
 return(<div className="screen"><Bar/><MapView mode={online?'avail':'idle'} dim={!online} heat={online&&data.heat}/>
  <div className="pad" style={{position:'absolute',top:54,left:0,right:0,zIndex:20,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
   <div style={{display:'flex',alignItems:'center',gap:10}} onClick={()=>go('account',true)}><Avatar size={42}/>{online?<Pill tone="success"><span className="radar dot" style={{background:'var(--success)'}}/>Listo · Buscando</Pill>:<div><div style={{fontWeight:700,fontSize:15}}>Hola, Khalid</div><span className="pill" style={{height:22,padding:'0 9px',fontSize:11}}>Desconectado</span></div>}</div>
   {online&&<div className="pill" style={{background:'var(--surface)',color:data.heat?'var(--accent)':'var(--ink-muted)',cursor:'pointer'}} onClick={()=>set({heat:!data.heat})}>{I.flame()} Zonas</div>}
  </div>
  <div className="bsheet" style={{bottom:84}}>
   <div className="grabber" style={{marginBottom:16}}/>
   {!online?<>
    <div className="seg" style={{marginBottom:16}}><button className="on">{I.car()} Toyota Yaris</button><button>{I.bike()} Moto</button></div>
    {docBlock&&<div className="card" style={{padding:'13px 14px',marginBottom:14,display:'flex',gap:11,alignItems:'flex-start',background:'rgba(243,97,100,.1)',borderColor:'rgba(243,97,100,.4)'}}><span style={{color:'var(--danger)',marginTop:1}}>{I.shield()}</span><div style={{flex:1}}><div style={{fontWeight:700,fontSize:13.5}}>SOAT vencido</div><div className="subtle" style={{fontSize:12,marginTop:2,lineHeight:1.4}}>No puedes conectarte hasta actualizar tu SOAT.</div><div className="btn btn-surface btn-sm" style={{marginTop:10}} onClick={()=>go('documents')}>Actualizar documento</div></div></div>}
    <div style={{display:'flex',gap:12,marginBottom:16}}><div className="card" style={{flex:1,padding:14}}><div className="subtle" style={{fontSize:12}}>Neto total</div><div className="mono" style={{fontSize:22,fontWeight:700,marginTop:2}}>S/ 248.50</div></div><div className="card" style={{flex:1,padding:14}}><div className="subtle" style={{fontSize:12}}>Por liquidar</div><div className="mono" style={{fontSize:22,fontWeight:700,marginTop:2,color:'var(--warn)'}}>S/ 62.00</div></div></div>
    {docBlock?<button className="btn btn-lg" style={{background:'var(--surface2)',color:'var(--ink-subtle)',border:'1px solid var(--border)'}} disabled>{I.power()} Conexión bloqueada</button>:<button className="btn btn-accent btn-lg" onClick={()=>go('gate')}>{I.power()} Conéctate</button>}
    <div className="subtle" style={{textAlign:'center',fontSize:11.5,marginTop:10,cursor:'pointer'}} onClick={()=>setDocBlock(v=>!v)}>{docBlock?'Quitar bloqueo (demo)':'Simular documento vencido (demo)'}</div>
   </>:<>
    <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}><div className="radar" style={{width:46,height:46,borderRadius:'50%',background:'rgba(57,191,137,.14)',border:'1px solid rgba(57,191,137,.4)',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--success)',flex:'none'}}>{I.check()}</div><div><div style={{fontWeight:700,fontSize:16}}>Listo para recibir viajes</div><div className="subtle" style={{fontSize:13}}>Mantente en zona de alta demanda.</div></div></div>
    <div style={{display:'flex',gap:12,marginBottom:14}}><div className="card" style={{flex:1,padding:14}}><div className="subtle" style={{fontSize:12}}>Hoy</div><div className="mono" style={{fontSize:22,fontWeight:700,marginTop:2}}>S/ 84.00</div></div><div className="card" style={{flex:1,padding:14}}><div className="subtle" style={{fontSize:12}}>Viajes</div><div className="mono" style={{fontSize:22,fontWeight:700,marginTop:2}}>6</div></div></div>
    <button className="btn btn-accent btn-sm" style={{marginBottom:10}} onClick={()=>go('incoming')}>Recibir oferta entrante (demo)</button>
    {gps&&<div className="card" style={{padding:'11px 14px',marginBottom:10,display:'flex',alignItems:'center',gap:10,background:'rgba(243,97,100,.1)',borderColor:'rgba(243,97,100,.4)'}}><span style={{color:'var(--danger)'}}>{I.shield()}</span><span style={{fontSize:12.5,flex:1}}>Se perdió el GPS. No recibirás viajes hasta recuperar la señal.</span></div>}
    <div className="card" style={{padding:'11px 14px',marginBottom:10,display:'flex',alignItems:'center',gap:10,background:'var(--surface2)'}}><span className="radar dot" style={{background:gps?'var(--danger)':'var(--ink-muted)'}}/><span className="subtle" style={{fontSize:12,flex:1}}>{gps?'Reconectando GPS…':'Sin solicitudes ahora · acércate a una zona de alta demanda'}</span></div>
    <div style={{display:'flex',gap:12,marginBottom:8}}><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>go('multioffers')}>Ver varias ofertas (demo)</button><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>setGps(v=>!v)}>{gps?'Recuperar GPS':'Simular perder GPS'}</button></div>
    <div style={{display:'flex',gap:12}}><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>set({shift:'break'})}>Pausar</button><button className="btn btn-ghost btn-sm" style={{flex:1}} onClick={()=>data.tripPhase?notify('Termina tu viaje actual antes de desconectarte'):set({shift:'offline'})}>Desconectarse</button></div>
   </>}
  </div>
  <NavBar cur="home" go={go}/></div>);
}

function Incoming({go,data,set,notify}){const [sec,setSec]=useState(12);const [taken,setTaken]=useState(false);
 useEffect(()=>{const iv=setInterval(()=>setSec(s=>s>0?s-1:0),1000);return()=>clearInterval(iv);},[]);
 const expired=sec===0;
 return(<div className="screen"><Bar/><MapView mode="route" dim/>
  <div className="pad" style={{position:'absolute',top:54,left:0,right:0,zIndex:20,display:'flex',justifyContent:'center'}}><Pill tone={expired?'danger':'warn'}>{expired?'Oferta expirada':`Vence en ${sec} s`}</Pill></div>
  <div className="bsheet" style={{maxHeight:'76%'}}>
   <div className="grabber" style={{marginBottom:14}}/>
   <div style={{display:'flex',alignItems:'center',gap:14,marginBottom:14}}><div style={{position:'relative',width:60,height:60}}><svg width="60" height="60" viewBox="0 0 60 60"><circle cx="30" cy="30" r="26" fill="none" stroke="var(--surface3)" strokeWidth="5"/><circle cx="30" cy="30" r="26" fill="none" stroke={expired?'var(--danger)':'var(--accent)'} strokeWidth="5" strokeLinecap="round" strokeDasharray="163" strokeDashoffset={163-(163*sec/12)} transform="rotate(-90 30 30)"/></svg><span className="mono" style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:18,fontWeight:700}}>{sec}</span></div><div style={{flex:1}}><div className="display" style={{fontSize:20}}>Nuevo viaje</div><div className="subtle" style={{fontSize:13}}>El pasajero ofrece esta tarifa</div></div></div>
   <div style={{textAlign:'center',marginBottom:14}}><div className="subtle" style={{fontSize:12,marginBottom:2}}>Tarifa ofrecida</div><div className="display mono" style={{fontSize:44,fontWeight:600,color:'var(--accent)'}}>S/ {data.offer}.00</div></div>
   <div className="card" style={{padding:'12px 16px',marginBottom:14,background:'var(--surface2)'}}><div style={{display:'flex',alignItems:'center',gap:12,padding:'6px 0'}}><span style={{width:10,height:10,borderRadius:'50%',border:'2px solid var(--accent)'}}/><span style={{fontSize:14}}>Recojo · 1.2 km de ti</span></div><div style={{height:1,background:'var(--border)',margin:'2px 0 2px 4px'}}/><div style={{display:'flex',alignItems:'center',gap:12,padding:'6px 0'}}><span style={{color:'var(--accent)'}}>{I.pin()}</span><span style={{fontSize:14}}>Destino · Surco</span><span className="subtle mono" style={{marginLeft:'auto',fontSize:13}}>9.2 km · 22 min</span></div></div>
   {taken&&<div className="card" style={{padding:'12px 14px',marginBottom:12,display:'flex',gap:10,alignItems:'center',background:'rgba(242,175,72,.1)',borderColor:'rgba(242,175,72,.4)'}}><span style={{color:'var(--warn)'}}>{I.shield()}</span><span style={{fontSize:13,flex:1}}>El pasajero ya eligió a otro conductor.</span></div>}
   {taken?<button className="btn btn-surface btn-lg" onClick={()=>{set({shift:'available'});go('home',true);}}>Volver a disponible</button>
   :!expired?<><div style={{display:'flex',gap:10,marginBottom:10}}><button className="btn btn-surface btn-lg" style={{flex:'0 0 120px'}} onClick={()=>{set({shift:'available'});go('home',true);}}>Rechazar</button><button className="btn btn-accent btn-lg" style={{flex:1}} onClick={()=>{set({tripPhase:'accepted'});go('active');}}>Aceptar · S/ {data.offer}</button></div>
   <div style={{display:'flex',gap:10}}><button className="btn btn-ghost btn-sm" style={{flex:1}} onClick={()=>go('counter')}>Contraofertar</button><button className="btn btn-ghost btn-sm" style={{flex:1,color:'var(--ink-subtle)'}} onClick={()=>setTaken(true)}>Demo: ya la tomaron</button></div></>
   :<button className="btn btn-surface btn-lg" onClick={()=>{set({shift:'available'});go('home',true);}}>Volver a disponible</button>}
  </div><NI/></div>);
}

function Counter({go,data,set}){const [p,setP]=useState(data.offer+3);
 return(<div className="screen"><Bar/><MapView mode="route" dim/>
  <div className="bsheet" style={{maxHeight:'62%'}}>
   <div className="grabber" style={{marginBottom:14}}/>
   <div className="display" style={{fontSize:20,marginBottom:4}}>Contraoferta</div>
   <p className="subtle" style={{fontSize:13,marginBottom:16}}>El pasajero ofreció <span className="mono" style={{color:'var(--ink-muted)'}}>S/ {data.offer}.00</span>. Propón tu precio.</p>
   <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:22,margin:'4px 0 8px'}}><div className="iconbtn" style={{width:50,height:50,borderRadius:15}} onClick={()=>setP(v=>Math.max(data.offer,v-1))}>{I.minus()}</div><div className="display mono" style={{fontSize:46,fontWeight:600,minWidth:150,textAlign:'center'}}>S/ {p}</div><div className="iconbtn" style={{width:50,height:50,borderRadius:15,background:'var(--accent)',color:'var(--on-accent)',border:'none'}} onClick={()=>setP(v=>v+1)}>{I.plus()}</div></div>
   <p className="subtle" style={{textAlign:'center',fontSize:12,marginBottom:16}}>El pasajero podrá aceptar o seguir buscando.</p>
   <button className="btn btn-accent btn-lg" onClick={()=>{set({counter:p});go('waiting');}}>Enviar contraoferta · S/ {p}</button>
   <button className="btn btn-ghost btn-sm" style={{marginTop:6}} onClick={()=>go('incoming',true)}>Volver</button>
  </div><NI/></div>);
}

function Waiting({go,data,set}){
 useEffect(()=>{const t=setTimeout(()=>{set({offer:data.counter,tripPhase:'accepted'});go('active',true);},2400);return()=>clearTimeout(t);},[]);
 return(<div className="screen"><Bar/><MapView mode="route" dim/>
  <div className="bsheet" style={{textAlign:'center',paddingTop:24,paddingBottom:34}}>
   <div className="grabber" style={{marginBottom:20}}/>
   <div className="radar" style={{width:64,height:64,borderRadius:'50%',background:'var(--surface2)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 18px',color:'var(--accent)'}}>{I.money()}</div>
   <div className="display" style={{fontSize:20}}>Esperando al pasajero…</div>
   <p className="subtle" style={{fontSize:13,marginTop:8}}>Enviaste <span className="mono" style={{color:'var(--ink)'}}>S/ {data.counter}.00</span>. Puede aceptar o seguir buscando otra oferta.</p>
   <button className="btn btn-ghost btn-sm" style={{marginTop:18}} onClick={()=>{set({shift:'available'});go('home',true);}}>Cancelar</button>
  </div><NI/></div>);
}

function Active({go,reset,data,set,notify}){
 const phase=data.tripPhase;
 const [wait,setWait]=useState(300);
 const [confirm,setConfirm]=useState(false);
 const [amend,setAmend]=useState(null); // null | 'pending' | 'accepted' | 'rejected'
 const [amendKind,setAmendKind]=useState('dest');
 useEffect(()=>{if(phase!=='arrived')return;const iv=setInterval(()=>setWait(w=>w>0?w-1:0),1000);return()=>clearInterval(iv);},[phase]);
 const mmss=`${Math.floor(wait/60)}:${String(wait%60).padStart(2,'0')}`;
 const carT={accepted:0.2,arriving:0.35,arrived:0.5,inprogress:0.75}[phase]||0.2;
 const main={accepted:['Voy en camino','arriving','btn-accent'],arriving:['Llegué al punto','arrived','btn-accent'],arrived:['Iniciar viaje','inprogress','btn-success'],inprogress:['Completar viaje','done','btn-success']}[phase];
 const label={accepted:'En camino al recojo',arriving:'Llegando al recojo',arrived:'Esperando al pasajero',inprogress:'En viaje'}[phase];
 const inTrip=phase==='inprogress';
 return(<div className="screen"><Bar/>
  <div style={{position:'relative',height:'40%'}}><MapView mode="trip" carT={carT}/>
   <div className="pad" style={{position:'absolute',top:54,left:0,right:0,display:'flex',justifyContent:'space-between',zIndex:10}}><div className="iconbtn" onClick={()=>go('chat')} style={{background:'var(--surface)'}}>{I.chat()}</div><Pill tone="success">EN VIVO</Pill></div>
   <div style={{position:'absolute',left:22,right:22,bottom:14}}><div className="card" style={{padding:'12px 16px',display:'flex',alignItems:'center',gap:12,background:'rgba(26,34,48,.95)'}}><div style={{color:'var(--accent)'}}>{I.navi()}</div><div style={{flex:1}}><div style={{fontWeight:700,fontSize:15}}>Gira a la derecha en Av. Primavera</div><div className="subtle" style={{fontSize:12}}>en 300 m</div></div><div className="btn btn-accent btn-sm" style={{width:'auto',padding:'0 12px'}} onClick={()=>notify('Abriendo en Waze / Google Maps…')}>{I.navi()} Navegar</div></div></div>
  </div>
  <div style={{flex:1,padding:'14px 22px 26px',display:'flex',flexDirection:'column',overflow:'hidden'}}>
   <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:12}}><Avatar size={46} label="MF"/><div style={{flex:1}}><div style={{fontWeight:700,fontSize:16}}>{inTrip?'María Fernanda':'Pasajero'}</div><div className="subtle" style={{fontSize:13}}>{label}</div></div><span className="mono" style={{fontWeight:700,fontSize:17}}>S/ {data.offer}.00</span></div>
   {!inTrip&&<div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:12}}><span className="subtle" style={{fontSize:12,width:'100%',marginBottom:2}}>Solicitudes del pasajero:</span><span className="pill" style={{height:30}}>{I.shield()} Mascota</span><span className="pill" style={{height:30}}>Equipaje</span></div>}
   {phase==='arrived'&&<div className="card" style={{padding:'12px 16px',marginBottom:12,display:'flex',alignItems:'center',gap:12,background:'var(--surface2)'}}><div style={{color:wait>0?'var(--accent)':'var(--danger)'}}>{I.life()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>Espera gratis</div><div className="subtle" style={{fontSize:12}}>{wait>0?'Tiempo restante de cortesía':'Tiempo agotado · puede aplicar cargo'}</div></div><span className="mono" style={{fontWeight:700,fontSize:20,color:wait>0?'var(--ink)':'var(--danger)'}}>{mmss}</span></div>}
   {inTrip&&<div className="card" style={{padding:'10px 14px',marginBottom:12,display:'flex',alignItems:'center',gap:10,background:'var(--surface2)'}}><span style={{color:'var(--ink-muted)'}}>{I.cam()}</span><span className="subtle" style={{fontSize:12,flex:1}}>Cámara de cabina transmitiendo</span><span className="dot" style={{background:'var(--accent)'}}/></div>}
   {inTrip&&<div className="card" style={{padding:'10px 14px',marginBottom:12,display:'flex',alignItems:'center',gap:10,background:'rgba(242,175,72,.08)',borderColor:'rgba(242,175,72,.35)'}}><span style={{color:'var(--warn)'}}>{I.shield()}</span><span className="subtle" style={{fontSize:12,flex:1}}>1 solicitud en espera · no puedes aceptar otra hasta terminar este viaje.</span></div>}
   {inTrip&&amend==='pending'&&<div className="card" style={{padding:'14px 16px',marginBottom:12,background:'rgba(57,188,223,.08)',borderColor:'rgba(57,188,223,.4)'}}><div style={{display:'flex',alignItems:'center',gap:9,marginBottom:6}}><span style={{color:'var(--accent)'}}>{I.navi()}</span><span style={{fontWeight:700,fontSize:14}}>{amendKind==='stop'?'El pasajero agregó una parada':'El pasajero cambió el destino'}</span></div><div className="subtle" style={{fontSize:12.5,marginBottom:10,lineHeight:1.45}}>{amendKind==='stop'?<>Parada: <b style={{color:'var(--ink)'}}>Óvalo Gutiérrez</b> · +6 min · tarifa <b style={{color:'var(--ink)'}}>S/ {data.offer} → S/ {data.offer+3}</b></>:<>Nuevo destino: <b style={{color:'var(--ink)'}}>Larcomar</b> · +4.1 km · tarifa <b style={{color:'var(--ink)'}}>S/ {data.offer} → S/ {data.offer+5}</b></>}</div><div style={{display:'flex',gap:10}}><button className="btn btn-success btn-sm" style={{flex:1}} onClick={()=>{set({offer:data.offer+(amendKind==='stop'?3:5)});setAmend('accepted');notify(amendKind==='stop'?'Parada aceptada · navegación actualizada':'Nueva ruta aceptada · navegación actualizada');}}>Aceptar</button><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>{setAmend('rejected');notify('Mantienes la ruta original');}}>Rechazar</button></div></div>}
   {inTrip&&amend==='rejected'&&<div className="subtle" style={{fontSize:12,marginBottom:10,display:'flex',gap:7,alignItems:'flex-start'}}><span style={{marginTop:1,color:'var(--warn)'}}>{I.shield()}</span>Rechazaste el cambio. Sigues a la ruta original; el pasajero fue notificado.</div>}
   <div style={{flex:1}}/>
   {phase==='arrived'&&wait===0&&<div style={{display:'flex',gap:10,marginBottom:8}}><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>notify('Cargo por espera aplicado')}>Cobrar espera</button><button className="btn btn-surface btn-sm" style={{flex:1,color:'var(--danger)'}} onClick={()=>{notify('No-show reportado · sin penalidad para ti');go('cancel');}}>Reportar no-show</button></div>}
   {inTrip&&!amend&&<div style={{display:'flex',gap:8,marginBottom:8}}><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>{setAmendKind('dest');setAmend('pending');}}>Demo: cambia destino</button><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>{setAmendKind('stop');setAmend('pending');}}>Demo: agrega parada</button></div>}
   <button className={'btn btn-lg '+main[2]} onClick={()=>{if(main[1]==='done'){set({tripPhase:null,shift:'available'});go('rated',true);}else set({tripPhase:main[1]});}}>{main[0]}</button>
   {!inTrip&&<button className="btn btn-ghost btn-sm" style={{marginTop:6}} onClick={()=>setConfirm(true)}>Cancelar viaje</button>}
  </div>
  {confirm&&<div style={{position:'absolute',inset:0,background:'var(--overlay)',display:'flex',alignItems:'flex-end',zIndex:40}} onClick={()=>setConfirm(false)}><div className="bsheet" style={{paddingTop:18}} onClick={e=>e.stopPropagation()}><div className="grabber" style={{marginBottom:16}}/><div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}><span style={{color:'var(--danger)'}}>{I.alert?I.alert():I.shield()}</span><h3 className="display" style={{fontSize:20}}>¿Cancelar el viaje?</h3></div><p className="muted" style={{fontSize:13.5,lineHeight:1.5,marginBottom:18}}>Cancelar tras aceptar afecta tu tasa de aceptación. Las cancelaciones, no-presentaciones o demoras frecuentes pueden <b style={{color:'var(--ink)'}}>bloquear tu cuenta</b>.</p><button className="btn btn-danger btn-lg" onClick={()=>{setConfirm(false);go('cancel');}}>Sí, cancelar</button><button className="btn btn-ghost btn-sm" style={{marginTop:6}} onClick={()=>setConfirm(false)}>Seguir con el viaje</button></div></div>}
  <NI/></div>);
}

const Rated=({reset,notify})=>(<div className="screen"><Bar/>
 <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'0 34px',textAlign:'center'}}>
  <div style={{width:84,height:84,borderRadius:'50%',background:'rgba(57,191,137,.14)',border:'1px solid rgba(57,191,137,.4)',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--success)',marginBottom:22}}><span style={{transform:'scale(1.3)'}}>{I.check()}</span></div>
  <h1 className="display" style={{fontSize:28}}>Viaje completado</h1>
  <p className="muted" style={{marginTop:10,fontSize:15}}>Tarifa <b className="mono" style={{color:'var(--ink)'}}>S/ 13.00</b> · comisión VEO <span className="mono">−S/ 1.20</span> · ganaste <b className="mono" style={{color:'var(--success)'}}>S/ 11.80</b>.</p>
  <div style={{display:'flex',justifyContent:'center',gap:10,margin:'22px 0',color:'var(--warn)'}}>{[1,2,3,4,5].map(n=><span key={n} style={{transform:'scale(1.5)',color:n<=5?'var(--warn)':'var(--border-strong)'}}>{I.star(n<=5)}</span>)}</div>
  <p className="subtle" style={{fontSize:13}}>Califica a tu pasajero</p>
 </div>
 <div className="pad" style={{paddingBottom:32}}><button className="btn btn-success btn-lg" onClick={()=>reset('home')}>Enviar y volver al inicio</button><button className="btn btn-ghost btn-sm" style={{marginTop:6}} onClick={()=>notify&&notify('Reporte enviado a Seguridad VEO')}>Reportar al pasajero</button></div><NI/></div>);

const Cancel=({reset})=>(<div className="screen"><Bar/>
 <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'0 30px',textAlign:'center'}}>
  <div style={{width:88,height:88,borderRadius:'50%',background:'rgba(243,97,100,.12)',border:'1px solid rgba(243,97,100,.4)',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--danger)',marginBottom:24}}>{I.x()}</div>
  <h1 className="display" style={{fontSize:28}}>Viaje cancelado</h1>
  <p className="muted" style={{marginTop:10,fontSize:15}}>Este viaje fue cancelado. Vuelve a conectarte para recibir nuevos viajes.</p>
 </div>
 <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent btn-lg" onClick={()=>reset('home')}>Ir al inicio</button></div><NI/></div>);

function Chat({back}){const [msgs,setMsgs]=useState([{me:true,t:'Estoy llegando, voy en el Yaris plomo'},{me:false,t:'Gracias, te espero en la puerta'}]);
 return(<div className="screen"><Bar/>
  <div className="pad" style={{paddingTop:54,paddingBottom:14,display:'flex',alignItems:'center',gap:12,borderBottom:'1px solid var(--border)'}}><div className="iconbtn" onClick={back}>{I.back()}</div><Avatar size={38} label="MF"/><div><div style={{fontWeight:600,fontSize:15}}>María Fernanda</div><div className="subtle" style={{fontSize:12}}>Pasajero</div></div></div>
  <div className="pad scroll" style={{flex:1,paddingTop:18,display:'flex',flexDirection:'column',gap:10}}>{msgs.map((m,k)=>(<div key={k} style={{alignSelf:m.me?'flex-end':'flex-start',maxWidth:'78%',padding:'11px 15px',borderRadius:18,fontSize:14.5,background:m.me?'var(--accent)':'var(--surface2)',color:m.me?'var(--on-accent)':'var(--ink)',borderBottomRightRadius:m.me?5:18,borderBottomLeftRadius:m.me?18:5}}>{m.t}</div>))}</div>
  <div className="pad" style={{paddingBottom:30}}><div style={{display:'flex',gap:8,marginBottom:10}}>{['Estoy llegando','Llegué','Te espero'].map(q=><button key={q} className="pill" style={{cursor:'pointer'}} onClick={()=>setMsgs(m=>[...m,{me:true,t:q}])}>{q}</button>)}</div><div style={{display:'flex',gap:10}}><div className="field subtle" style={{flex:1}}>Escribe un mensaje…</div><div className="iconbtn" style={{width:52,height:52,background:'var(--accent)',color:'var(--on-accent)',fontSize:20,fontWeight:700}}>↑</div></div></div><NI/></div>);
}

/* ----- GANANCIAS ----- */
function MultiOffers({go,set,notify}){
 const offers=[{n:'a4f29b1c',p:18,d:'1.2 km',eta:'4 min',dest:'Surco',rt:'4.9'},{n:'7e10c3da',p:24,d:'0.8 km',eta:'3 min',dest:'San Isidro',rt:'4.7'},{n:'b81f4427',p:13,d:'2.1 km',eta:'6 min',dest:'Centro',rt:'4.5'}];
 const [sec,setSec]=useState(15);
 useEffect(()=>{const iv=setInterval(()=>setSec(s=>s>0?s-1:0),1000);return()=>clearInterval(iv);},[]);
 return(<div className="screen"><Bar/><MapView mode="route" dim/>
  <div className="pad" style={{position:'absolute',top:54,left:0,right:0,zIndex:20,display:'flex',alignItems:'center',gap:10}}><div className="iconbtn" onClick={()=>{set({shift:'available'});go('home',true);}} style={{background:'var(--surface)'}}>{I.back()}</div><Pill tone={sec>5?'warn':'danger'}>Vence en {sec} s</Pill></div>
  <div className="bsheet" style={{maxHeight:'78%'}}>
   <div className="grabber" style={{marginBottom:14}}/>
   <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}><h3 className="display" style={{fontSize:19}}>{offers.length} solicitudes cerca</h3><span className="subtle" style={{fontSize:12}}>Elige la que más te convenga</span></div>
   <p className="subtle" style={{fontSize:12.5,marginBottom:12}}>Ordenadas por tarifa · sin penalidad si rechazas.</p>
   <div style={{display:'flex',flexDirection:'column',gap:10}}>{offers.map((o,k)=>(<div key={k} className="card" style={{padding:13,display:'flex',gap:12,alignItems:'center',borderColor:k===0?'rgba(57,188,223,.4)':'var(--border)'}}>
    <div style={{textAlign:'center',flex:'none',minWidth:64}}><div className="mono" style={{fontWeight:700,fontSize:19,color:k===0?'var(--accent)':'var(--ink)'}}>S/ {o.p}</div><div className="subtle" style={{fontSize:10.5}}>{o.dest}</div></div>
    <div style={{flex:1,minWidth:0}}><div style={{fontSize:12.5,fontWeight:600}}>Recojo a {o.d}</div><div className="subtle" style={{fontSize:11.5,marginTop:2}}>Pasajero ★ {o.rt} · llega en {o.eta}</div></div>
    <button className="btn-accent" style={{border:'none',borderRadius:9,padding:'9px 14px',fontWeight:700,fontSize:13,cursor:'pointer',color:'var(--on-accent)'}} onClick={()=>{set({offer:o.p,tripPhase:'accepted'});go('active');}}>Aceptar</button>
   </div>))}</div>
   <button className="btn btn-ghost btn-sm" style={{marginTop:12}} onClick={()=>{set({shift:'available'});go('home',true);}}>Rechazar todas</button>
  </div><NI/></div>);
}

function Withdraw({back,notify}){const [amt,setAmt]=useState(86.5);const [done,setDone]=useState(false);const [verified,setVerified]=useState(true);
 const tooLow=amt<20;
 if(done)return(<div className="screen"><Bar/><div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'0 34px',textAlign:'center'}}><div style={{width:84,height:84,borderRadius:'50%',background:'rgba(57,191,137,.14)',border:'1px solid rgba(57,191,137,.4)',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--success)',marginBottom:22}}><span style={{transform:'scale(1.3)'}}>{I.check()}</span></div><h1 className="display" style={{fontSize:26}}>Retiro en camino</h1><p className="muted" style={{marginTop:10,fontSize:15,lineHeight:1.5}}>S/ {amt.toFixed(2)} llegarán a tu cuenta <span className="mono">BCP ****1234</span> en 24-48 h.</p></div><div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent btn-lg" onClick={back}>Listo</button></div><NI/></div>);
 return(<div className="screen"><Bar/><H t="Retirar ganancias" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <div className="card" style={{padding:'18px',textAlign:'center',marginBottom:16,background:'radial-gradient(80% 90% at 50% 0%, rgba(57,188,223,.08), transparent), var(--surface)'}}><div className="subtle" style={{fontSize:13}}>Disponible para retiro</div><div className="display mono" style={{fontSize:36,fontWeight:600,marginTop:4}}>S/ 86.50</div></div>
   <label className="fieldlabel">Cuenta destino</label>
   <div className="card" style={{padding:'14px 16px',display:'flex',alignItems:'center',gap:12,marginBottom:14}}><div className="leadcircle" style={{color:verified?'var(--accent)':'var(--warn)'}}>{I.money()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>BCP · Cuenta de ahorros</div><div className="subtle mono" style={{fontSize:12}}>****1234 {verified?'':'· sin verificar'}</div></div><span className="subtle">{I.chevR()}</span></div>
   {!verified&&<div className="card" style={{padding:'12px 14px',marginBottom:14,display:'flex',gap:10,alignItems:'flex-start',background:'rgba(242,175,72,.1)',borderColor:'rgba(242,175,72,.4)'}}><span style={{color:'var(--warn)',marginTop:1}}>{I.shield()}</span><span style={{fontSize:12.5,lineHeight:1.45}}>Tu cuenta bancaria aún no está verificada. Verifícala para poder retirar.</span></div>}
   <label className="fieldlabel">Monto a retirar</label>
   <div className="seg">{[43.25,86.5].map(v=><button key={v} className={amt===v?'on':''} onClick={()=>setAmt(v)}>{v===86.5?'Todo · S/ 86.50':'Mitad · S/ 43.25'}</button>)}</div>
   {tooLow&&<div style={{color:'var(--danger)',fontSize:12,marginTop:8}}>El monto mínimo de retiro es S/ 20.00.</div>}
   <div className="subtle" style={{fontSize:12,marginTop:12,display:'flex',gap:7,alignItems:'flex-start'}}><span style={{marginTop:1}}>{I.shield()}</span>Retiros sin comisión una vez por semana. Transferencia en 24-48 h hábiles.</div>
   <div className="subtle" style={{textAlign:'center',fontSize:11.5,marginTop:12,cursor:'pointer'}} onClick={()=>setVerified(v=>!v)}>{verified?'Simular cuenta no verificada (demo)':'Marcar cuenta verificada (demo)'}</div>
  </div>
  <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent btn-lg" disabled={!verified||tooLow} onClick={()=>setDone(true)}>{!verified?'Verifica tu cuenta':tooLow?'Monto mínimo S/ 20':`Retirar S/ ${amt.toFixed(2)}`}</button></div><NI/></div>);
}

function Earnings({go}){const [tab,setTab]=useState('res');const [load,setLoad]=useState(true);
 useEffect(()=>{const t=setTimeout(()=>setLoad(false),900);return()=>clearTimeout(t);},[]);
 return(<div className="screen"><Bar/><H t="Ganancias"/>
  <div className="pad scroll" style={{flex:1,paddingBottom:96}}>
   <div className="seg" style={{marginBottom:16}}><button className={tab==='res'?'on':''} onClick={()=>setTab('res')}>Resumen</button><button className={tab==='des'?'on':''} onClick={()=>setTab('des')}>Desglose</button></div>
   {load?<><Skel h={150} r={18}/><Skel h={16} w="40%" mt={20}/><Skel h={58} r={14} mt={12}/><Skel h={58} r={14} mt={10}/></>:tab==='res'?<>
    <div className="card" style={{padding:20,textAlign:'center',marginBottom:14,background:'radial-gradient(80% 90% at 50% 0%, rgba(57,188,223,.08), transparent), var(--surface)'}}><div className="subtle" style={{fontSize:13}}>Neto total</div><div className="display mono" style={{fontSize:40,fontWeight:600,marginTop:4}}>S/ 248.50</div><div style={{display:'flex',gap:10,marginTop:14}}>{[['32','Viajes'],['S/ 62','Por liquidar'],['4.97','Rating']].map((s,k)=><div key={k} style={{flex:1}}><div className="mono" style={{fontWeight:700,fontSize:16,color:k===1?'var(--warn)':'var(--ink)'}}>{s[0]}</div><div className="subtle" style={{fontSize:11}}>{s[1]}</div></div>)}</div></div>
    <div className="fieldlabel" style={{textTransform:'uppercase',letterSpacing:'.1em',fontSize:11}}>Liquidaciones</div>
    <div className="card" style={{padding:'2px 16px'}}>{[['Semana 22','Pagado','142.00','success'],['Semana 23','En proceso','86.50','accent']].map((p,k)=>(<div key={k} className="listrow" style={{cursor:'default'}}><div className="leadcircle" style={{color:'var(--accent)'}}>{I.money()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>{p[0]}</div><div className="subtle" style={{fontSize:12}}>{p[1]}</div></div><span className="mono" style={{fontWeight:700}}>S/ {p[2]}</span></div>))}</div>
    <button className="btn btn-surface btn-sm" style={{marginTop:14}} onClick={()=>go('withdraw')}>Retirar a mi cuenta</button>
   </>:<>
    {[['Hoy','S/ 84.00','6 viajes'],['Esta semana','S/ 312.00','24 viajes']].map((b,k)=>(<div key={k} className="card" style={{padding:18,marginBottom:12}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><div style={{fontWeight:700,fontSize:15}}>{b[0]}</div><div className="mono" style={{fontWeight:700,fontSize:20}}>{b[1]}</div></div><div className="subtle" style={{fontSize:12,marginTop:4}}>{b[2]}</div><div style={{height:1,background:'var(--border)',margin:'12px 0'}}/>{[['Tarifas','S/ 96.00'],['Comisión VEO','- S/ 14.40'],['Incentivos','+ S/ 2.40']].map((r,j)=><div key={j} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',fontSize:13}}><span className="muted">{r[0]}</span><span className="mono">{r[1]}</span></div>)}</div>))}
   </>}
  </div><NavBar cur="earnings" go={go}/></div>);
}

/* ----- VIAJES ----- */
function Trips({go}){const [tab,setTab]=useState('all');const [st,setSt]=useState('load');
 useEffect(()=>{const t=setTimeout(()=>setSt('ok'),900);return()=>clearTimeout(t);},[]);
 const all=[['Jockey Plaza, Surco','Hoy · 9:42','13.00','Completado','success'],['Aeropuerto J. Chávez','Ayer · 18:15','22.50','Completado','success'],['Parque Kennedy','12 may · 8:30','—','Cancelado','danger'],['San Miguel','11 may · 14:02','16.00','Completado','success']];
 const list=all.filter(r=>tab==='all'||(tab==='done'&&r[4]==='success')||(tab==='cancel'&&r[4]==='danger'));
 return(<div className="screen"><Bar/><H t="Viajes"/>
  <div className="pad" style={{marginBottom:8}}><div className="seg">{[['all','Todos'],['done','Completados'],['cancel','Cancelados']].map(t=><button key={t[0]} className={tab===t[0]?'on':''} onClick={()=>setTab(t[0])}>{t[1]}</button>)}</div></div>
  {st==='load'?<div className="pad" style={{flex:1}}>{[1,2,3].map(k=><div key={k} style={{marginBottom:10}}><Skel h={70} r={16}/></div>)}</div>
  :st==='err'?<StateView icon={I.alert} title="No pudimos cargar" sub="Revisa tu conexión e intenta de nuevo." cta="Reintentar" onCta={()=>setSt('ok')}/>
  :list.length===0?<StateView icon={I.car} title="Sin viajes" sub="No hay viajes en esta vista todavía."/>
  :<div className="pad scroll" style={{flex:1,paddingBottom:96}}>{list.map((t,k)=>(<div key={k} className="card" style={{padding:16,marginBottom:10,display:'flex',alignItems:'center',gap:14,cursor:'pointer'}} onClick={()=>go('tripdetail')}><div className="leadcircle" style={{color:t[4]==='success'?'var(--accent)':'var(--danger)'}}>{I.pin()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>{t[0]}</div><div className="subtle" style={{fontSize:12}}>{t[1]} · {t[3]}</div></div><div style={{textAlign:'right'}}><div className="mono" style={{fontWeight:700,fontSize:15}}>{t[2]==='—'?'—':'S/ '+t[2]}</div><span className="subtle">{I.chevR()}</span></div></div>))}</div>}
  <NavBar cur="trips" go={go}/></div>);
}

const TripDetail=({back})=>(<div className="screen"><Bar/>
 <div style={{position:'relative',height:260}}><MapView mode="route"/><div className="pad" style={{position:'absolute',top:54,zIndex:20}}><div className="iconbtn" onClick={back} style={{background:'var(--surface)'}}>{I.back()}</div></div></div>
 <div className="pad scroll" style={{flex:1,paddingTop:18}}>
  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}><h2 className="display" style={{fontSize:21}}>Viaje a Jockey Plaza</h2><Pill tone="success">Completado</Pill></div>
  <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}><Avatar size={44} label="MF"/><div style={{flex:1}}><div style={{fontWeight:700,fontSize:15}}>María Fernanda</div><div className="subtle" style={{fontSize:12}}>Hoy · 9:42 a. m.</div></div><span style={{color:'var(--warn)',display:'flex',gap:3,alignItems:'center',fontSize:13}}>{I.star(1)}5.0</span></div>
  <div className="card" style={{padding:16,marginBottom:14}}>{[['Tarifa','S/ 13.00'],['Comisión VEO','- S/ 1.95'],['Tu ganancia','S/ 11.05']].map((r,k)=><div key={k} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',fontWeight:k===2?700:400}}><span className={k===2?'':'muted'}>{r[0]}</span><span className="mono">{r[1]}</span></div>)}</div>
  <button className="btn btn-surface btn-sm">Reportar un problema</button>
 </div><NI/></div>);

/* ----- CUENTA ----- */
const Row=({icon,title,sub,pill,pillTone,danger,onClick})=>(<div className="listrow" onClick={onClick}><div className="leadcircle" style={{color:danger?'var(--danger)':'var(--accent)'}}>{icon()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15,color:danger?'var(--danger)':'var(--ink)'}}>{title}</div>{sub&&<div className="subtle" style={{fontSize:12}}>{sub}</div>}</div>{pill?<Pill tone={pillTone}>{pill}</Pill>:<span className="subtle">{I.chevR()}</span>}</div>);
const Account=({go,reset})=>(<div className="screen"><Bar/><H t="Cuenta"/>
 <div className="pad scroll" style={{flex:1,paddingBottom:96}}>
  <div style={{textAlign:'center',padding:'6px 0 16px'}}><div style={{width:84,margin:'0 auto'}}><Avatar size={84}/></div><div style={{fontWeight:700,fontSize:19,marginTop:12}}>Khalid Ríos</div><div className="subtle mono" style={{fontSize:13}}>+51 987 654 321</div><span className="pill" style={{marginTop:10}}><span style={{color:'var(--warn)'}}>{I.star(1)}</span>4.97 · 248 viajes</span></div>
  <div className="card" style={{padding:'13px 16px',marginBottom:14,display:'flex',gap:11,alignItems:'center',background:'rgba(57,191,137,.08)',borderColor:'rgba(57,191,137,.3)'}}><span style={{color:'var(--success)'}}>{I.shield()}</span><span style={{fontSize:13.5,fontWeight:600}}>Tu documentación está al día</span></div>
  <div className="card" style={{padding:'2px 16px',marginBottom:14}}>
   <Row icon={I.doc} title="Documentos" sub="Vencimientos y estado" onClick={()=>go('documents')}/>
   <Row icon={I.gift} title="Incentivos" sub="Metas y recompensas" onClick={()=>go('incentives')}/>
   <Row icon={I.dest} title="Modo destino" sub="Fija a dónde vas" onClick={()=>go('destmode')}/>
   <Row icon={I.shield} title="Seguridad" sub="SOS · cámara · reportar" onClick={()=>go('safety')}/>
  </div>
  <div className="card" style={{padding:'2px 16px',marginBottom:14}}>
   <Row icon={I.shield} title="Registrar rostro" onClick={()=>go('enroll')}/>
   <Row icon={I.life} title="Accesibilidad e idioma" onClick={()=>go('access')}/>
   <Row icon={I.life} title="Soporte" onClick={()=>go('support')}/>
   <Row icon={I.car} title="Historial de viajes" onClick={()=>go('trips',true)}/>
  </div>
  <div className="card" style={{padding:'2px 16px'}}><Row icon={I.power} title="Cerrar sesión" danger onClick={()=>reset('splash')}/></div>
 </div><NavBar cur="account" go={go}/></div>);

const Documents=({back})=>(<div className="screen"><Bar/><H t="Documentos" onBack={back}/>
 <div className="pad scroll" style={{flex:1}}>
  <div className="card" style={{padding:'13px 16px',marginBottom:14,display:'flex',gap:11,alignItems:'center',background:'rgba(242,175,72,.08)',borderColor:'rgba(242,175,72,.35)'}}><span style={{color:'var(--warn)'}}>{I.alert()}</span><span style={{fontSize:13.5,fontWeight:600}}>1 documento por vencer pronto</span></div>
  <div style={{display:'flex',flexDirection:'column',gap:11}}>
   {[['Licencia de conducir','Vence 12/2027','Vigente','success'],['SOAT','Vence en 6 días','Por vencer','warn'],['Tarjeta de propiedad','Vigente','Vigente','success'],['Antecedentes','Verificado','Limpio','success']].map((d,k)=>(<div key={k} className="doc"><div className="leadcircle" style={{color:d[3]==='warn'?'var(--warn)':'var(--accent)'}}>{I.doc()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>{d[0]}</div><div className="subtle" style={{fontSize:12}}>{d[1]}</div></div><Pill tone={d[3]}>{d[2]}</Pill></div>))}
  </div>
 </div>
 <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent">Actualizar documento</button></div><NI/></div>);

const Incentives=({back})=>(<div className="screen"><Bar/><H t="Incentivos" onBack={back}/>
 <div className="pad scroll" style={{flex:1}}>
  <div className="card" style={{padding:'14px 16px',marginBottom:14,display:'flex',gap:11,alignItems:'center',background:'var(--surface2)'}}><span style={{color:'var(--accent)'}}>{I.gift()}</span><span style={{fontSize:13.5}}>2 metas activas · sigue así</span></div>
  {[['Completa 30 viajes','+ S/ 40','24','30'],['5 viajes en hora punta','+ S/ 15','3','5']].map((g,k)=>{const pct=Math.round(g[2]/g[3]*100);return(<div key={k} className="card" style={{padding:16,marginBottom:12}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}><div style={{fontWeight:700,fontSize:15}}>{g[0]}</div><span className="pill" style={{height:26,padding:'0 10px',fontSize:12,color:'var(--accent)',borderColor:'rgba(57,188,223,.4)'}}>{g[1]}</span></div><div style={{height:8,borderRadius:99,background:'var(--surface3)',overflow:'hidden'}}><div style={{height:'100%',width:pct+'%',background:'var(--accent)',borderRadius:99}}/></div><div className="subtle mono" style={{fontSize:12,marginTop:8}}>{g[2]} de {g[3]} · {pct}%</div></div>);})}
 </div><NI/></div>);

function DestMode({back,notify}){const [on,setOn]=useState(false);
 return(<div className="screen"><Bar/><H t="Modo destino" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <p className="muted" style={{fontSize:14,marginBottom:16,lineHeight:1.45}}>Fija a dónde vas y recibe solo viajes que te acerquen. Hasta 2 veces al día.</p>
   <div className="card" style={{padding:'15px 16px',display:'flex',alignItems:'center',gap:14,marginBottom:14}}><div className="leadcircle" style={{color:'var(--accent)'}}>{I.dest()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>Activar modo destino</div><div className="subtle" style={{fontSize:12}}>{on?'Activo':'Desactivado'}</div></div><span onClick={()=>setOn(!on)} style={{width:46,height:28,borderRadius:99,background:on?'var(--accent)':'var(--surface3)',position:'relative',cursor:'pointer',border:'1px solid '+(on?'var(--accent)':'var(--border)')}}><span style={{position:'absolute',top:3,left:on?20:3,width:20,height:20,borderRadius:'50%',background:on?'var(--on-accent)':'var(--ink-muted)',transition:'.18s'}}/></span></div>
   {on&&<div><label className="fieldlabel">¿A dónde vas?</label><input className="field" defaultValue="Casa · Av. Brasil 1290"/><div className="subtle" style={{fontSize:12,marginTop:10}}>2 de 2 usos disponibles hoy.</div></div>}
  </div>
  <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent" onClick={()=>{notify('Modo destino guardado');back();}}>Guardar</button></div><NI/></div>);
}

const Safety=({back,notify})=>(<div className="screen"><Bar/><H t="Seguridad" onBack={back}/>
 <div className="pad scroll" style={{flex:1}}>
  <button className="btn btn-danger btn-lg" style={{marginBottom:14}} onClick={()=>notify('Alerta enviada a la central')}><span style={{fontWeight:800,fontFamily:'var(--font-display)'}}>SOS</span> Enviar alerta a la central</button>
  <div className="card" style={{padding:'2px 16px',marginBottom:14}}>
   <Row icon={I.cam} title="Cámara de cabina" sub="Transmitiendo durante el viaje" pill="Activa" pillTone="accent"/>
   <Row icon={I.alert} title="Reportar un incidente" onClick={()=>notify('Abrir reporte')}/>
   <Row icon={I.life} title="Línea de seguridad 24/7" onClick={()=>notify('Llamando a seguridad')}/>
  </div>
  <div style={{display:'flex',gap:9,alignItems:'flex-start',color:'var(--ink-subtle)',fontSize:12,lineHeight:1.45}}><span style={{marginTop:1}}>{I.shield()}</span>La cámara protege a ambos. El equipo de VEO solo accede a la grabación con doble autorización.</div>
 </div><NI/></div>);

const Enroll=({back,notify})=>(<div className="screen"><Bar/>
 <div className="pad" style={{paddingTop:54,display:'flex',alignItems:'center',gap:12}}><div className="iconbtn" onClick={back}>{I.back()}</div><h2 className="display" style={{fontSize:20}}>Registrar rostro</h2></div>
 <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'0 30px',textAlign:'center'}}>
  <div className="radar" style={{width:110,height:110,borderRadius:'50%',background:'var(--surface2)',border:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'center',color:'var(--accent)',marginBottom:26}}><span style={{transform:'scale(1.6)'}}>{I.shield()}</span></div>
  <h2 className="display" style={{fontSize:23}}>Registra tu rostro</h2>
  <p className="muted" style={{marginTop:10,fontSize:14.5,lineHeight:1.5}}>Lo usaremos para verificar tu identidad al iniciar cada turno. Una sola vez.</p>
 </div>
 <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent btn-lg" onClick={()=>{notify('Rostro registrado');back();}}>Registrar rostro</button></div><NI/></div>);

function CAccess({back,notify}){const [size,setSize]=useState(1);const [lang,setLang]=useState('es');const [hc,setHc]=useState(false);
 const S={es:['Tamaño de texto','Idioma','Alto contraste','Así se verá','Listo para recibir viajes','Guardar'],en:['Text size','Language','High contrast','Preview','Ready for trips','Save'],qu:['Qillqa sayaynin','Rimay','Sinchi llimphi','Rikuchiy','Puriykunapaq listo','Waqaychay']}[lang];
 return(<div className="screen"><Bar/><H t="Accesibilidad e idioma" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <label className="fieldlabel">{S[0]}</label>
   <div className="seg" style={{marginBottom:6}}>{[0.9,1,1.2,1.4].map((o,i)=><button key={i} className={size===o?'on':''} style={{fontSize:(12+i*4)+'px'}} onClick={()=>setSize(o)}>A</button>)}</div>
   <label className="fieldlabel" style={{marginTop:14}}>{S[1]}</label>
   <div className="seg">{[['es','Español'],['en','English'],['qu','Runa Simi']].map(o=><button key={o[0]} className={lang===o[0]?'on':''} onClick={()=>setLang(o[0])}>{o[1]}</button>)}</div>
   <div className="card" style={{padding:'14px 16px',display:'flex',alignItems:'center',gap:14,marginTop:14}}><div className="leadcircle" style={{color:'var(--accent)'}}>{I.shield()}</div><div style={{flex:1,fontWeight:600,fontSize:15}}>{S[2]}</div><span onClick={()=>setHc(!hc)} style={{width:46,height:28,borderRadius:99,background:hc?'var(--accent)':'var(--surface3)',position:'relative',cursor:'pointer',border:'1px solid '+(hc?'var(--accent)':'var(--border)')}}><span style={{position:'absolute',top:3,left:hc?20:3,width:20,height:20,borderRadius:'50%',background:hc?'var(--on-accent)':'var(--ink-muted)',transition:'.18s'}}/></span></div>
   <div className="fieldlabel" style={{marginTop:18}}>{S[3]}</div>
   <div className="card" style={{padding:18,background:hc?'#000':'var(--surface)',border:hc?'2px solid #fff':'1px solid var(--border)'}}><div className="display" style={{fontSize:22*size,color:hc?'#fff':'var(--ink)'}}>{S[4]}</div></div>
  </div>
  <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent btn-lg" onClick={()=>{notify(lang==='en'?'Preferences saved':lang==='qu'?'Waqaychasqa':'Preferencias guardadas');back();}}>{S[5]}</button></div><NI/></div>);
}

function Support({back}){const [open,setOpen]=useState(0);const faq=[['¿Cómo inicio turno?','Presiona "Conéctate" y verifica tu rostro (prueba de vida). Es obligatorio por seguridad.'],['¿Cómo me pagan?','Tus ganancias se liquidan semanalmente. Puedes retirar a tu cuenta desde Ganancias.'],['¿Qué es la contraoferta?','Si la tarifa del pasajero no te conviene, propón otro precio. El pasajero acepta o sigue buscando.'],['Documentos vencidos','Si un documento vence, no podrás conectarte. Actualízalo en Cuenta → Documentos.']];
 return(<div className="screen"><Bar/><H t="Soporte" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <div className="card" style={{padding:'16px',marginBottom:16,display:'flex',alignItems:'center',gap:13,background:'var(--surface2)'}}><div className="leadcircle" style={{color:'var(--accent)'}}>{I.life()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>¿Necesitas ayuda?</div><div className="subtle" style={{fontSize:12}}>Reporta y te respondemos pronto.</div></div></div>
   <div className="fieldlabel" style={{textTransform:'uppercase',letterSpacing:'.1em',fontSize:11}}>Preguntas frecuentes</div>
   <div className="card" style={{padding:'2px 16px',marginBottom:16}}>{faq.map((f,k)=>(<div key={k} style={{borderBottom:k<faq.length-1?'1px solid var(--border)':'none'}}><div onClick={()=>setOpen(open===k?-1:k)} style={{display:'flex',alignItems:'center',gap:10,padding:'15px 0',cursor:'pointer'}}><span style={{flex:1,fontWeight:600,fontSize:14}}>{f[0]}</span><span className="subtle" style={{transform:open===k?'rotate(90deg)':'none',transition:'.2s'}}>{I.chevR()}</span></div>{open===k&&<p className="subtle" style={{fontSize:13,lineHeight:1.5,paddingBottom:14}}>{f[1]}</p>}</div>))}</div>
   <div className="fieldlabel" style={{textTransform:'uppercase',letterSpacing:'.1em',fontSize:11}}>Mis tickets</div>
   <div className="card" style={{padding:'2px 16px'}}><Row icon={I.life} title="Pago de Semana 22" sub="Resuelto · hace 3 días" pill="Resuelto" pillTone="success"/></div>
  </div>
  <div className="pad" style={{paddingBottom:32}}><button className="btn btn-accent">Reportar un problema</button></div><NI/></div>);
}

/* ===================== APP ===================== */
const SCREENS={splash:Splash,login:Login,email:Email,otp:Otp,rdata:RData,rveh:RVeh,rdoc:RDoc,rkyc:RKyc,review:Review,gate:Gate,blocked:(p)=><Gate {...p} blocked/>,home:Home,multioffers:MultiOffers,incoming:Incoming,counter:Counter,waiting:Waiting,active:Active,rated:Rated,cancel:Cancel,chat:Chat,earnings:Earnings,withdraw:Withdraw,access:CAccess,trips:Trips,tripdetail:TripDetail,account:Account,documents:Documents,incentives:Incentives,destmode:DestMode,safety:Safety,enroll:Enroll,support:Support};
function App(){
 const [stack,setStack]=useState(['splash']);
 const [data,setData]=useState({shift:'offline',offer:13,heat:true,tripPhase:null,approved:false});
 const [toast,setToast]=useState(null);
 const screen=stack[stack.length-1];
 const go=(s,replace)=>setStack(p=>replace?[...p.slice(0,-1),s]:[...p,s]);
 const back=()=>setStack(p=>p.length>1?p.slice(0,-1):p);
 const reset=(s)=>setStack([s]);
 const set=(o)=>setData(p=>({...p,...o}));
 const notify=(m)=>{setToast(m);clearTimeout(window.__t);window.__t=setTimeout(()=>setToast(null),1600);};
 const [push,setPush]=useState(null);
 const pushNotify=(t,b)=>{setPush({t,b});clearTimeout(window.__p);window.__p=setTimeout(()=>setPush(null),3600);};
 useEffect(()=>{const k=e=>{if(e.key==='p'||e.key==='P')pushNotify('Nueva solicitud de viaje','Recojo a 1.2 km · S/ 13.00 · toca para ver');};window.addEventListener('keydown',k);return()=>window.removeEventListener('keydown',k);},[]);
 useEffect(()=>{const k=e=>{if(e.key==='r'||e.key==='R')reset('splash');if(e.key==='Backspace'&&!/INPUT|TEXTAREA/.test(document.activeElement.tagName)){e.preventDefault();back();}};window.addEventListener('keydown',k);return()=>window.removeEventListener('keydown',k);},[]);
 const S=SCREENS[screen]||Splash;
 return(<><S key={screen} go={go} back={back} reset={reset} data={data} set={set} notify={notify} push={pushNotify}/>{toast&&<div className="toast">{toast}</div>}{push&&<div onClick={()=>setPush(null)} style={{position:'absolute',top:12,left:10,right:10,zIndex:80,background:'rgba(26,34,48,.96)',border:'1px solid #383D48',borderRadius:16,padding:'12px 14px',display:'flex',gap:12,alignItems:'center',boxShadow:'0 16px 40px rgba(0,0,0,.55)',cursor:'pointer'}}><div style={{width:34,height:34,borderRadius:9,background:'var(--accent)',color:'var(--on-accent)',display:'flex',alignItems:'center',justifyContent:'center',flex:'none',fontFamily:'var(--font-display)',fontWeight:700,fontSize:12}}>VEO</div><div style={{flex:1,minWidth:0}}><div style={{fontWeight:700,fontSize:13.5}}>{push.t}</div><div style={{fontSize:12,color:'var(--ink-muted)',marginTop:1,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{push.b}</div></div><span style={{fontSize:10,color:'var(--ink-subtle)',flex:'none'}}>ahora</span></div>}</>);
}
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
