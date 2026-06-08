/* VEO Pasajero — pantallas clicables. Exporta window.VEO = {SCREENS, TABBAR} */
const {useState,useEffect}=React;

const I={
 signal:()=> <svg width="18" height="12" viewBox="0 0 18 12"><g fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2.5" width="3" height="9.5" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>,
 wifi:()=> <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.4c2.6 0 5 1 6.8 2.7l1.4-1.5A11.4 11.4 0 0 0 8.5.4 11.4 11.4 0 0 0 .3 3.6L1.7 5A9.4 9.4 0 0 1 8.5 2.4Z"/><path d="M8.5 6c1.4 0 2.7.5 3.7 1.4l1.4-1.5A7.4 7.4 0 0 0 8.5 4 7.4 7.4 0 0 0 3.4 5.9l1.4 1.5A5.4 5.4 0 0 1 8.5 6Z"/><path d="M8.5 9.5 10.6 7.4A3 3 0 0 0 8.5 6.6 3 3 0 0 0 6.4 7.4Z"/></svg>,
 batt:()=> <svg width="26" height="13" viewBox="0 0 26 13"><rect x="0.5" y="0.5" width="22" height="12" rx="3.2" fill="none" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="17" height="9" rx="2" fill="currentColor"/><rect x="23.5" y="4" width="2" height="5" rx="1" fill="currentColor" opacity=".5"/></svg>,
 arrowL:()=> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>,
 x:()=> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>,
 search:()=> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>,
 pin:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/></svg>,
 home:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>,
 work:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
 clock:()=> <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" strokeLinecap="round"/></svg>,
 star:(f)=> <svg width="14" height="14" viewBox="0 0 24 24" fill={f?'currentColor':'none'} stroke="currentColor" strokeWidth="1.6"><path d="M12 3l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17.8 6.7 19.2l1-5.8L3.5 9.2l5.9-.9z"/></svg>,
 phone:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M5 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L19 16l-1 3"/><path d="M16 21a13 13 0 0 1-13-13"/></svg>,
 chat:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.7A8 8 0 1 1 21 12Z"/></svg>,
 shield:()=> <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M12 3l7 3v5c0 4.4-3 8.3-7 10-4-1.7-7-5.6-7-10V6z"/></svg>,
 eye:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>,
 share:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8 15.8 7M8.2 13.2 15.8 17"/></svg>,
 check:()=> <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10"/></svg>,
 chevR:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 6l6 6-6 6"/></svg>,
 lock:()=> <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>,
 cam:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.2"/></svg>,
 minus:()=> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 12h14"/></svg>,
 plus:()=> <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>,
 card:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19"/></svg>,
 users:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><circle cx="9" cy="8" r="3.4"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M16 5a3.3 3.3 0 0 1 0 6.3"/><path d="M17.5 14a5 5 0 0 1 3.2 5"/></svg>,
 link:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 13a4 4 0 0 0 5.7.3l3-3A4 4 0 0 0 13 5l-1.5 1.5"/><path d="M14 11a4 4 0 0 0-5.7-.3l-3 3A4 4 0 0 0 11 19l1.5-1.5"/></svg>,
 copy:()=> <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
 child:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><circle cx="12" cy="6.5" r="3"/><path d="M6 21v-2a6 6 0 0 1 12 0v2"/></svg>,
 scan:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="11" r="2.6"/><path d="M8.5 16.5a4 4 0 0 1 7 0"/></svg>,
 power:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3v9"/><path d="M6.5 7a8 8 0 1 0 11 0"/></svg>,
 route:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="5" r="2.2"/><path d="M8.2 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.8"/></svg>,
 gift:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M3 12h18M12 8v13M12 8S10 3 7.5 4.5 9 8 12 8s2.5-2 4.5-3.5S12 8 12 8Z"/></svg>,
 help:()=> <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7" strokeLinecap="round"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>,
 tHome:(a)=> <svg width="24" height="24" viewBox="0 0 24 24" fill={a?'currentColor':'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>,
 tTrips:(a)=> <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" fill={a?'currentColor':'none'}/><path d="M3 9h18" stroke={a?'#0E1014':'currentColor'}/><path d="M8 3v3M16 3v3" stroke={a?'#0E1014':'currentColor'}/></svg>,
 tUser:(a)=> <svg width="24" height="24" viewBox="0 0 24 24" fill={a?'currentColor':'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0z"/></svg>,
};

const Bar=()=>(<div className="statusbar"><span className="time">9:41</span><div className="right">{I.signal()}{I.wifi()}{I.batt()}</div></div>);
const HI=()=> <div className="home-ind"/>;
const Wordmark=({size=26,color='var(--ink)'})=>(<div style={{display:'flex',alignItems:'center',gap:9}}><span className="display" style={{fontSize:size,fontWeight:700,color}}>VEO</span><span style={{width:size*0.30,height:size*0.30,borderRadius:'50%',background:'var(--accent)',marginTop:size*0.10,boxShadow:'0 0 14px var(--route-glow)'}}/></div>);
const Avatar=({size=42,label='MF'})=>(<div className="ph-img" style={{width:size,height:size,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',border:'1px solid var(--border)'}}><span style={{fontFamily:'var(--font-mono)',fontSize:Math.max(8,size*0.18),color:'var(--ink-muted)'}}>{label}</span></div>);
const Toggle=({on,onClick})=>(<span onClick={onClick} style={{width:46,height:28,borderRadius:99,background:on?'var(--accent)':'var(--surface3)',position:'relative',flex:'none',border:'1px solid '+(on?'var(--accent)':'var(--border)'),cursor:'pointer'}}><span style={{position:'absolute',top:3,left:on?20:3,width:20,height:20,borderRadius:'50%',background:on?'var(--on-accent)':'var(--ink-muted)',transition:'.18s'}}/></span>);
const Header=({title,onBack,onX,right,size=22})=>(<div className="pad" style={{paddingTop:60,paddingBottom:8,display:'flex',alignItems:'center',gap:12}}>{onBack&&<div className="iconbtn" onClick={onBack}>{I.arrowL()}</div>}<h2 className="display" style={{fontSize:size,flex:1}}>{title}</h2>{right}{onX&&<div className="iconbtn" onClick={onX}>{I.x()}</div>}</div>);
function Row({icon,title,sub,pill,pillTone,danger,onClick}){
 const tone={success:['rgba(52,211,153,.4)','var(--success)'],warn:['rgba(242,175,72,.4)','var(--warn)']}[pillTone]||['var(--border)','var(--ink-muted)'];
 return(<div className="listrow" onClick={onClick}><div className="leadcircle" style={{color:danger?'var(--danger)':'var(--accent)'}}>{icon()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15,color:danger?'var(--danger)':'var(--ink)'}}>{title}</div>{sub&&<div className="subtle" style={{fontSize:12}}>{sub}</div>}</div>{pill?<span className="pill" style={{height:26,padding:'0 10px',fontSize:12,borderColor:tone[0],color:tone[1]}}><span className="dot" style={{background:tone[1]}}/>{pill}</span>:<span className="subtle">{I.chevR()}</span>}</div>);
}
function MapCanvas({mode='idle',carT=0.45,dim=false}){
 const route="M 96 612 L 96 500 L 206 500 L 206 360 L 300 360 L 300 196";
 const pts=[[96,612],[96,500],[206,500],[206,360],[300,360],[300,196]];
 const cp=(()=>{const sl=[];let tot=0;for(let i=0;i<pts.length-1;i++){const l=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]);sl.push(l);tot+=l;}let d=carT*tot;for(let i=0;i<sl.length;i++){if(d<=sl[i]){const f=d/sl[i];return{x:pts[i][0]+(pts[i+1][0]-pts[i][0])*f,y:pts[i][1]+(pts[i+1][1]-pts[i][1])*f,ang:Math.atan2(pts[i+1][1]-pts[i][1],pts[i+1][0]-pts[i][0])};}d-=sl[i];}return{x:300,y:196,ang:0};})();
 const sr=mode==='route'||mode==='trip';
 return(<div className="map"><svg viewBox="0 0 390 844" preserveAspectRatio="xMidYMid slice">
  <g opacity="0.55">{Array.from({length:7}).map((_,r)=>Array.from({length:5}).map((_,c)=>{const x=c*92-30+((r%2)*16),y=r*120-40;return <rect key={r+'-'+c} x={x} y={y} width="74" height="92" rx="6" fill="#13161c"/>;}))}</g>
  <g stroke="#1c2128" strokeWidth="9" fill="none" opacity="0.9"><path d="M-20 140 H410"/><path d="M-20 360 H410"/><path d="M-20 500 H410"/><path d="M-20 700 H410"/><path d="M96 -20 V860"/><path d="M206 -20 V860"/><path d="M300 -20 V860"/></g>
  <rect x="222" y="150" width="120" height="120" rx="14" fill="#121a16" opacity="0.8"/>
  {sr&&<><path d={route} fill="none" stroke="var(--route-glow)" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round"/><path d={route} fill="none" stroke="var(--route)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/><circle cx="96" cy="612" r="9" fill="#0E1014" stroke="var(--accent)" strokeWidth="3.5"/><g><circle cx="300" cy="196" r="13" fill="var(--accent)"/><circle cx="300" cy="196" r="5" fill="#0E1014"/></g></>}
  {mode==='idle'&&<><circle cx="195" cy="430" r="22" fill="var(--route-glow)"/><circle cx="195" cy="430" r="8" fill="var(--accent)" stroke="#0E1014" strokeWidth="3"/></>}
  {mode==='trip'&&<g transform={`translate(${cp.x} ${cp.y}) rotate(${cp.ang*180/Math.PI+90})`}><rect x="-13" y="-19" width="26" height="38" rx="9" fill="#0E1014" stroke="var(--accent)" strokeWidth="2.5"/><rect x="-7" y="-12" width="14" height="9" rx="2.5" fill="var(--accent)" opacity=".85"/><rect x="-7" y="3" width="14" height="8" rx="2.5" fill="#2a2f38"/></g>}
 </svg>{dim&&<div style={{position:'absolute',inset:0,background:'rgba(10,11,14,.55)'}}/>}</div>);
}
const Driver=({onCall,onChat})=>(<div className="card" style={{padding:14,display:'flex',gap:14,alignItems:'center',marginBottom:14}}>
 <div className="ph-img" style={{width:60,height:60,borderRadius:16,flex:'none'}}><span className="lbl">conductor</span></div>
 <div style={{flex:1}}><div style={{display:'flex',alignItems:'center',gap:7}}><span style={{fontWeight:700,fontSize:16,whiteSpace:'nowrap'}}>Khalid Ríos</span><span className="pill" style={{height:24,padding:'0 8px',fontSize:12}}><span style={{color:'var(--warn)'}}>{I.star(1)}</span>4.97</span></div>
 <div className="subtle" style={{fontSize:13,marginTop:3}}>Toyota Yaris · Plomo</div>
 <div className="mono" style={{fontSize:15,marginTop:6,letterSpacing:'.06em',whiteSpace:'nowrap',background:'var(--surface2)',display:'inline-block',padding:'3px 9px',borderRadius:7,border:'1px solid var(--border)'}}>ABC-481</div></div>
 <div style={{display:'flex',flexDirection:'column',gap:8}}><div className="iconbtn" onClick={onCall}>{I.phone()}</div><div className="iconbtn" onClick={onChat}>{I.chat()}</div></div></div>);

/* ===== screens ===== */
const Splash=({go})=>(<div className="screen" style={{justifyContent:'space-between',background:'radial-gradient(90% 55% at 78% 12%, rgba(200,242,48,.13) 0%, transparent 55%), linear-gradient(180deg,#0d1216 0%,#0b0e12 40%,#0E1014 100%)'}}>
 <Bar/>
 <svg viewBox="0 0 390 844" style={{position:'absolute',inset:0,width:'100%',height:'100%',opacity:.5}}><path d="M-10 700 C 120 640, 90 460, 230 420 S 360 250, 330 120" fill="none" stroke="var(--route-glow)" strokeWidth="2" strokeDasharray="2 9" strokeLinecap="round"/><circle cx="330" cy="120" r="5" fill="var(--accent)"/></svg>
 <div className="pad" style={{paddingTop:74,position:'relative'}}><Wordmark size={26}/></div>
 <div className="pad" style={{paddingBottom:40,position:'relative'}}>
  <div className="eyebrow" style={{marginBottom:16}}>YO VEO · TÚ VAS SEGURO</div>
  <h1 className="display" style={{fontSize:46,fontWeight:600}}>Tu familia<br/>te ve llegar.</h1>
  <p className="muted" style={{marginTop:16,fontSize:15.5,lineHeight:1.5,maxWidth:300}}>Cara del conductor, placa, ruta y cámara en vivo. Nada oculto. Movilidad segura en Lima.</p>
  <button className="btn btn-accent" style={{marginTop:28}} onClick={()=>go('onboarding')}>Empezar</button>
  <button className="btn btn-ghost btn-sm" style={{marginTop:6}} onClick={()=>go('auth')}>Ya tengo cuenta</button></div>
 <HI/></div>);

function Onboarding({go}){
 const slides=[{ey:'SEGURIDAD',t:'La seguridad se siente,\nno se grita.',b:'Botón SOS, contactos de confianza y cámara de cabina. Un abrazo, no una alarma.',art:'shield'},{ey:'PRECIO CLARO',t:'Tú pones\nel precio.',b:'Ofreces tu tarifa y los conductores aceptan o proponen otra. Sin sorpresas.',art:'price'},{ey:'ANTES DE EMPEZAR',t:'Tu privacidad,\nbajo tu control.',b:'Según la Ley N.° 29733 necesitamos 3 permisos.',art:'consent'}];
 const [i,setI]=useState(0);const [c,setC]=useState([false,false,false]);const [pushOn,setPush]=useState(true);const all=c.every(Boolean);const s=slides[i];
 return(<div className="screen" style={{justifyContent:'space-between'}}><Bar/>
  <div className="pad" style={{paddingTop:64,display:'flex',justifyContent:'space-between',alignItems:'center'}}><Wordmark size={20}/><span className="pill">{i+1} de 3</span></div>
  <div className="pad scroll" style={{flex:1,paddingTop:18}}>
   <div className="card" style={{height:200,marginBottom:24,display:'flex',alignItems:'center',justifyContent:'center',background:'radial-gradient(80% 80% at 50% 30%, rgba(200,242,48,.08), transparent 60%), var(--surface)'}}>{s.art==='price'?<div style={{display:'flex',alignItems:'center',gap:10}}><div className="iconbtn">{I.minus()}</div><div className="display mono" style={{fontSize:30}}>S/ 13</div><div className="iconbtn" style={{background:'var(--accent)',color:'var(--on-accent)',border:'none'}}>{I.plus()}</div></div>:<div style={{color:'var(--accent)',transform:'scale(2.6)'}}>{s.art==='shield'?I.shield():I.eye()}</div>}</div>
   <div className="eyebrow" style={{marginBottom:12}}>{s.ey}</div>
   <h2 className="display" style={{fontSize:29,whiteSpace:'pre-line',lineHeight:1.08}}>{s.t}</h2>
   <p className="muted" style={{marginTop:12,fontSize:15,lineHeight:1.5}}>{s.b}</p>
   {i===2&&<div style={{marginTop:18,display:'flex',flexDirection:'column',gap:10}}>{['Acepto el tratamiento de mis datos','Acepto la cámara en cabina durante el viaje','Acepto compartir mi ubicación'].map((t,idx)=>(<div key={idx} onClick={()=>setC(p=>p.map((v,j)=>j===idx?!v:v))} style={{display:'flex',gap:13,alignItems:'flex-start',padding:15,borderRadius:16,border:'1px solid '+(c[idx]?'var(--accent)':'var(--border)'),background:'var(--surface)',cursor:'pointer'}}><div className={'check'+(c[idx]?' on':'')}>{c[idx]&&I.check()}</div><span style={{fontSize:14,fontWeight:500,lineHeight:1.4}}>{t}</span></div>))}
    <div onClick={()=>setPush(!pushOn)} style={{display:'flex',gap:13,alignItems:'flex-start',padding:15,borderRadius:16,border:'1px solid '+(pushOn?'var(--accent)':'var(--border)'),background:'var(--surface)',cursor:'pointer'}}><div className={'check'+(pushOn?' on':'')}>{pushOn&&I.check()}</div><div><span style={{fontSize:14,fontWeight:500,lineHeight:1.4}}>Permitir notificaciones (opcional)</span><div className="subtle" style={{fontSize:12,marginTop:3}}>Avisos de tu conductor, llegada y seguridad.</div></div></div></div>}
  </div>
  <div className="pad" style={{paddingBottom:34}}>
   <div style={{display:'flex',justifyContent:'center',gap:7,marginBottom:18}}>{slides.map((_,idx)=><span key={idx} style={{height:7,borderRadius:99,width:idx===i?26:7,background:idx===i?'var(--accent)':'var(--border-strong)',transition:'.3s'}}/>)}</div>
   {i<2?<div style={{display:'flex',gap:12}}><button className="btn btn-surface" style={{flex:'0 0 110px'}} onClick={()=>setI(2)}>Saltar</button><button className="btn btn-accent" onClick={()=>setI(i+1)}>Siguiente</button></div>
   :<button className="btn btn-accent" disabled={!all} onClick={()=>go('auth')}>Aceptar y continuar</button>}
  </div><HI/></div>);
}

function Auth({go,set}){
 const [step,setStep]=useState('start');const [phone,setPhone]=useState('');const [otp,setOtp]=useState('');const [help,setHelp]=useState(false);
 const valid=phone.replace(/\D/g,'').length===9;
 const fmt=v=>{const d=v.replace(/\D/g,'').slice(0,9);return d.replace(/(\d{3})(\d{0,3})(\d{0,3})/,(m,a,b,c)=>[a,b,c].filter(Boolean).join(' '));};
 const social=()=>go('profilesetup');
 return(<div className="screen" style={{justifyContent:'space-between'}}><Bar/>
  {step==='start'?<>
   <div className="pad scroll" style={{paddingTop:70,flex:1}}>
    <div style={{width:54,height:54,borderRadius:17,background:'var(--accent)',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:24,boxShadow:'0 0 30px var(--route-glow)'}}><span style={{color:'var(--on-accent)'}}>{I.eye()}</span></div>
    <h1 className="display" style={{fontSize:30}}>Ingresa a VEO</h1>
    <p className="muted" style={{marginTop:10,fontSize:15}}>Elige cómo quieres entrar.</p>
    <div style={{display:'flex',flexDirection:'column',gap:10,marginTop:24}}>
     <button className="btn btn-light btn-sm" style={{background:'#fff'}} onClick={social}><span style={{width:20,height:20,borderRadius:'50%',background:'#4285F4',color:'#fff',display:'inline-flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:12}}>G</span> Continuar con Google</button>
     <button className="btn btn-surface btn-sm" onClick={social}><span style={{width:20,height:20,borderRadius:'50%',background:'#1877F2',color:'#fff',display:'inline-flex',alignItems:'center',justifyContent:'center',fontWeight:800,fontSize:13}}>f</span> Continuar con Facebook</button>
     <button className="btn btn-surface btn-sm" onClick={social}>✉ Continuar con correo</button>
     <button className="btn btn-surface btn-sm" onClick={()=>setStep('phone')}>{I.phone()} Continuar con teléfono</button>
    </div>
    <p className="subtle" style={{fontSize:11.5,marginTop:16,lineHeight:1.45}}>¿Sin celular o sin señal? Usa correo o Google — no necesitas SMS.</p>
   </div>
  </>:step==='phone'?<>
   <div className="pad" style={{paddingTop:64}}>
    <div className="iconbtn" onClick={()=>setStep('start')} style={{marginBottom:20}}>{I.arrowL()}</div>
    <h1 className="display" style={{fontSize:32}}>Tu número</h1>
    <p className="muted" style={{marginTop:10,fontSize:15}}>Te enviaremos un código por SMS para verificar tu identidad.</p>
    <div style={{marginTop:30}}><label className="fieldlabel">Número de celular</label><div style={{display:'flex',gap:10}}><div className="field" style={{width:78,flex:'none',justifyContent:'center',fontWeight:600}}>+51</div><input className="field mono" style={{flex:1,fontSize:18}} inputMode="numeric" placeholder="987 654 321" value={phone} onChange={e=>setPhone(fmt(e.target.value))}/></div><p className="subtle" style={{fontSize:12,marginTop:10}}>Ingresa tu número de 9 dígitos.</p></div>
   </div>
   <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" disabled={!valid} onClick={()=>setStep('otp')}>Enviar código</button></div>
  </>:<>
   <div className="pad scroll" style={{paddingTop:64,flex:1}}>
    <div className="iconbtn" onClick={()=>setStep('phone')} style={{marginBottom:20}}>{I.arrowL()}</div>
    <h1 className="display" style={{fontSize:32}}>Ingresa el código</h1>
    <p className="muted" style={{marginTop:10,fontSize:15}}>Enviado al <span className="mono">+51 ··· {phone.slice(-3)||'321'}</span></p>
    <div style={{display:'flex',gap:9,marginTop:26}}>{Array.from({length:6}).map((_,k)=><div key={k} style={{flex:1,height:60,borderRadius:14,background:'var(--surface2)',border:'1.5px solid '+(otp.length===k?'var(--accent)':otp[k]?'var(--border-strong)':'var(--border)'),display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'var(--font-mono)',fontSize:24,fontWeight:600}}>{otp[k]||''}</div>)}</div>
    <div style={{display:'flex',gap:9,marginTop:14,flexWrap:'wrap'}}>{[1,2,3,4,5,6,7,8,9,0].map(n=><button key={n} className="btn btn-surface" style={{width:n===0?'100%':'30%',height:44}} onClick={()=>setOtp(o=>(o+n).slice(0,6))}>{n}</button>)}</div>
    <div className="subtle" style={{textAlign:'center',fontSize:12.5,marginTop:14,cursor:'pointer'}} onClick={()=>setHelp(true)}>¿No te llegó el código?</div>
   </div>
   <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" disabled={otp.length<6} onClick={()=>go('profilesetup')}>Verificar</button></div>
  </>}
  {help&&<div style={{position:'absolute',inset:0,background:'var(--overlay)',display:'flex',alignItems:'flex-end',zIndex:40}} onClick={()=>setHelp(false)}><div className="bsheet" style={{paddingTop:18}} onClick={e=>e.stopPropagation()}><div className="grabber" style={{marginBottom:16}}/><h3 className="display" style={{fontSize:20}}>¿No te llegó el SMS?</h3><p className="muted" style={{fontSize:13.5,lineHeight:1.5,margin:'8px 0 16px'}}>A veces el SMS se demora. Prueba otra vía:</p>
   <button className="btn btn-surface btn-sm" style={{marginBottom:8}} onClick={()=>setHelp(false)}>{I.phone()} Recibir el código por llamada</button>
   <button className="btn btn-surface btn-sm" style={{marginBottom:8}} onClick={()=>setHelp(false)}><span style={{color:'#25D366',fontWeight:800}}>✆</span> Enviar por WhatsApp</button>
   <button className="btn btn-surface btn-sm" style={{marginBottom:8}} onClick={()=>{setHelp(false);go('profilesetup');}}>✉ Mejor entro con correo</button>
   <button className="btn btn-ghost btn-sm" onClick={()=>setHelp(false)}>Reenviar SMS · 0:30</button>
  </div></div>}
  <HI/></div>);
}

const ProfileSetup=({reset})=>(<div className="screen" style={{justifyContent:'space-between'}}><Bar/>
 <div className="pad scroll" style={{paddingTop:66,flex:1}}>
  <div style={{textAlign:'center'}}><Wordmark size={18}/><h1 className="display" style={{fontSize:30,marginTop:22}}>Tu perfil</h1><p className="muted" style={{marginTop:8,fontSize:15}}>Para que el conductor sepa a quién recoge.</p>
   <div style={{position:'relative',width:108,height:108,margin:'26px auto 8px'}}><div style={{width:108,height:108,borderRadius:'50%',border:'2px dashed var(--accent)',padding:5}}><Avatar size={94} label=""/></div><div style={{position:'absolute',right:0,bottom:4,width:38,height:38,borderRadius:'50%',background:'var(--accent)',color:'var(--on-accent)',display:'flex',alignItems:'center',justifyContent:'center',border:'3px solid var(--bg)'}}>{I.cam()}</div></div></div>
  <div style={{marginTop:14,display:'flex',flexDirection:'column',gap:12}}>
   <div><label className="fieldlabel">Nombre completo</label><input className="field" defaultValue="María Fernanda Salas"/></div>
   <div><label className="fieldlabel">Correo (opcional)</label><input className="field" placeholder="tu@correo.com"/></div>
   <div style={{display:'flex',gap:9,alignItems:'center',color:'var(--ink-subtle)',fontSize:12}}><span>{I.lock()}</span>Solo el conductor de tu viaje ve tu nombre.</div></div>
 </div>
 <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>reset('home')}>Guardar</button></div><HI/></div>);

const Notifs=({go,back})=>(<div className="screen"><Bar/><Header title="Notificaciones" onBack={back}/>
 <div className="pad scroll" style={{flex:1,paddingBottom:30}}>
  {[[I.clock,'Tu viaje programado empieza pronto','Casa → Aeropuerto · mañana 7:30 a. m. Pídelo ahora para asegurar conductor.','accent','Pedir ahora','offer'],[I.shield,'Verifica tus contactos de confianza','Diego sigue pendiente de confirmar por OTP.','warn','Revisar','trusted'],[I.gift,'Gana S/ 10 por cada amigo','Comparte tu código MAFE-2026.','muted','Invitar','referrals'],[I.card,'Recibo de tu último viaje','Jockey Plaza · S/ 13.00 · toca para ver','muted','Ver','tripdetail']].map((n,k)=>(
   <div key={k} className="card" style={{padding:14,marginBottom:10,display:'flex',gap:13,alignItems:'flex-start'}}>
    <div className="leadcircle" style={{color:n[3]==='accent'?'var(--accent)':n[3]==='warn'?'var(--warn)':'var(--ink-muted)'}}>{n[0]()}</div>
    <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14.5}}>{n[1]}</div><div className="subtle" style={{fontSize:12.5,marginTop:3,lineHeight:1.45}}>{n[2]}</div><div className="btn btn-surface btn-sm" style={{width:'auto',display:'inline-flex',padding:'0 16px',marginTop:10}} onClick={()=>go(n[5])}>{n[4]}</div></div>
   </div>))}
  <div className="subtle" style={{textAlign:'center',fontSize:12,marginTop:8}}>No hay más notificaciones.</div>
 </div><HI/></div>);

const Home=({go})=>(<div className="screen"><Bar/><MapCanvas mode="idle"/>
 <div className="pad" style={{position:'absolute',top:60,left:0,right:0,zIndex:20,display:'flex',justifyContent:'space-between',alignItems:'center'}}><span className="pill" style={{boxShadow:'0 8px 24px rgba(0,0,0,.4)'}}><span className="dot" style={{background:'var(--accent)'}}/>Av. Pardo y Aliaga</span><div style={{display:'flex',gap:10,alignItems:'center'}}><div className="iconbtn" onClick={()=>go('notifs')} style={{position:'relative',background:'var(--surface)',boxShadow:'0 8px 24px rgba(0,0,0,.4)'}}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.5 21a2 2 0 0 1-3 0"/></svg><span style={{position:'absolute',top:-3,right:-3,width:16,height:16,borderRadius:'50%',background:'var(--accent)',color:'var(--on-accent)',fontSize:10,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center'}}>2</span></div><div onClick={()=>go('profile')} style={{cursor:'pointer'}}><Avatar size={42}/></div></div></div>
 <div style={{position:'absolute',left:0,right:0,bottom:88,zIndex:25,padding:'0 18px 14px'}}>
  <div style={{display:'flex',gap:9,marginBottom:12,overflowX:'auto'}} className="scroll">{[['Casa',I.home],['Trabajo',I.work],['Larcomar',I.pin]].map((r,k)=>(<button key={k} className="pill" style={{flex:'none',cursor:'pointer'}} onClick={()=>go('offer')}><span style={{color:'var(--accent)'}}>{r[1]()}</span>{r[0]}</button>))}</div>
  <div className="card" onClick={()=>go('search')} style={{display:'flex',alignItems:'center',gap:12,padding:'17px 18px',cursor:'pointer',background:'var(--surface2)',marginBottom:10}}><span style={{color:'var(--accent)'}}>{I.search()}</span><span style={{fontSize:17,fontWeight:500}}>¿A dónde vamos?</span></div>
  <div className="card" style={{padding:'2px 16px'}}>{[['Casa','Av. Pardo 1245, Miraflores',I.home],['Trabajo','San Isidro Financial',I.work]].map((r,k)=>(<div key={k} className="listrow" onClick={()=>go('offer')}><div className="leadcircle">{r[2]()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>{r[0]}</div><div className="subtle" style={{fontSize:13}}>{r[1]}</div></div><span className="subtle">{I.chevR()}</span></div>))}</div>
 </div></div>);

const Search=({go,back})=>{const [q,setQ]=useState('');const res=[['Jockey Plaza','Av. Javier Prado Este 4200, Surco'],['Aeropuerto Jorge Chávez','Av. Elmer Faucett s/n, Callao'],['Parque Kennedy','Av. Larco, Miraflores'],['Plaza San Miguel','Av. La Marina 2000']];
 return(<div className="screen"><Bar/>
  <Header title="¿A dónde vas?" onX={back}/>
  <div className="pad"><div className="card" style={{padding:'4px 16px',marginBottom:14}}>
   <div style={{display:'flex',alignItems:'center',gap:13,padding:'13px 0',borderBottom:'1px solid var(--border)'}}><span style={{width:11,height:11,borderRadius:'50%',border:'2px solid var(--accent)',flex:'none'}}/><span style={{fontSize:15}}>Av. Pardo y Aliaga</span></div>
   <div style={{display:'flex',alignItems:'center',gap:13,padding:'13px 0'}}><span style={{color:'var(--accent)'}}>{I.pin()}</span><input className="field" style={{border:'none',background:'transparent',height:'auto',padding:0,fontSize:15}} autoFocus placeholder="¿A dónde vamos?" value={q} onChange={e=>setQ(e.target.value)}/></div>
  </div></div>
  <div className="pad scroll" style={{flex:1}}>
   <div className="listrow" onClick={()=>go('offer')}><div className="leadcircle" style={{color:'var(--accent)'}}>{I.pin()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>Usar mi ubicación</div></div></div>
   {res.filter(r=>r[0].toLowerCase().includes(q.toLowerCase())).map((r,k)=>(<div key={k} className="listrow" onClick={()=>go('offer')}><div className="leadcircle">{I.pin()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>{r[0]}</div><div className="subtle" style={{fontSize:13}}>{r[1]}</div></div></div>))}
  </div><HI/></div>);
};

function Offer({go,back,data,set}){
 const TARIFF={base:3.5,km:1.2,min:0.35,floor:7}; // espejo de Admin · Tarifas y zonas
 const dist=4.5, mins=11;
 const suggested=Math.max(TARIFF.floor,Math.round(TARIFF.base+dist*TARIFF.km+mins*TARIFF.min));
 const lo=suggested-1, hi=suggested+2;
 const reqs=[['pet','Mascota',I.child],['bag','Equipaje',I.work],['child','Silla de niño',I.child],['stop','Una parada',I.pin]];
 const sel=data.reqs||[];
 const toggle=(id)=>set({reqs:sel.includes(id)?sel.filter(x=>x!==id):[...sel,id]});
 return(<div className="screen"><Bar/><MapCanvas mode="route"/>
 <div className="pad" style={{position:'absolute',top:60,zIndex:20}}><div className="iconbtn" onClick={back} style={{boxShadow:'0 8px 24px rgba(0,0,0,.5)'}}>{I.arrowL()}</div></div>
 <div className="bsheet" style={{maxHeight:'80%'}}>
  <div className="grabber" style={{marginBottom:14}}/>
  <div className="scroll" style={{maxHeight:'calc(80vh - 120px)',overflowY:'auto'}}>
  <div className="card" style={{padding:'12px 16px',marginBottom:16,background:'var(--surface2)'}}>
   <div style={{display:'flex',alignItems:'center',gap:12,padding:'6px 0'}}><span style={{width:10,height:10,borderRadius:'50%',border:'2px solid var(--accent)'}}/><span style={{fontSize:14}}>Av. Pardo y Aliaga</span></div>
   {sel.includes('stop')&&<><div style={{height:1,background:'var(--border)',margin:'2px 0 2px 4px'}}/><div style={{display:'flex',alignItems:'center',gap:12,padding:'6px 0'}}><span style={{width:10,height:10,borderRadius:3,border:'2px solid var(--ink-muted)'}}/><span style={{fontSize:14,flex:1}}>Parada · Óvalo Gutiérrez</span><span className="badge-eco" style={{background:'var(--surface3)',color:'var(--ink-muted)'}}>PARADA</span></div></>}
   <div style={{height:1,background:'var(--border)',margin:'2px 0 2px 4px'}}/>
   <div style={{display:'flex',alignItems:'center',gap:12,padding:'6px 0'}}><span style={{color:'var(--accent)'}}>{I.pin()}</span><span style={{fontSize:14}}>Jockey Plaza, Surco</span><span className="subtle mono" style={{marginLeft:'auto',fontSize:13,whiteSpace:'nowrap'}}>{sel.includes('stop')?'11.0 km · 27 min':'9.2 km · 22 min'}</span></div></div>
  <div style={{textAlign:'center',marginBottom:4}}><span className="eyebrow" style={{color:'var(--ink-muted)'}}>OFRECE TU TARIFA</span></div>
  <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:22,margin:'6px 0 4px'}}>
   <div className="iconbtn" style={{width:50,height:50,borderRadius:16}} onClick={()=>set({price:Math.max(TARIFF.floor,data.price-1)})}>{I.minus()}</div>
   <div className="display mono" style={{fontSize:46,fontWeight:600,minWidth:160,textAlign:'center'}}>S/ {data.price}<span style={{color:'var(--ink-subtle)'}}>.00</span></div>
   <div className="iconbtn" style={{width:50,height:50,borderRadius:16,background:'var(--accent)',color:'var(--on-accent)',border:'none'}} onClick={()=>set({price:data.price+1})}>{I.plus()}</div></div>
  <p className="subtle" style={{textAlign:'center',fontSize:13,marginBottom:4}}>Sugerido <span className="mono" style={{color:'var(--ink-muted)'}}>S/ {lo} – {hi}</span> · mínimo <span className="mono">S/ {TARIFF.floor}</span></p>
  {data.price<=TARIFF.floor&&<p style={{textAlign:'center',fontSize:12,color:'var(--warn)',marginBottom:8}}>Es la tarifa mínima para esta zona.</p>}
  <p className="subtle" style={{textAlign:'center',fontSize:11.5,marginBottom:14,lineHeight:1.4}}>Peajes y tasas de aeropuerto se pagan aparte.</p>
  <label className="fieldlabel">Solicitudes para el conductor</label>
  <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:14}}>{reqs.map(r=>(<button key={r[0]} onClick={()=>toggle(r[0])} className="pill" style={{cursor:'pointer',borderColor:sel.includes(r[0])?'var(--accent)':'var(--border)',color:sel.includes(r[0])?'var(--accent)':'var(--ink)',background:sel.includes(r[0])?'rgba(200,242,48,.08)':'var(--surface2)'}}>{sel.includes(r[0])&&I.check()}{r[1]}</button>))}</div>
  <div className="subtle" style={{fontSize:11.5,marginBottom:14,display:'flex',gap:7,alignItems:'flex-start'}}><span style={{marginTop:1}}>{I.eye()}</span>El conductor verá tus solicitudes antes de aceptar.</div>
  </div>
  <button className="btn btn-accent" onClick={()=>go('offers')}>Buscar conductor · S/ {data.price}.00</button></div></div>);
}

const Offers=({go,back,data})=>{const list=[{n:'Khalid Ríos',r:'4.97',car:'Toyota Yaris · Plomo',eta:'4 min',p:data.price,a:true},{n:'José Pérez',r:'4.88',car:'Kia Rio · Blanco',eta:'2 min',p:data.price+3,a:false},{n:'Marko Vega',r:'4.99',car:'Moto Honda · Rojo',eta:'3 min',p:data.price,a:true}];
 return(<div className="screen"><Bar/><MapCanvas mode="route" dim/>
  <div className="pad" style={{position:'absolute',top:60,zIndex:20}}><div className="iconbtn" onClick={back} style={{boxShadow:'0 8px 24px rgba(0,0,0,.5)'}}>{I.arrowL()}</div></div>
  <div className="bsheet" style={{maxHeight:'76%'}}>
   <div className="grabber" style={{marginBottom:14}}/>
   <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}><h3 className="display" style={{fontSize:19}}>3 conductores respondieron</h3><span className="pill"><span className="radar dot" style={{background:'var(--accent)'}}/>En vivo</span></div>
   <p className="subtle" style={{fontSize:13,marginBottom:14}}>Tu oferta: <span className="mono" style={{color:'var(--ink-muted)'}}>S/ {data.price}.00</span> · elige por precio, rating o llegada. <span style={{color:'var(--ink-subtle)',cursor:'pointer'}} onClick={()=>go('nooffers')}>· sin respuestas (demo)</span></p>
   <div style={{display:'flex',flexDirection:'column',gap:10}}>{list.map((o,k)=>(<div key={k} className="card" style={{padding:13,display:'flex',gap:12,alignItems:'center',borderColor:o.a?'rgba(200,242,48,.35)':'var(--border)'}}>
    <div className="ph-img" style={{width:48,height:48,borderRadius:14,flex:'none'}}><span className="lbl" style={{fontSize:7}}>foto</span></div>
    <div style={{flex:1,minWidth:0}}><div style={{display:'flex',alignItems:'center',gap:6}}><span style={{fontWeight:700,fontSize:15,whiteSpace:'nowrap'}}>{o.n}</span><span style={{color:'var(--warn)',display:'flex',alignItems:'center',gap:2,fontSize:12}}>{I.star(1)}{o.r}</span></div><div className="subtle" style={{fontSize:12,whiteSpace:'nowrap'}}>{o.car}</div><div style={{fontSize:12,marginTop:3,color:o.a?'var(--success)':'var(--ink-muted)',fontWeight:600}}>{o.a?'Acepta tu precio':'Propone otro'} · llega en {o.eta}</div></div>
    <div style={{textAlign:'right',flex:'none'}}><div className="mono" style={{fontWeight:700,fontSize:17,color:o.a?'var(--accent)':'var(--ink)'}}>S/ {o.p}.00</div><button className="btn-accent" style={{marginTop:6,fontSize:12,fontWeight:700,border:'none',borderRadius:9,padding:'7px 14px',cursor:'pointer'}} onClick={()=>o.a?go('trip'):go('counter')}>{o.a?'Elegir':'Ver'}</button></div></div>))}</div>
  </div></div>);
};

function Counter({go,back,data,set}){const driverPrice=data.price+3;
 return(<div className="screen"><Bar/><MapCanvas mode="route" dim/>
  <div className="pad" style={{position:'absolute',top:60,zIndex:20}}><div className="iconbtn" onClick={back} style={{boxShadow:'0 8px 24px rgba(0,0,0,.5)'}}>{I.arrowL()}</div></div>
  <div className="bsheet" style={{maxHeight:'70%'}}>
   <div className="grabber" style={{marginBottom:14}}/>
   <div className="card" style={{padding:14,display:'flex',gap:14,alignItems:'center',marginBottom:14}}>
    <div className="ph-img" style={{width:52,height:52,borderRadius:14,flex:'none'}}><span className="lbl" style={{fontSize:7}}>foto</span></div>
    <div style={{flex:1}}><div style={{display:'flex',alignItems:'center',gap:6}}><span style={{fontWeight:700,fontSize:15}}>José Pérez</span><span style={{color:'var(--warn)',display:'flex',alignItems:'center',gap:2,fontSize:12}}>{I.star(1)}4.88</span></div><div className="subtle" style={{fontSize:12}}>Kia Rio · Blanco · llega en 2 min</div></div></div>
   <div className="card" style={{padding:'14px 16px',marginBottom:14,background:'var(--surface2)'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'4px 0'}}><span className="muted" style={{fontSize:13}}>Tu oferta</span><span className="mono subtle" style={{fontSize:15,textDecoration:'line-through'}}>S/ {data.price}.00</span></div>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'4px 0'}}><span style={{fontSize:14,fontWeight:600}}>Contraoferta del conductor</span><span className="mono" style={{fontSize:22,fontWeight:700,color:'var(--accent)'}}>S/ {driverPrice}.00</span></div>
   </div>
   <button className="btn btn-accent" onClick={()=>{set({price:driverPrice});go('trip');}}>Aceptar S/ {driverPrice}.00</button>
   <div style={{display:'flex',gap:10,marginTop:10}}><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>back()}>Esperar otra oferta</button><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>go('offer',true)}>Re-ofertar</button></div>
  </div></div>);
}

function NoOffers({go,back,data,set}){
 return(<div className="screen"><Bar/><MapCanvas mode="route" dim/>
  <div className="pad" style={{position:'absolute',top:60,zIndex:20}}><div className="iconbtn" onClick={back} style={{boxShadow:'0 8px 24px rgba(0,0,0,.5)'}}>{I.arrowL()}</div></div>
  <div className="bsheet" style={{maxHeight:'62%'}}>
   <div className="grabber" style={{marginBottom:16}}/>
   <div style={{textAlign:'center',padding:'6px 0 10px'}}><div style={{width:64,height:64,borderRadius:'50%',background:'var(--surface2)',border:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px',color:'var(--ink-muted)'}}>{I.clock()}</div>
    <h3 className="display" style={{fontSize:20}}>Ningún conductor aceptó aún</h3>
    <p className="muted" style={{fontSize:14,marginTop:8,lineHeight:1.5}}>A esta hora hay poca oferta para <span className="mono">S/ {data.price}.00</span>. Sube un poco tu tarifa para que más conductores la vean.</p></div>
   <button className="btn btn-accent" onClick={()=>{set({price:data.price+3});go('offers',true);}}>Subir a S/ {data.price+3}.00 y reintentar</button>
   <div style={{display:'flex',gap:10,marginTop:10}}><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>go('offers',true)}>Seguir esperando</button><button className="btn btn-ghost btn-sm" style={{flex:1}} onClick={()=>go('home')}>Cancelar</button></div>
  </div></div>);
}

function Trip({go,reset,data}){
 const [phase,setPhase]=useState('searching');const [carT,setCarT]=useState(0.12);
 useEffect(()=>{const a=setTimeout(()=>setPhase('arriving'),2200);const b=setTimeout(()=>setPhase('inprogress'),6000);return()=>{clearTimeout(a);clearTimeout(b);};},[]);
 useEffect(()=>{if(phase==='searching')return;const iv=setInterval(()=>setCarT(t=>Math.min(t+0.02,0.96)),150);return()=>clearInterval(iv);},[phase]);
 const live=phase==='arriving'||phase==='inprogress';
 return(<div className="screen"><Bar/><MapCanvas mode={phase==='searching'?'route':'trip'} carT={carT}/>
  <div className="pad" style={{position:'absolute',top:60,left:0,right:0,zIndex:25,display:'flex',justifyContent:'space-between'}}>
   <div className="iconbtn" onClick={()=>go('chat')} style={{position:'relative',background:'var(--surface)',boxShadow:'0 8px 20px rgba(0,0,0,.5)'}}>{I.chat()}<span style={{position:'absolute',top:-4,right:-4,width:16,height:16,borderRadius:'50%',background:'var(--accent)',color:'var(--on-accent)',fontSize:10,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center'}}>1</span></div>
   {live&&<span className="pill" style={{background:'var(--surface)'}}><span className="dot" style={{background:'var(--success)',boxShadow:'0 0 8px var(--success)'}}/>EN VIVO</span>}
   <div className="iconbtn" onClick={()=>go('panic')} style={{background:'var(--danger)',border:'none',color:'#fff',boxShadow:'0 8px 26px rgba(255,59,48,.4)'}}><span style={{fontWeight:800,fontSize:14,fontFamily:'var(--font-display)'}}>SOS</span></div></div>
  <div className="bsheet">
   <div className="grabber" style={{marginBottom:14}}/>
   <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}><span className="pill" style={{borderColor:phase==='inprogress'?'rgba(52,211,153,.4)':'var(--accent)'}}><span className="dot" style={{background:phase==='inprogress'?'var(--success)':phase==='searching'?'var(--ink-muted)':'var(--accent)'}}/>{phase==='searching'?'Buscando conductor':phase==='arriving'?'En camino · 3 min':'En viaje'}</span><span className="mono muted" style={{fontSize:13,whiteSpace:'nowrap'}}>Tarifa <b style={{color:'var(--ink)'}}>S/ {data.price}.00</b></span></div>
   {phase==='searching'?<div style={{display:'flex',alignItems:'center',gap:16,padding:'4px 0 16px'}}><div className="radar" style={{width:48,height:48,borderRadius:'50%',background:'var(--surface2)',display:'flex',alignItems:'center',justifyContent:'center',flex:'none',color:'var(--accent)'}}>{I.pin()}</div><div><div style={{fontWeight:600,fontSize:16}}>Conectando con Khalid…</div><div className="subtle" style={{fontSize:13,marginTop:3}}>Confirmando tu viaje.</div></div></div>:<Driver onCall={()=>go('chat')} onChat={()=>go('chat')}/>}
   {phase==='inprogress'&&<div className="card" style={{padding:'12px 14px',marginBottom:12,background:'var(--surface2)',cursor:'pointer'}} onClick={()=>go('cameralive')}>
    <div style={{display:'flex',alignItems:'center',gap:12}}><div style={{color:'var(--accent)'}}>{I.eye()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>Cámara de seguridad VEO</div><div className="subtle" style={{fontSize:12}}>Siempre activa · toca para ver</div></div><span className="pill" style={{height:26,padding:'0 9px',background:'rgba(255,59,48,.12)',borderColor:'rgba(255,59,48,.4)',color:'var(--danger)'}}><span className="dot" style={{background:'var(--danger)'}}/>REC</span></div></div>}
   <div style={{display:'flex',gap:10,marginBottom:10}}><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>go('changedest')}>{I.route()} Cambiar destino</button><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>go('share')}>{I.share()} Compartir</button></div>
   {phase==='inprogress'?<button className="btn btn-accent btn-sm" onClick={()=>go('payment')}>Finalizar viaje</button>:<button className="btn btn-ghost btn-sm" onClick={()=>reset('home')}>Cancelar viaje</button>}
   {phase!=='inprogress'&&<div className="subtle" style={{textAlign:'center',fontSize:11.5,marginTop:8,cursor:'pointer'}} onClick={()=>go('reassign')}>Simular: el conductor canceló (demo)</div>}
  </div></div>);
}

function Reassign({go,reset}){const [done,setDone]=useState(false);
 useEffect(()=>{const t=setTimeout(()=>setDone(true),2600);return()=>clearTimeout(t);},[]);
 return(<div className="screen"><Bar/><MapCanvas mode="route" dim/>
  <div className="bsheet" style={{textAlign:'center',paddingTop:24,paddingBottom:34}}>
   <div className="grabber" style={{marginBottom:18}}/>
   {!done?<><div className="radar" style={{width:60,height:60,borderRadius:'50%',background:'var(--surface2)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px',color:'var(--accent)'}}>{I.pin()}</div>
    <h3 className="display" style={{fontSize:20}}>Tu conductor canceló</h3>
    <p className="muted" style={{fontSize:14,marginTop:8,lineHeight:1.5}}>No te preocupes — estamos buscando otro conductor al mismo precio <span className="mono">S/ 22.00</span>. Sin cargo para ti.</p></>
   :<><div style={{width:60,height:60,borderRadius:'50%',background:'rgba(52,211,153,.14)',border:'1px solid rgba(52,211,153,.4)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 16px',color:'var(--success)'}}>{I.check()}</div>
    <h3 className="display" style={{fontSize:20}}>¡Nuevo conductor asignado!</h3>
    <p className="muted" style={{fontSize:14,marginTop:8}}>Marko Vega llega en 3 min, misma tarifa.</p>
    <button className="btn btn-accent" style={{marginTop:18}} onClick={()=>go('trip',true)}>Ver mi viaje</button></>}
   {!done&&<button className="btn btn-ghost btn-sm" style={{marginTop:16}} onClick={()=>reset('home')}>Cancelar y volver</button>}
  </div></div>);
}

function ChangeDest({back,data,notify,set}){const [mode,setMode]=useState('dest');
 const extra=mode==='dest'?5.5:3.0; const newP=(data.price+extra);
 return(<div className="screen"><Bar/><MapCanvas mode="route"/>
 <div className="pad" style={{position:'absolute',top:60,left:0,right:0,zIndex:20,display:'flex',alignItems:'center',gap:12}}><div className="iconbtn" onClick={back} style={{boxShadow:'0 8px 24px rgba(0,0,0,.5)'}}>{I.arrowL()}</div><span className="pill" style={{background:'var(--surface)'}}><span style={{color:'var(--accent)'}}>{I.route()}</span>Modificar viaje</span></div>
 <div className="bsheet" style={{maxHeight:'78%'}}>
  <div className="grabber" style={{marginBottom:14}}/>
  <div className="seg" style={{marginBottom:14}}><button className={mode==='dest'?'on':''} onClick={()=>setMode('dest')}>Cambiar destino</button><button className={mode==='stop'?'on':''} onClick={()=>setMode('stop')}>Agregar parada</button></div>
  <div className="card" style={{padding:'8px 16px',marginBottom:14,background:'var(--surface2)'}}>
   <div style={{display:'flex',alignItems:'center',gap:12,padding:'8px 0',borderBottom:'1px solid var(--border)'}}><span style={{width:10,height:10,borderRadius:'50%',border:'2px solid var(--accent)'}}/><span style={{fontSize:14}}>Av. Pardo y Aliaga</span></div>
   {mode==='stop'&&<div style={{display:'flex',alignItems:'center',gap:12,padding:'8px 0',borderBottom:'1px solid var(--border)'}}><span style={{width:10,height:10,borderRadius:3,border:'2px solid var(--ink-muted)'}}/><span style={{fontSize:14,flex:1}}>Parada · Óvalo Gutiérrez</span><span className="badge-eco" style={{background:'var(--surface3)',color:'var(--ink-muted)'}}>NUEVA</span></div>}
   <div style={{display:'flex',alignItems:'center',gap:12,padding:'8px 0'}}><span style={{color:'var(--accent)'}}>{I.pin()}</span><span style={{fontSize:14}}>{mode==='dest'?'Larcomar, Miraflores':'Jockey Plaza, Surco'}</span><span className="badge-eco" style={{marginLeft:'auto'}}>{mode==='dest'?'NUEVO':'IGUAL'}</span></div></div>
  <div className="card" style={{padding:'12px 14px',marginBottom:14,display:'flex',alignItems:'center',justifyContent:'space-between'}}><div><div style={{fontWeight:600,fontSize:14}}>Tarifa actualizada</div><div className="subtle" style={{fontSize:12}}>{mode==='dest'?'+4.1 km · +9 min':'+1 parada · +6 min'}</div></div><div style={{textAlign:'right'}}><span className="mono subtle" style={{fontSize:13,textDecoration:'line-through'}}>S/ {data.price}.00</span><div className="mono" style={{fontSize:18,fontWeight:700}}>S/ {newP.toFixed(2)}</div></div></div>
  <div className="card" style={{padding:'13px 14px',marginBottom:14,display:'flex',gap:11,alignItems:'flex-start',background:'rgba(200,242,48,.06)',borderColor:'rgba(200,242,48,.3)'}}><span style={{color:'var(--accent)',marginTop:1}}>{I.child()}</span><div style={{flex:1}}><div style={{fontWeight:600,fontSize:13,marginBottom:8}}>Modo niño activo · ingresa el código</div><div className="field mono" style={{height:48,letterSpacing:'.5em',fontSize:20}}>● ● ● ●</div><div className="subtle" style={{fontSize:11.5,marginTop:7}}>El conductor debe aceptar el cambio. Queda auditado.</div></div></div>
  <button className="btn btn-accent" onClick={()=>{set&&set({price:newP});notify&&notify(mode==='dest'?'Cambio enviado · esperando al conductor':'Parada enviada · esperando al conductor');back();}}>{mode==='dest'?'Confirmar nuevo destino':'Confirmar parada'} · S/ {newP.toFixed(2)}</button>
  <button className="btn btn-ghost btn-sm" style={{marginTop:6}} onClick={back}>Cancelar</button></div></div>);
}

const CameraLive=({go,back})=>(<div className="screen" style={{background:'#0b0d11'}}><Bar/>
 <div className="ph-img" style={{position:'absolute',inset:0}}><span className="lbl" style={{left:'50%',bottom:'48%',transform:'translateX(-50%)'}}>cabina · video en vivo</span></div>
 <div style={{position:'absolute',inset:0,background:'linear-gradient(180deg,rgba(10,11,14,.7),transparent 24%,transparent 52%,rgba(10,11,14,.96))'}}/>
 <div className="pad" style={{position:'absolute',top:58,left:0,right:0,zIndex:5,display:'flex',alignItems:'center',justifyContent:'space-between'}}><div className="iconbtn" onClick={back} style={{background:'var(--surface)'}}>{I.arrowL()}</div><span className="pill" style={{background:'rgba(255,59,48,.16)',borderColor:'rgba(255,59,48,.5)',color:'var(--danger)'}}><span className="dot" style={{background:'var(--danger)'}}/>REC · EN VIVO</span></div>
 <div style={{position:'absolute',left:0,right:0,bottom:0,padding:'0 22px 30px',zIndex:5}}>
  <div className="card" style={{padding:'14px 16px',marginBottom:12,background:'rgba(28,32,39,.9)'}}><div style={{display:'flex',alignItems:'center',gap:12}}><div style={{color:'var(--accent)'}}>{I.cam()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>Cámara de tu viaje</div><div className="subtle" style={{fontSize:12}}>Cifrada de extremo a extremo</div></div><span className="pill" style={{height:26,padding:'0 10px',fontSize:12,borderColor:'rgba(52,211,153,.4)',color:'var(--success)'}}><span className="dot" style={{background:'var(--success)'}}/>Analizando</span></div>
   <div style={{display:'flex',alignItems:'center',gap:8,marginTop:12,paddingTop:12,borderTop:'1px solid var(--border)'}}><span className="subtle" style={{fontSize:12,flex:1}}>Viendo ahora: <b style={{color:'var(--ink)'}}>Tú</b> y <b style={{color:'var(--ink)'}}>Mamá</b></span></div></div>
  <button className="btn btn-surface btn-sm" onClick={()=>go('cameractrl')}>{I.users()} Control de cámara · ¿quién puede ver?</button></div></div>);

function CameraControl({back,notify}){const [m,setM]=useState(true);const [c,setC]=useState([true,false]);
 return(<div className="screen"><Bar/><Header title="Control de cámara" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <p className="muted" style={{fontSize:14,marginBottom:16,lineHeight:1.45}}>Por seguridad, <b style={{color:'var(--ink)'}}>tú decides</b> quién ve la cámara de tu viaje. Nadie más puede acceder.</p>
   <div className="card" style={{padding:'15px 16px',display:'flex',alignItems:'center',gap:14,marginBottom:12}}><div className="leadcircle" style={{color:'var(--accent)'}}>{I.cam()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>Compartir cámara con mi familia</div><div className="subtle" style={{fontSize:12}}>Tus contactos verificados la ven en vivo</div></div><Toggle on={m} onClick={()=>setM(!m)}/></div>
   <div className="fieldlabel">¿Quién puede ver?</div>
   <div className="card" style={{padding:'2px 16px',marginBottom:14,opacity:m?1:.4}}>{[['Rosa Salas','Mamá · verificada'],['Diego Salas','Hermano · verificado']].map((p,k)=>(<div key={k} className="listrow"><div className="leadcircle">{I.users()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>{p[0]}</div><div className="subtle" style={{fontSize:12}}>{p[1]}</div></div><Toggle on={c[k]} onClick={()=>m&&setC(x=>x.map((v,j)=>j===k?!v:v))}/></div>))}</div>
   <div className="card" style={{padding:'13px 14px',marginBottom:14,display:'flex',gap:11,alignItems:'flex-start',background:'rgba(200,242,48,.06)',borderColor:'rgba(200,242,48,.3)'}}><span style={{color:'var(--accent)',marginTop:1}}>{I.child()}</span><div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>Control parental</div><div className="subtle" style={{fontSize:12.5,lineHeight:1.45,marginTop:3}}>Si viaja un menor, un adulto de confianza ve la cámara durante todo el viaje — aunque el menor no controle el teléfono.</div></div></div>
   <div style={{display:'flex',gap:9,alignItems:'flex-start',color:'var(--ink-subtle)',fontSize:12,lineHeight:1.45}}><span style={{marginTop:1}}>{I.lock()}</span>Grabación cifrada. El equipo de VEO solo accede con doble autorización y queda auditado.</div>
  </div>
  <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>{notify('Preferencias guardadas');back();}}>Guardar</button></div><HI/></div>);
}

function Chat({back}){const [msgs,setMsgs]=useState([{me:false,t:'Buenas, ya estoy llegando, voy en el Yaris plomo'},{me:true,t:'Gracias, te espero en la puerta principal'}]);
 return(<div className="screen"><Bar/>
  <div className="pad" style={{paddingTop:60,paddingBottom:14,display:'flex',alignItems:'center',gap:12,borderBottom:'1px solid var(--border)'}}><div className="iconbtn" onClick={back}>{I.arrowL()}</div><div className="ph-img" style={{width:38,height:38,borderRadius:'50%'}}/><div><div style={{fontWeight:600,fontSize:15}}>Khalid Ríos</div><div className="subtle" style={{fontSize:12}}>Toyota Yaris · ABC-481</div></div></div>
  <div className="pad scroll" style={{flex:1,paddingTop:18,display:'flex',flexDirection:'column',gap:10}}>{msgs.map((m,k)=>(<div key={k} style={{alignSelf:m.me?'flex-end':'flex-start',maxWidth:'78%',padding:'11px 15px',borderRadius:18,fontSize:14.5,background:m.me?'var(--accent)':'var(--surface2)',color:m.me?'var(--on-accent)':'var(--ink)',borderBottomRightRadius:m.me?5:18,borderBottomLeftRadius:m.me?18:5}}>{m.t}</div>))}</div>
  <div className="pad" style={{paddingBottom:30}}><div style={{display:'flex',gap:8,marginBottom:10}}>{['Ya salgo','Estoy en la puerta','Te espero'].map(q=><button key={q} className="pill" style={{cursor:'pointer'}} onClick={()=>setMsgs(m=>[...m,{me:true,t:q}])}>{q}</button>)}</div><div style={{display:'flex',gap:10}}><div className="field subtle" style={{flex:1}}>Escribe un mensaje…</div><div className="iconbtn" style={{width:54,height:54,background:'var(--accent)',color:'var(--on-accent)',fontSize:20,fontWeight:700}}>↑</div></div></div><HI/></div>);
}

function Panic({back}){const [sent,setSent]=useState(false);
 return(<div className="screen" style={{justifyContent:'space-between',background:'radial-gradient(80% 50% at 50% 18%, rgba(255,59,48,.14), transparent 60%), var(--bg)'}}><Bar/>
  <div className="pad" style={{paddingTop:96,textAlign:'center'}}>{!sent?<>
   <div style={{width:84,height:84,borderRadius:'50%',background:'rgba(255,59,48,.12)',border:'1px solid rgba(255,59,48,.4)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 26px',color:'var(--danger)',transform:'scale(1.3)'}}>{I.shield()}</div>
   <h1 className="display" style={{fontSize:34,color:'var(--danger)'}}>¿Necesitas ayuda?</h1>
   <p className="muted" style={{marginTop:14,fontSize:15,lineHeight:1.5}}>Enviaremos tu ubicación a nuestro equipo de seguridad y a tus contactos de confianza.</p>
   <div className="card" style={{marginTop:24,padding:14,textAlign:'left',display:'flex',gap:11,alignItems:'flex-start'}}><span style={{color:'var(--ink-muted)',marginTop:1}}>{I.shield()}</span><span className="subtle" style={{fontSize:13,lineHeight:1.45}}>También puedes activar la alerta presionando <b style={{color:'var(--ink-muted)'}}>3 veces el botón de volumen</b>, sin tocar la pantalla.</span></div></>
  :<><div style={{width:84,height:84,borderRadius:'50%',background:'rgba(52,211,153,.14)',border:'1px solid rgba(52,211,153,.4)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 26px',color:'var(--success)',transform:'scale(1.3)'}}>{I.check()}</div><h1 className="display" style={{fontSize:32,color:'var(--success)'}}>Alerta enviada</h1><p className="muted" style={{marginTop:14,fontSize:15}}>Estamos contigo. Mantén la calma.</p><div className="card" style={{marginTop:24,padding:16}}><div className="fieldlabel" style={{marginBottom:6}}>ID de alerta</div><div className="mono" style={{fontSize:17,letterSpacing:'.06em'}}>PNC-7F3A-2026</div></div></>}</div>
  <div className="pad" style={{paddingBottom:34}}>{!sent?<><button className="btn btn-danger" onClick={()=>setSent(true)}>Enviar alerta</button><button className="btn btn-ghost btn-sm" style={{marginTop:6}} onClick={back}>Cerrar</button></>:<button className="btn btn-surface" onClick={back}>Volver al viaje</button>}</div><HI/></div>);
}

function Payment({go,back,data,set}){
 const [paying,setPaying]=useState(false);const [done,setDone]=useState(false);const [fail,setFail]=useState(false);
 const ms=[{id:'card',t:'Tarjeta',s:'Visa · Mastercard'},{id:'yape',t:'Yape',s:'Pago con QR'},{id:'plin',t:'Plin',s:'Pago con QR'},{id:'cash',t:'Efectivo',s:'Paga al bajar'}];
 const total=(data.price+data.tip).toFixed(2);
 if(fail)return(<div className="screen" style={{justifyContent:'space-between'}}><Bar/>
  <div className="pad" style={{paddingTop:120,textAlign:'center',flex:1}}><div style={{width:88,height:88,borderRadius:'50%',background:'rgba(255,59,48,.12)',border:'1px solid rgba(255,59,48,.4)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 26px',color:'var(--danger)',transform:'scale(1.3)'}}>{I.x()}</div><h1 className="display" style={{fontSize:30}}>Pago rechazado</h1><p className="muted" style={{marginTop:12,fontSize:15,lineHeight:1.5}}>Tu banco no autorizó el cobro de <b className="mono" style={{color:'var(--ink)'}}>S/ {total}</b>. No se realizó ningún cargo.</p><div className="card" style={{marginTop:20,padding:'12px 14px',display:'flex',gap:10,alignItems:'flex-start',textAlign:'left'}}><span style={{color:'var(--ink-muted)',marginTop:1}}>{I.lock()}</span><span className="subtle" style={{fontSize:12.5,lineHeight:1.45}}>Código: <span className="mono">card_declined</span>. Prueba otra tarjeta o paga con Yape/efectivo.</span></div></div>
  <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>setFail(false)}>Reintentar</button><button className="btn btn-ghost btn-sm" style={{marginTop:6}} onClick={()=>{setFail(false);set({method:'yape'});}}>Cambiar método de pago</button></div><HI/></div>);
 if(done)return(<div className="screen" style={{justifyContent:'space-between'}}><Bar/>
  <div className="pad" style={{paddingTop:120,textAlign:'center',flex:1}}><div style={{width:88,height:88,borderRadius:'50%',background:'rgba(52,211,153,.14)',border:'1px solid rgba(52,211,153,.4)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 26px',color:'var(--success)',transform:'scale(1.4)'}}>{I.check()}</div><h1 className="display" style={{fontSize:34}}>{data.method==='cash'?'Paga en efectivo':'¡Pago realizado!'}</h1><p className="muted" style={{marginTop:12,fontSize:15}}>{data.method==='cash'?<>Entrega <b className="mono" style={{color:'var(--ink)'}}>S/ {total}</b> al conductor. Él confirma al recibir.</>:<>Se cobró <b className="mono" style={{color:'var(--ink)'}}>S/ {total}</b> · {ms.find(m=>m.id===data.method).t}</>}</p>{data.method==='cash'&&<div className="card" style={{marginTop:16,padding:'12px 14px',display:'flex',gap:10,alignItems:'flex-start',textAlign:'left',background:'var(--surface2)'}}><span style={{color:'var(--accent)',marginTop:1}}>{I.shield()}</span><span className="subtle" style={{fontSize:12.5,lineHeight:1.45}}>¿Sin cambio exacto? Avísale al conductor; también puedes pagar la diferencia con Yape.</span></div>}<div className="card" style={{marginTop:16,padding:16,textAlign:'left'}}><div style={{display:'flex',justifyContent:'space-between',padding:'4px 0'}}><span className="muted">Tarifa acordada</span><span className="mono">S/ {data.price}.00</span></div><div style={{display:'flex',justifyContent:'space-between',padding:'4px 0'}}><span className="muted">Propina</span><span className="mono">S/ {data.tip}.00</span></div><div style={{height:1,background:'var(--border)',margin:'8px 0'}}/><div style={{display:'flex',justifyContent:'space-between',padding:'4px 0',fontWeight:700}}><span>Total</span><span className="mono">S/ {total}</span></div></div></div>
  <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>go('rating')}>Calificar viaje</button></div><HI/></div>);
 return(<div className="screen"><Bar/><Header title="Pagar viaje" onX={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <div className="card" style={{padding:'18px',textAlign:'center',marginBottom:16,background:'radial-gradient(80% 90% at 50% 0%, rgba(200,242,48,.07), transparent), var(--surface)'}}><div className="fieldlabel" style={{marginBottom:6}}>Monto a pagar</div><div className="display mono" style={{fontSize:42,fontWeight:600}}>S/ {total}</div></div>
   <div style={{display:'flex',flexDirection:'column',gap:9,marginBottom:16}}>{ms.map(m=>(<div key={m.id} className={'vehrow'+(data.method===m.id?' sel':'')} style={{padding:'12px 14px'}} onClick={()=>set({method:m.id})}><div className="leadcircle" style={{color:data.method===m.id?'var(--accent)':'var(--ink-muted)'}}>{m.id==='card'?<span style={{color:data.method===m.id?'var(--accent)':'var(--ink-muted)'}}>{I.card()}</span>:m.id==='cash'?'S/':m.t[0]}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>{m.t}</div><div className="subtle" style={{fontSize:12}}>{m.s}</div></div><span style={{width:20,height:20,borderRadius:'50%',border:'2px solid '+(data.method===m.id?'var(--accent)':'var(--border-strong)'),display:'flex',alignItems:'center',justifyContent:'center'}}>{data.method===m.id&&<span style={{width:10,height:10,borderRadius:'50%',background:'var(--accent)'}}/>}</span></div>))}</div>
   {data.method==='card'&&<div className="card" style={{padding:16,marginBottom:16}}><button className="btn btn-light btn-sm" style={{marginBottom:14,background:'#fff'}}>Pagar con  Pay</button><label className="fieldlabel">Información de la tarjeta</label><div style={{border:'1.5px solid var(--border)',borderRadius:12,overflow:'hidden'}}><div style={{display:'flex',alignItems:'center',padding:'0 14px',height:48,borderBottom:'1px solid var(--border)'}}><span className="mono subtle" style={{flex:1}}>1234 1234 1234 1234</span><span style={{color:'var(--ink-subtle)'}}>{I.card()}</span></div><div style={{display:'flex'}}><div className="mono subtle" style={{height:48,padding:'0 14px',flex:1,borderRight:'1px solid var(--border)',display:'flex',alignItems:'center'}}>MM / AA</div><div className="mono subtle" style={{height:48,padding:'0 14px',flex:1,display:'flex',alignItems:'center'}}>CVC</div></div></div><div style={{display:'flex',alignItems:'center',gap:7,marginTop:12,color:'var(--ink-subtle)',fontSize:11.5}}>{I.lock()} Pagos cifrados · procesado por <b style={{color:'var(--ink-muted)'}}>Stripe</b></div></div>}
   {(data.method==='yape'||data.method==='plin')&&<div className="card" style={{padding:24,textAlign:'center',marginBottom:16}}><div className="ph-img" style={{width:160,height:160,borderRadius:16,margin:'0 auto 12px',display:'flex',alignItems:'center',justifyContent:'center'}}><span className="mono subtle" style={{fontSize:11}}>QR {data.method.toUpperCase()}</span></div><p className="subtle" style={{fontSize:13}}>Escanea con tu app de {data.method==='yape'?'Yape':'Plin'} para pagar S/ {total}.</p></div>}
   <label className="fieldlabel">Propina (opcional · 100% al conductor)</label>
   <div className="seg" style={{marginBottom:8}}>{[0,2,3,5].map(v=><button key={v} className={data.tip===v?'on':''} onClick={()=>set({tip:v})}>{v===0?'Sin propina':'S/ '+v}</button>)}</div>
  </div>
  <div className="pad" style={{paddingBottom:30,paddingTop:8}}><button className="btn btn-accent" disabled={paying} onClick={()=>{setPaying(true);setTimeout(()=>{setPaying(false);setDone(true);},1500);}}>{paying?(data.method==='yape'||data.method==='plin'?'Esperando confirmación del banco…':'Procesando…'):data.method==='cash'?'Confirmar efectivo':(data.method==='yape'||data.method==='plin')?`Ya pagué con ${data.method==='yape'?'Yape':'Plin'}`:`Pagar S/ ${total}`}</button>{data.method==='card'&&!paying&&<div className="subtle" style={{textAlign:'center',fontSize:11.5,marginTop:8,cursor:'pointer'}} onClick={()=>setFail(true)}>Simular tarjeta rechazada (demo)</div>}</div><HI/></div>);
}

function Rating({reset}){const [r,setR]=useState(0);const [sent,setSent]=useState(false);const [why,setWhy]=useState([]);
 const reasons=['Conducción brusca','Llegó tarde','Vehículo sucio','Trato','Ruta no óptima','Cobró de más'];
 const toggle=(x)=>setWhy(w=>w.includes(x)?w.filter(y=>y!==x):[...w,x]);
 return(<div className="screen" style={{justifyContent:'space-between'}}><Bar/>
  {!sent?<div className="pad scroll" style={{paddingTop:70,textAlign:'center',flex:1}}><div className="ph-img" style={{width:88,height:88,borderRadius:'50%',margin:'0 auto 16px'}}/><h1 className="display" style={{fontSize:26}}>¿Cómo estuvo tu viaje<br/>con Khalid?</h1><p className="muted" style={{marginTop:8,fontSize:15}}>Tu opinión mantiene a VEO seguro.</p><div style={{display:'flex',justifyContent:'center',gap:14,margin:'26px 0 18px'}}>{[1,2,3,4,5].map(n=><button key={n} onClick={()=>setR(n)} style={{background:'none',border:'none',cursor:'pointer',transform:'scale(2.2)',color:n<=r?'var(--warn)':'var(--border-strong)'}}>{I.star(n<=r)}</button>)}</div>
   {r>0&&r<5&&<div style={{textAlign:'left',marginBottom:14}}><div className="fieldlabel">¿Qué se puede mejorar?</div><div style={{display:'flex',flexWrap:'wrap',gap:8}}>{reasons.map(x=>(<button key={x} onClick={()=>toggle(x)} className="pill" style={{cursor:'pointer',borderColor:why.includes(x)?'var(--accent)':'var(--border)',color:why.includes(x)?'var(--accent)':'var(--ink)',background:why.includes(x)?'rgba(200,242,48,.08)':'var(--surface2)'}}>{why.includes(x)&&I.check()}{x}</button>))}</div></div>}
   {r===5&&<div style={{display:'flex',flexWrap:'wrap',gap:8,justifyContent:'center',marginBottom:14}}>{['Excelente trato','Muy puntual','Conducción segura'].map(x=>(<button key={x} onClick={()=>toggle(x)} className="pill" style={{cursor:'pointer',borderColor:why.includes(x)?'var(--accent)':'var(--border)',color:why.includes(x)?'var(--accent)':'var(--ink)',background:why.includes(x)?'rgba(200,242,48,.08)':'var(--surface2)'}}>{why.includes(x)&&I.check()}{x}</button>))}</div>}
   <div className="field subtle" style={{height:72,alignItems:'flex-start',paddingTop:14}}>Cuéntanos más (opcional)…</div></div>
  :<div className="pad" style={{paddingTop:130,textAlign:'center',flex:1}}><div style={{width:88,height:88,borderRadius:'50%',background:'rgba(52,211,153,.14)',border:'1px solid rgba(52,211,153,.4)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 26px',color:'var(--success)',transform:'scale(1.4)'}}>{I.check()}</div><h1 className="display" style={{fontSize:32}}>¡Gracias!</h1><p className="muted" style={{marginTop:12,fontSize:15}}>Nos vemos en tu próximo viaje seguro.</p></div>}
  <div className="pad" style={{paddingBottom:34}}>{!sent?<><button className="btn btn-accent" disabled={!r} onClick={()=>setSent(true)}>Enviar</button><button className="btn btn-ghost btn-sm" style={{marginTop:6}} onClick={()=>reset('home')}>Omitir</button></>:<button className="btn btn-accent" onClick={()=>reset('home')}>Volver al inicio</button>}</div><HI/></div>);
}

/* ----- Profile hub + sub-screens ----- */
const Profile=({go,reset})=>(<div className="screen"><Bar/>
 <Header title="Cuenta"/>
 <div className="pad scroll" style={{flex:1,paddingBottom:100}}>
  <div style={{textAlign:'center',padding:'8px 0 18px'}}><div style={{width:88,margin:'0 auto',cursor:'pointer'}} onClick={()=>go('editprofile')}><Avatar size={88}/></div><div style={{fontWeight:700,fontSize:20,marginTop:12}}>María Fernanda</div><div className="subtle mono" style={{fontSize:13}}>+51 987 654 321</div><span className="pill" style={{marginTop:10,borderColor:'rgba(52,211,153,.4)',color:'var(--success)',cursor:'pointer'}} onClick={()=>go('kyc')}><span style={{color:'var(--success)'}}>{I.shield()}</span>Identidad verificada</span></div>
  <div className="fieldlabel" style={{textTransform:'uppercase',letterSpacing:'.1em',fontSize:11}}>Seguridad</div>
  <div className="card" style={{padding:'2px 16px',marginBottom:14}}>
   <Row icon={I.scan} title="Verificación facial" sub="Liveness propio (ONNX)" pill="Verificada" pillTone="success" onClick={()=>go('kyc')}/>
   <Row icon={I.users} title="Contactos de confianza" sub="2 de 3 · verificados" onClick={()=>go('trusted')}/>
   <Row icon={I.child} title="Modo niño" sub="Código para cambiar destino" pill="Activo" pillTone="success" onClick={()=>go('childmode')}/>
   <Row icon={I.cam} title="Control de cámara" sub="Quién ve tu cámara" onClick={()=>go('cameractrl')}/>
   <Row icon={I.share} title="Compartir mi viaje" onClick={()=>go('share')}/>
  </div>
  <div className="fieldlabel" style={{textTransform:'uppercase',letterSpacing:'.1em',fontSize:11}}>Preferencias</div>
  <div className="card" style={{padding:'2px 16px',marginBottom:14}}>
   <Row icon={I.card} title="Métodos de pago" onClick={()=>go('paymethods')}/>
   <Row icon={I.pin} title="Lugares guardados" onClick={()=>go('savedplaces')}/>
   <Row icon={I.clock} title="Viajes programados" onClick={()=>go('scheduled')}/>
   <Row icon={I.gift} title="Invita y gana" onClick={()=>go('referrals')}/>
  </div>
  <div className="fieldlabel" style={{textTransform:'uppercase',letterSpacing:'.1em',fontSize:11}}>Cuenta</div>
  <div className="card" style={{padding:'2px 16px'}}>
   <Row icon={I.help} title="Accesibilidad e idioma" onClick={()=>go('access')}/>
   <Row icon={I.help} title="Ayuda" onClick={()=>go('help')}/>
   <Row icon={I.power} title="Cerrar sesión" danger onClick={()=>go('logout')}/>
  </div>
 </div></div>);

const Trusted=({back,notify})=>(<div className="screen"><Bar/><Header title="Contactos de confianza" onBack={back} size={20}/>
 <div className="pad scroll" style={{flex:1}}>
  <p className="muted" style={{fontSize:14,marginBottom:16,lineHeight:1.45}}>Agrega hasta 3 personas que verán tus viajes y recibirán tus alertas de seguridad.</p>
  <div style={{display:'flex',flexDirection:'column',gap:10}}>{[['Rosa Salas','Mamá · +51 ··· 442','Verificado','success'],['Diego Salas','Hermano · +51 ··· 118','Pendiente','warn']].map((c,k)=>(<div key={k} className="card" style={{padding:14,display:'flex',alignItems:'center',gap:13}}><div className="leadcircle" style={{width:46,height:46}}>{I.users()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>{c[0]}</div><div className="subtle" style={{fontSize:12}}>{c[1]}</div>{c[3]==='warn'&&<div onClick={()=>notify('Código reenviado')} style={{fontSize:12,color:'var(--accent)',fontWeight:600,marginTop:4,cursor:'pointer'}}>Reenviar código</div>}</div><span className="pill" style={{height:26,padding:'0 10px',fontSize:12,borderColor:c[3]==='success'?'rgba(52,211,153,.4)':'rgba(242,175,72,.4)',color:c[3]==='success'?'var(--success)':'var(--warn)'}}><span className="dot" style={{background:c[3]==='success'?'var(--success)':'var(--warn)'}}/>{c[2]}</span></div>))}</div>
 </div>
 <div className="pad" style={{paddingBottom:34}}><button className="btn btn-surface" onClick={()=>notify('Función: agregar contacto')}>{I.plus()} Agregar contacto · 1 restante</button></div><HI/></div>);

function ChildMode({back,notify}){const [on,setOn]=useState(true);
 return(<div className="screen"><Bar/><Header title="Modo niño" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <p className="muted" style={{fontSize:14,marginBottom:18,lineHeight:1.45}}>Protege a quien viaja solo: pediremos un código para cambiar el destino durante el viaje.</p>
   <div className="card" style={{padding:'16px',display:'flex',alignItems:'center',gap:14,marginBottom:14}}><div className="leadcircle" style={{color:'var(--accent)'}}>{I.child()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>Activar modo niño</div><div className="subtle" style={{fontSize:12}}>{on?'Activo para tu próximo viaje':'Desactivado'}</div></div><Toggle on={on} onClick={()=>setOn(!on)}/></div>
   {on&&<><label className="fieldlabel">Código (4 a 6 dígitos)</label><div className="field mono" style={{letterSpacing:'.5em',fontSize:22}}>● ● ● ●</div><div className="card" style={{marginTop:14,padding:14,display:'flex',gap:11,alignItems:'flex-start',background:'var(--surface2)'}}><span style={{color:'var(--success)',marginTop:1}}>{I.shield()}</span><span className="subtle" style={{fontSize:13,lineHeight:1.45}}>El conductor <b style={{color:'var(--ink-muted)'}}>nunca ve este código</b>. Lo validamos de forma segura en el servidor.</span></div></>}
  </div>
  <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>{notify('Modo niño guardado');back();}}>Guardar</button></div><HI/></div>);
}

function Kyc({back,notify}){const [st,setSt]=useState('scan');
 return(<div className="screen" style={{background:'#0b0d11'}}><Bar/>
  <div className="ph-img" style={{position:'absolute',inset:0}}><span className="lbl" style={{left:'50%',bottom:'auto',top:14,transform:'translateX(-50%)'}}>cámara frontal</span></div>
  <div style={{position:'absolute',inset:0,background:'linear-gradient(180deg,rgba(10,11,14,.7),transparent 22%,transparent 58%,rgba(10,11,14,.92))'}}/>
  <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}><div style={{width:236,height:300,borderRadius:'50% 50% 48% 48%/55% 55% 45% 45%',border:'3px solid '+(st==='ok'?'var(--success)':'var(--accent)'),boxShadow:'0 0 40px var(--route-glow)'}}/></div>
  <div className="pad" style={{position:'absolute',top:58,left:0,right:0,display:'flex',justifyContent:'space-between',zIndex:5}}><div className="iconbtn" onClick={back} style={{background:'var(--surface)'}}>{I.arrowL()}</div>{st==='scan'&&<span className="pill" style={{background:'rgba(255,59,48,.16)',borderColor:'rgba(255,59,48,.5)',color:'var(--danger)'}}><span className="dot" style={{background:'var(--danger)'}}/>Capturando</span>}</div>
  <div style={{position:'absolute',left:0,right:0,bottom:0,padding:'0 22px 30px',zIndex:5}}>
   <div className="card" style={{padding:'14px 16px',marginBottom:16,textAlign:'center',background:'rgba(28,32,39,.85)'}}>{st==='ok'?<><div className="eyebrow" style={{color:'var(--success)',marginBottom:6}}>VERIFICADO</div><div style={{fontWeight:700,fontSize:18}}>¡Identidad confirmada!</div></>:<><div className="eyebrow" style={{color:'var(--ink-muted)',marginBottom:6}}>SIGUE LA INSTRUCCIÓN</div><div style={{fontWeight:700,fontSize:18}}>Gira la cabeza a la izquierda</div></>}</div>
   {st==='scan'?<button className="btn btn-accent" onClick={()=>setSt('ok')}>Capturar</button>:<button className="btn btn-accent" onClick={()=>{notify('Identidad verificada');back();}}>Listo</button>}
  </div><HI/></div>);
}

const PayMethods=({back})=>{const [sel,setSel]=useState('card');const ms=[['card','Tarjeta','Visa · Mastercard'],['yape','Yape','Conectado'],['plin','Plin','Conectado'],['cash','Efectivo','Paga al bajar']];
 return(<div className="screen"><Bar/><Header title="Métodos de pago" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}><p className="muted" style={{fontSize:14,marginBottom:16}}>Elige tu método preferido. Lo confirmas al pagar.</p>
   <div className="card" style={{padding:'2px 16px',marginBottom:14}}>{ms.map(m=>(<div key={m[0]} className="listrow" onClick={()=>setSel(m[0])}><div className="leadcircle" style={{color:sel===m[0]?'var(--accent)':'var(--ink-muted)'}}>{m[0]==='card'?I.card():m[0]==='cash'?'S/':m[1][0]}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>{m[1]}</div><div className="subtle" style={{fontSize:12}}>{m[2]}</div></div>{sel===m[0]?<span className="pill" style={{height:26,padding:'0 10px',fontSize:12,borderColor:'rgba(200,242,48,.4)',color:'var(--accent)'}}>Predeterminado</span>:<span style={{width:18,height:18,borderRadius:'50%',border:'2px solid var(--border-strong)'}}/>}</div>))}</div>
   <button className="btn btn-surface btn-sm">{I.plus()} Agregar tarjeta</button>
  </div><HI/></div>);
};

const SavedPlaces=({back,notify})=>(<div className="screen"><Bar/><Header title="Lugares guardados" onBack={back}/>
 <div className="pad scroll" style={{flex:1}}><p className="muted" style={{fontSize:14,marginBottom:16}}>Guarda tus lugares para pedir más rápido. Se guardan solo en este equipo.</p>
  <div className="card" style={{padding:'2px 16px',marginBottom:14}}><Row icon={I.home} title="Casa" sub="Av. Pardo 1245, Miraflores" onClick={()=>notify('Editar Casa')}/><Row icon={I.work} title="Trabajo" sub="San Isidro Financial" onClick={()=>notify('Editar Trabajo')}/></div>
  <div className="fieldlabel" style={{textTransform:'uppercase',letterSpacing:'.1em',fontSize:11}}>Favoritos</div>
  <div className="card" style={{padding:'2px 16px',marginBottom:14}}><Row icon={I.star} title="Larcomar" sub="Malecón de la Reserva 610" onClick={()=>notify('Editar favorito')}/></div>
  <button className="btn btn-surface btn-sm" onClick={()=>notify('Agregar favorito')}>{I.plus()} Agregar favorito</button>
 </div><HI/></div>);

const Scheduled=({go,back,notify})=>(<div className="screen"><Bar/><Header title="Viajes programados" onBack={back} size={20}/>
 <div className="pad scroll" style={{flex:1}}>
  <div className="card" style={{padding:16,marginBottom:12}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}><span className="pill" style={{borderColor:'var(--accent)',color:'var(--accent)'}}><span className="dot" style={{background:'var(--accent)'}}/>Mañana · 7:30 a. m.</span><span className="mono" style={{fontWeight:700}}>S/ 14.00</span></div><div className="subtle" style={{fontSize:13,marginBottom:12}}>Casa → Aeropuerto Jorge Chávez</div><button className="btn btn-surface btn-sm" onClick={()=>notify('Viaje cancelado')}>Cancelar</button></div>
 </div>
 <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>go('schedulenew')}>{I.plus()} Programar nuevo viaje</button></div><HI/></div>);

function ScheduleNew({back,notify}){const [day,setDay]=useState('Mañana');const [time,setTime]=useState('7:30 a. m.');
 return(<div className="screen"><Bar/><Header title="Programar viaje" onBack={back} size={20}/>
  <div className="pad scroll" style={{flex:1}}>
   <label className="fieldlabel">Destino</label><div className="field">Aeropuerto Jorge Chávez</div>
   <label className="fieldlabel" style={{marginTop:14}}>Día</label><div className="seg">{['Hoy','Mañana','Vie 14'].map(d=><button key={d} className={day===d?'on':''} onClick={()=>setDay(d)}>{d}</button>)}</div>
   <label className="fieldlabel" style={{marginTop:14}}>Hora</label><div className="seg">{['6:00 a. m.','7:30 a. m.','9:00 a. m.'].map(t=><button key={t} className={time===t?'on':''} onClick={()=>setTime(t)} style={{fontSize:12}}>{t}</button>)}</div>
   <div className="card" style={{marginTop:14,padding:'12px 14px',display:'flex',alignItems:'center',justifyContent:'space-between'}}><div><div style={{fontWeight:600,fontSize:14}}>Repetir</div><div className="subtle" style={{fontSize:12}}>Cada día laborable</div></div><Toggle on={false} onClick={()=>{}}/></div>
   <div className="card" style={{marginTop:12,padding:'12px 14px',display:'flex',justifyContent:'space-between'}}><span className="muted" style={{fontSize:13}}>Tarifa estimada</span><span className="mono" style={{fontWeight:700}}>~ S/ 33.00</span></div>
   <div className="subtle" style={{fontSize:11.5,marginTop:10,lineHeight:1.4}}>Te buscaremos conductor 15 min antes. La tarifa se confirma al activarse.</div>
  </div>
  <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>{notify(day+' '+time+' · viaje programado');back();}}>Programar · {day} {time}</button></div><HI/></div>);
}

function EditProfile({back,notify}){return(<div className="screen"><Bar/><Header title="Editar perfil" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <div style={{textAlign:'center',padding:'8px 0 18px'}}><div style={{position:'relative',width:96,height:96,margin:'0 auto'}}><Avatar size={96}/><div style={{position:'absolute',right:0,bottom:0,width:34,height:34,borderRadius:'50%',background:'var(--accent)',color:'var(--on-accent)',display:'flex',alignItems:'center',justifyContent:'center',border:'3px solid var(--bg)'}}>{I.cam()}</div></div><div className="subtle" style={{fontSize:12,marginTop:10}}>Toca para cambiar tu foto</div></div>
   <label className="fieldlabel">Nombre</label><input className="field" defaultValue="María Fernanda Salas"/>
   <label className="fieldlabel" style={{marginTop:14}}>Correo</label><input className="field" defaultValue="mafe@correo.com"/>
   <label className="fieldlabel" style={{marginTop:14}}>Celular</label><div className="field subtle" style={{justifyContent:'space-between'}}>+51 987 654 321 <span className="pill" style={{height:24,fontSize:11,borderColor:'rgba(52,211,153,.4)',color:'var(--success)'}}>Verificado</span></div>
  </div>
  <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>{notify('Perfil actualizado');back();}}>Guardar cambios</button></div><HI/></div>);
}

function Access({back,notify}){const [size,setSize]=useState(1);const [lang,setLang]=useState('es');const [hc,setHc]=useState(false);
 const S={es:['Tamaño de texto','Idioma','Alto contraste','Lector de pantalla','Así se verá tu app','Pide tu viaje seguro','Guardar'],en:['Text size','Language','High contrast','Screen reader','This is how your app looks','Request your safe ride','Save'],qu:['Qillqa sayaynin','Rimay','Sinchi llimphi','Qillqa ñawinchaq','Kaynam app rikukunqa','Allin puriyniykita mañakuy','Waqaychay']}[lang];
 return(<div className="screen"><Bar/><Header title="Accesibilidad e idioma" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <label className="fieldlabel">{S[0]}</label>
   <div className="seg" style={{marginBottom:6}}>{[['0.9','A'],['1','A'],['1.2','A'],['1.4','A']].map((o,i)=><button key={i} className={size===parseFloat(o[0])?'on':''} style={{fontSize:(12+i*4)+'px'}} onClick={()=>setSize(parseFloat(o[0]))}>{o[1]}</button>)}</div>
   <label className="fieldlabel" style={{marginTop:14}}>{S[1]}</label>
   <div className="seg">{[['es','Español'],['en','English'],['qu','Runa Simi']].map(o=><button key={o[0]} className={lang===o[0]?'on':''} onClick={()=>setLang(o[0])}>{o[1]}</button>)}</div>
   <div className="card" style={{padding:'14px 16px',display:'flex',alignItems:'center',gap:14,marginTop:14}}><div className="leadcircle" style={{color:'var(--accent)'}}>{I.eye()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>{S[2]}</div></div><Toggle on={hc} onClick={()=>setHc(!hc)}/></div>
   <div className="card" style={{padding:'14px 16px',display:'flex',alignItems:'center',gap:14,marginTop:10}}><div className="leadcircle" style={{color:'var(--accent)'}}>{I.help()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>{S[3]}</div><div className="subtle" style={{fontSize:12}}>VoiceOver / TalkBack</div></div><Toggle on={true} onClick={()=>{}}/></div>
   <div className="fieldlabel" style={{marginTop:18}}>{S[4]}</div>
   <div className="card" style={{padding:18,background:hc?'#000':'var(--surface)',border:hc?'2px solid #fff':'1px solid var(--border)'}}><div className="display" style={{fontSize:24*size,color:hc?'#fff':'var(--ink)'}}>{S[5]}</div><div className="btn btn-accent" style={{marginTop:14,height:48*size,fontSize:15*size}}>{S[6]}</div></div>
  </div>
  <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>{notify(lang==='en'?'Preferences saved':lang==='qu'?'Waqaychasqa':'Preferencias guardadas');back();}}>{S[6]}</button></div><HI/></div>);
}

function Help({back}){const [open,setOpen]=useState(-1);const faq=[['¿Cómo pido un viaje?','Pon tu destino, ofrece tu tarifa y elige al conductor que mejor te convenga.'],['¿Cómo funciona el pago?','Tarjeta (Stripe), Yape, Plin o efectivo. La propina es 100% para el conductor.'],['¿Qué es la cámara de cabina?','Una capa de seguridad siempre activa que graba y analiza el viaje. Tú decides quién la ve.'],['¿Cómo funciona el SOS?','El botón SOS envía tu ubicación a seguridad. También se activa con triple botón de volumen.']];
 return(<div className="screen"><Bar/><Header title="Ayuda" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <div className="card" style={{padding:'16px',marginBottom:16,display:'flex',alignItems:'center',gap:13,background:'var(--surface2)'}}><div className="leadcircle" style={{color:'var(--accent)'}}>{I.help()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>¿Necesitas ayuda?</div><div className="subtle" style={{fontSize:12}}>Reporta un problema y te respondemos.</div></div></div>
   <div className="fieldlabel" style={{textTransform:'uppercase',letterSpacing:'.1em',fontSize:11}}>Preguntas frecuentes</div>
   <div className="card" style={{padding:'2px 16px',marginBottom:16}}>{faq.map((f,k)=>(<div key={k} style={{borderBottom:k<faq.length-1?'1px solid var(--border)':'none'}}><div onClick={()=>setOpen(open===k?-1:k)} style={{display:'flex',alignItems:'center',gap:10,padding:'15px 0',cursor:'pointer'}}><span style={{flex:1,fontWeight:600,fontSize:14}}>{f[0]}</span><span className="subtle" style={{transform:open===k?'rotate(90deg)':'none',transition:'.2s'}}>{I.chevR()}</span></div>{open===k&&<p className="subtle" style={{fontSize:13,lineHeight:1.5,paddingBottom:14}}>{f[1]}</p>}</div>))}</div>
  </div>
  <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent">Reportar un problema</button></div><HI/></div>);
}

function Referrals({back,notify}){const [cop,setCop]=useState(false);
 return(<div className="screen"><Bar/><Header title="Invita y gana" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <p className="muted" style={{fontSize:14,marginBottom:16}}>Comparte tu código y ganen los dos S/ 10 en su primer viaje.</p>
   <div className="card" style={{padding:'24px 16px',textAlign:'center',marginBottom:16,background:'radial-gradient(80% 90% at 50% 0%, rgba(200,242,48,.08), transparent), var(--surface)'}}><div className="fieldlabel" style={{marginBottom:8}}>Tu código</div><div className="display" style={{fontSize:34,color:'var(--accent)',letterSpacing:'.08em'}}>MAFE-2026</div><div style={{display:'flex',gap:10,marginTop:18}}><button className="btn btn-surface btn-sm" onClick={()=>{setCop(true);notify('Código copiado');}}>{I.copy()} {cop?'¡Copiado!':'Copiar'}</button><button className="btn btn-accent btn-sm" onClick={()=>notify('Compartiendo…')}>{I.share()} Compartir</button></div></div>
   <div style={{display:'flex',gap:12}}><div className="card" style={{flex:1,padding:16,textAlign:'center'}}><div className="mono" style={{fontSize:26,fontWeight:700}}>4</div><div className="subtle" style={{fontSize:12,marginTop:2}}>Referidos</div></div><div className="card" style={{flex:1,padding:16,textAlign:'center'}}><div className="mono" style={{fontSize:26,fontWeight:700}}>S/ 40</div><div className="subtle" style={{fontSize:12,marginTop:2}}>Crédito ganado</div></div></div>
  </div><HI/></div>);
}

function History({go}){const [st,setSt]=useState('load');
 useEffect(()=>{const t=setTimeout(()=>setSt('ok'),900);return()=>clearTimeout(t);},[]);
 const rows=[['Hoy · 9:42 a. m.','Completado','13.00','success'],['Ayer · 6:15 p. m.','Completado','22.50','success'],['12 may · 8:30 a. m.','Cancelado','—','muted']];
 const sk={background:'linear-gradient(90deg,var(--surface2),var(--surface3),var(--surface2))',borderRadius:12};
 return(<div className="screen"><Bar/><Header title="Viajes"/>
 <div className="pad scroll" style={{flex:1,paddingBottom:100}}>
  {st==='load'?[1,2,3].map(k=><div key={k} style={{...sk,height:74,marginBottom:10}}/>)
  :st==='err'?<div className="card" style={{padding:'26px',textAlign:'center',marginTop:10}}><div className="leadcircle" style={{width:48,height:48,margin:'0 auto 12px',color:'var(--danger)'}}>{I.shield()}</div><div style={{fontWeight:700,fontSize:15}}>No pudimos cargar</div><div className="subtle" style={{fontSize:12,marginTop:4}}>Revisa tu conexión.</div><button className="btn btn-surface btn-sm" style={{width:'auto',padding:'0 20px',margin:'14px auto 0'}} onClick={()=>setSt('ok')}>Reintentar</button></div>
  :rows.map((t,k)=>(<div key={k} className="card" style={{padding:16,marginBottom:10,display:'flex',alignItems:'center',gap:14,cursor:'pointer'}} onClick={()=>go('tripdetail')}><div className="leadcircle" style={{color:t[3]==='muted'?'var(--ink-muted)':'var(--accent)'}}>{I.pin()}</div><div style={{flex:1}}><div style={{fontWeight:600,fontSize:15}}>Jockey Plaza, Surco</div><div className="subtle" style={{fontSize:12}}>{t[0]} · {t[1]}</div></div><div style={{textAlign:'right'}}><div className="mono" style={{fontWeight:700,fontSize:15}}>{t[2]==='—'?'—':'S/ '+t[2]}</div><span className="subtle">{I.chevR()}</span></div></div>))}
 </div></div>);
}

const TripDetail=({go,back})=>(<div className="screen"><Bar/>
 <div style={{position:'relative',height:280}}><MapCanvas mode="route"/><div className="pad" style={{position:'absolute',top:60,zIndex:20}}><div className="iconbtn" onClick={back} style={{boxShadow:'0 8px 24px rgba(0,0,0,.5)'}}>{I.arrowL()}</div></div></div>
 <div className="pad scroll" style={{flex:1,paddingTop:18}}>
  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}><h2 className="display" style={{fontSize:22}}>Viaje a Jockey Plaza</h2><span className="pill" style={{borderColor:'rgba(52,211,153,.4)',color:'var(--success)'}}><span className="dot" style={{background:'var(--success)'}}/>Completado</span></div>
  <Driver onCall={()=>{}} onChat={()=>{}}/>
  <div className="card" style={{padding:16,marginBottom:14}}><div style={{display:'flex',justifyContent:'space-between',padding:'4px 0'}}><span className="muted">Tarifa</span><span className="mono">S/ 13.00</span></div><div style={{display:'flex',justifyContent:'space-between',padding:'4px 0'}}><span className="muted">Método</span><span>Tarjeta</span></div><div style={{height:1,background:'var(--border)',margin:'8px 0'}}/><div style={{display:'flex',justifyContent:'space-between',padding:'4px 0',fontWeight:700}}><span>Total</span><span className="mono">S/ 13.00</span></div></div>
  <div style={{display:'flex',gap:10}}><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>go('invoice')}>{I.card()} Factura/Boleta</button><button className="btn btn-surface btn-sm" style={{flex:1}} onClick={()=>go('lost')}>{I.search()} Olvidé algo</button></div>
  <button className="btn btn-ghost btn-sm" style={{marginTop:8}}>{I.share()} Compartir recibo</button>
 </div><HI/></div>);

const Invoice=({back,notify})=>{const [tipo,setTipo]=useState('boleta');
 return(<div className="screen"><Bar/><Header title="Comprobante" onBack={back}/>
  <div className="pad scroll" style={{flex:1}}>
   <p className="muted" style={{fontSize:14,marginBottom:16}}>Emite tu comprobante electrónico del viaje a Jockey Plaza · S/ 13.00.</p>
   <div className="seg" style={{marginBottom:14}}>{[['boleta','Boleta'],['factura','Factura (RUC)']].map(t=><button key={t[0]} className={tipo===t[0]?'on':''} onClick={()=>setTipo(t[0])}>{t[1]}</button>)}</div>
   {tipo==='factura'?<><label className="fieldlabel">RUC</label><input className="field mono" placeholder="20 ········ 1" defaultValue="20512345671"/><label className="fieldlabel" style={{marginTop:14}}>Razón social</label><input className="field" defaultValue="Mi Empresa S.A.C."/></>:<><label className="fieldlabel">DNI</label><input className="field mono" defaultValue="71234568"/></>}
   <label className="fieldlabel" style={{marginTop:14}}>Enviar a</label><input className="field" defaultValue="mafe@correo.com"/>
   <div className="subtle" style={{fontSize:11.5,marginTop:12,display:'flex',gap:7,alignItems:'flex-start'}}><span style={{marginTop:1}}>{I.lock()}</span>Comprobante electrónico válido ante SUNAT. Llega a tu correo en minutos.</div>
  </div>
  <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>{notify(tipo==='factura'?'Factura enviada a tu correo':'Boleta enviada a tu correo');back();}}>Emitir y enviar</button></div><HI/></div>);
};
const LostItem=({back,notify})=>(<div className="screen"><Bar/><Header title="Olvidé algo" onBack={back}/>
 <div className="pad scroll" style={{flex:1}}>
  <p className="muted" style={{fontSize:14,marginBottom:16}}>Avisaremos a Khalid (Toyota Yaris · ABC-481) sobre tu objeto. También puedes contactarlo.</p>
  <label className="fieldlabel">¿Qué olvidaste?</label>
  <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:14}}>{['Celular','Billetera','Mochila','Llaves','Otro'].map((x,i)=><span key={x} className="pill" style={{borderColor:i===0?'var(--accent)':'var(--border)',color:i===0?'var(--accent)':'var(--ink)',background:i===0?'rgba(200,242,48,.08)':'var(--surface2)'}}>{i===0&&I.check()}{x}</span>)}</div>
  <div className="field subtle" style={{height:72,alignItems:'flex-start',paddingTop:14}}>Descríbelo (color, dónde estaba)…</div>
  <div className="card" style={{marginTop:14,padding:'13px 14px',display:'flex',gap:11,alignItems:'flex-start',background:'var(--surface2)'}}><span style={{color:'var(--accent)',marginTop:1}}>{I.shield()}</span><span className="subtle" style={{fontSize:12.5,lineHeight:1.45}}>Por seguridad, tu número se mantiene oculto. VEO media el contacto.</span></div>
 </div>
 <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>{notify('Reporte enviado al conductor');back();}}>{I.phone()} Avisar al conductor</button></div><HI/></div>);

const Share=({back,notify})=>(<div className="screen"><Bar/><Header title="Compartir con familia" onBack={back}/>
 <div className="pad scroll" style={{flex:1}}>
  <div style={{position:'relative',height:150,borderRadius:18,overflow:'hidden',border:'1px solid var(--border)',marginBottom:16}}><MapCanvas mode="trip" carT={0.5}/><div style={{position:'absolute',top:12,left:12}}><span className="pill" style={{background:'var(--surface)'}}><span className="dot" style={{background:'var(--success)'}}/>EN VIVO</span></div><div style={{position:'absolute',left:0,right:0,bottom:0,padding:'24px 14px 12px',background:'linear-gradient(0deg,rgba(10,11,14,.85),transparent)',fontSize:13,fontWeight:600}}>Así verá tu familia el viaje</div></div>
  <div style={{display:'flex',flexDirection:'column',gap:2,marginBottom:14}}>{[[I.pin,'Mapa y ubicación en vivo'],[I.users,'Conductor, placa y modelo'],[I.cam,'Cámara que graba y analiza'],[I.clock,'Tiempo estimado de llegada']].map((r,k)=>(<div key={k} style={{display:'flex',alignItems:'center',gap:12,padding:'7px 0'}}><span style={{color:'var(--accent)'}}>{r[0]()}</span><span style={{fontSize:14}}>{r[1]}</span><span style={{marginLeft:'auto',color:'var(--success)'}}>{I.check()}</span></div>))}</div>
  <div className="card" style={{padding:'12px 14px',display:'flex',alignItems:'center',gap:10,background:'var(--surface2)'}}><span style={{color:'var(--accent)'}}>{I.link()}</span><span className="mono" style={{flex:1,fontSize:13}}>veo.pe/v/8F3A2D</span><div className="iconbtn" style={{width:36,height:36,borderRadius:10}} onClick={()=>notify('Link copiado')}>{I.copy()}</div></div>
  <div style={{display:'flex',gap:8,alignItems:'center',color:'var(--ink-subtle)',fontSize:12,marginTop:10,lineHeight:1.4}}><span>{I.lock()}</span>Sin app ni cuenta · solo lectura. El link caduca al terminar el viaje.</div>
 </div>
 <div className="pad" style={{paddingBottom:34}}><button className="btn btn-accent" onClick={()=>{notify('Viaje compartido');back();}}>{I.share()} Compartir enlace en vivo</button></div><HI/></div>);

const Expired=({reset})=>(<div className="screen" style={{justifyContent:'center'}}><Bar/>
 <div className="pad" style={{textAlign:'center'}}>
  <div style={{width:84,height:84,borderRadius:'50%',background:'var(--surface2)',border:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 22px',color:'var(--ink-muted)'}}>{I.lock()}</div>
  <h1 className="display" style={{fontSize:28}}>Tu sesión expiró</h1>
  <p className="muted" style={{marginTop:10,fontSize:15,lineHeight:1.5}}>Por tu seguridad cerramos la sesión tras inactividad. Vuelve a verificar tu identidad para continuar.</p>
  <button className="btn btn-accent" style={{marginTop:24}} onClick={()=>reset('auth')}>Volver a ingresar</button>
 </div><HI/></div>);

const Logout=({back,reset})=>(<div className="screen" style={{justifyContent:'flex-end',background:'var(--overlay)'}}>
 <div className="bsheet" style={{paddingTop:20}}><div className="grabber" style={{marginBottom:18}}/><h3 className="display" style={{fontSize:22,textAlign:'center'}}>¿Cerrar sesión?</h3><p className="muted" style={{textAlign:'center',fontSize:14,marginTop:8,marginBottom:20}}>Tendrás que verificar tu número la próxima vez.</p><button className="btn btn-danger" onClick={()=>reset('splash')}>Cerrar sesión</button><button className="btn btn-ghost btn-sm" style={{marginTop:6}} onClick={back}>Cancelar</button></div></div>);

const TABBAR=({cur,onTab})=>(<div className="tabbar">{[['inicio','Inicio',I.tHome],['viajes','Viajes',I.tTrips],['cuenta','Cuenta',I.tUser]].map(t=>(<div key={t[0]} className={'tab'+(cur===t[0]?' on':'')} onClick={()=>onTab(t[0])}>{t[2](cur===t[0])}<span>{t[1]}</span></div>))}</div>);

window.VEO={TABBAR,SCREENS:{splash:Splash,onboarding:Onboarding,auth:Auth,profilesetup:ProfileSetup,home:Home,notifs:Notifs,search:Search,offer:Offer,offers:Offers,counter:Counter,nooffers:NoOffers,reassign:Reassign,trip:Trip,changedest:ChangeDest,cameralive:CameraLive,cameractrl:CameraControl,chat:Chat,panic:Panic,payment:Payment,rating:Rating,profile:Profile,trusted:Trusted,childmode:ChildMode,kyc:Kyc,paymethods:PayMethods,savedplaces:SavedPlaces,scheduled:Scheduled,schedulenew:ScheduleNew,editprofile:EditProfile,access:Access,help:Help,referrals:Referrals,history:History,tripdetail:TripDetail,invoice:Invoice,lost:LostItem,share:Share,logout:Logout,expired:Expired}};
